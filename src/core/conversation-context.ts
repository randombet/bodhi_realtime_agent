import type {
	ConversationItem,
	SubagentContextSnapshot,
	SubagentTask,
	ToolCall,
	ToolResult,
} from '../types/conversation.js';
import type { MemoryFact } from '../types/memory.js';
import type { ReplayItem } from '../types/transport.js';

/**
 * In-memory conversation timeline that tracks all messages, tool calls, and agent transfers.
 *
 * Key concepts:
 * - **Items**: Append-only list of ConversationItems (user messages, assistant messages, tool events, transfers).
 * - **Checkpoint**: A cursor into the items list. `getItemsSinceCheckpoint()` returns only new items since the last checkpoint.
 *   Used by ConversationHistoryWriter and MemoryDistiller to process incremental batches.
 * - **Summary**: A compressed representation of older conversation turns. When set via `setSummary()`,
 *   items before the checkpoint are evicted (they're captured in the summary).
 * - **Token estimate**: Rough heuristic (`content.length / 4`) used to decide when to trigger summarization.
 */
export class ConversationContext {
	private _items: ConversationItem[] = [];
	private _summary: string | null = null;
	private checkpointIndex = 0;
	/** Ids of reserved user messages still awaiting their authoritative transcript. */
	private pendingIds = new Set<string>();
	private nextReservationId = 1;

	get items(): readonly ConversationItem[] {
		return this._items;
	}

	get summary(): string | null {
		return this._summary;
	}

	/** Rough token count estimate for all items + summary (content.length / 4). */
	get tokenEstimate(): number {
		let total = 0;
		for (const item of this._items) {
			total += item.content.length / 4;
		}
		if (this._summary) {
			total += this._summary.length / 4;
		}
		return Math.ceil(total);
	}

	addUserMessage(content: string): void {
		this._items.push({ role: 'user', content, timestamp: Date.now() });
	}

	/**
	 * Append a user message whose authoritative transcript has not arrived yet.
	 *
	 * The slot is inserted in timeline order immediately (so replay and history
	 * keep correct interleaving with assistant/tool items) but holds only
	 * provisional text. Until `sealUserMessage` resolves it, the slot acts as a
	 * barrier in `getItemsSinceCheckpoint()` — history stores never observe the
	 * provisional text, so a persisted record is written once, already correct.
	 * `toReplayContent()` is unaffected and always reads the current best text.
	 *
	 * @returns The id to pass to `sealUserMessage`.
	 */
	reserveUserMessage(provisionalContent: string): string {
		const id = `u${this.nextReservationId++}`;
		this._items.push({ role: 'user', content: provisionalContent, timestamp: Date.now(), id });
		this.pendingIds.add(id);
		return id;
	}

	/**
	 * Resolve a reserved user message and release the flush barrier.
	 *
	 * @param finalContent Authoritative transcript. Omit (or pass empty) to seal
	 *        with the provisional text already in the slot — the fallback used
	 *        when the authoritative source fails or times out.
	 * @returns false if the id is unknown or already sealed.
	 */
	sealUserMessage(id: string, finalContent?: string): boolean {
		if (!this.pendingIds.has(id)) return false;
		if (finalContent?.trim()) {
			const item = this._items.find((i) => i.id === id);
			if (item) item.content = finalContent.trim();
		}
		this.pendingIds.delete(id);
		return true;
	}

	/** True while any reserved user message is still awaiting its transcript. */
	get hasPendingUserMessages(): boolean {
		return this.pendingIds.size > 0;
	}

	/** Ids of all still-unsealed reservations, oldest first. */
	pendingUserMessageIds(): string[] {
		return this._items.filter((i) => i.id && this.pendingIds.has(i.id)).map((i) => i.id as string);
	}

	/**
	 * Index of the first still-pending user message, or `_items.length` when
	 * none is pending. Items at or after this index must not be flushed to a
	 * history store yet — their text may still change.
	 */
	private flushBarrier(): number {
		if (this.pendingIds.size === 0) return this._items.length;
		const idx = this._items.findIndex((i) => i.id !== undefined && this.pendingIds.has(i.id));
		return idx === -1 ? this._items.length : idx;
	}

	addAssistantMessage(content: string): void {
		this._items.push({ role: 'assistant', content, timestamp: Date.now() });
	}

	addToolCall(call: ToolCall): void {
		this._items.push({
			role: 'tool_call',
			content: JSON.stringify(call),
			timestamp: Date.now(),
		});
	}

	addToolResult(result: ToolResult): void {
		this._items.push({
			role: 'tool_result',
			content: JSON.stringify(result),
			timestamp: Date.now(),
		});
	}

	addAgentTransfer(fromAgent: string, toAgent: string): void {
		this._items.push({
			role: 'transfer',
			content: `Transfer: ${fromAgent} → ${toAgent}`,
			timestamp: Date.now(),
		});
	}

	/**
	 * Return items added since the last checkpoint, stopping before the first
	 * still-pending user message (see `reserveUserMessage`) so provisional text
	 * is never handed to a history store.
	 */
	getItemsSinceCheckpoint(): ConversationItem[] {
		const barrier = Math.max(this.checkpointIndex, this.flushBarrier());
		return this._items.slice(this.checkpointIndex, barrier);
	}

	/** Advance the checkpoint cursor past everything `getItemsSinceCheckpoint`
	 *  just returned — i.e. up to, but not past, the first pending user message. */
	markCheckpoint(): void {
		this.checkpointIndex = Math.max(this.checkpointIndex, this.flushBarrier());
	}

	/**
	 * Load existing items (e.g. when resuming from persisted history).
	 * Appends to the timeline. By default (and with `alreadyPersisted: true`) advances the
	 * checkpoint so these items are **not** re-flushed by ConversationHistoryWriter — appropriate
	 * when they already live in the store (e.g. `attach`-mode resume). Pass
	 * `{ alreadyPersisted: false }` to leave the checkpoint in place so the writer re-persists the
	 * loaded items into a fresh record (`copy`-mode resume).
	 */
	loadItems(items: ConversationItem[], opts?: { alreadyPersisted?: boolean }): void {
		for (const item of items) {
			this._items.push(item);
		}
		if (opts?.alreadyPersisted !== false) {
			this.checkpointIndex = this._items.length;
		}
	}

	/**
	 * Drop every item and start the timeline over: the checkpoint returns to 0
	 * and all pending reservations are forgotten, so the next item added is the
	 * first one `getItemsSinceCheckpoint()` returns. The summary is kept.
	 * Persist anything still unflushed before calling this; it discards items
	 * whether or not a history store has seen them.
	 *
	 * @returns The number of items removed.
	 */
	clear(): number {
		const removed = this._items.length;
		this._items = [];
		this.checkpointIndex = 0;
		this.pendingIds.clear();
		return removed;
	}

	/** Store a compressed summary and evict all items before the current checkpoint. */
	setSummary(summary: string): void {
		this._summary = summary;
		// Evict items before checkpoint — they're now captured in the summary
		this._items = this._items.slice(this.checkpointIndex);
		this.checkpointIndex = 0;
	}

	/** Build a snapshot of conversation state for a subagent (summary + recent turns + memory). */
	getSubagentContext(
		task: SubagentTask,
		agentInstructions: string,
		memoryFacts: MemoryFact[],
		recentTurnCount = 10,
		knowledgeBaseContext?: string,
	): SubagentContextSnapshot {
		const recentTurns = this._items.slice(-recentTurnCount);
		return {
			task,
			conversationSummary: this._summary,
			recentTurns,
			relevantMemoryFacts: memoryFacts,
			agentInstructions,
			...(knowledgeBaseContext ? { knowledgeBaseContext } : {}),
		};
	}

	/**
	 * Format the conversation as provider-neutral ReplayItem[] for replay (reconnect recovery or
	 * resume). A malformed tool row (unparseable JSON, or missing `toolCallId`/`toolName`) is
	 * **dropped and logged** (metadata-only — never the row's content) rather than demoted to
	 * assistant text, so the emitted list enforces the same validity the transport replay expects.
	 * Errored tool results carry their `error` string through.
	 */
	toReplayContent(opts?: { log?: (msg: string) => void }): ReplayItem[] {
		const log = opts?.log;
		const items: ReplayItem[] = [];

		if (this._summary) {
			items.push({ type: 'text', role: 'user', text: `[Context summary]: ${this._summary}` });
		}

		for (const item of this._items) {
			if (item.role === 'tool_call') {
				try {
					const parsed = JSON.parse(item.content);
					// Only a *missing* args defaults to {}; an explicit non-object (incl. null) fails the
					// check below and is dropped — matching the transport's replay validator exactly.
					const args = parsed.args === undefined ? {} : parsed.args;
					if (
						typeof parsed.toolCallId === 'string' &&
						typeof parsed.toolName === 'string' &&
						typeof args === 'object' &&
						args !== null
					) {
						items.push({ type: 'tool_call', id: parsed.toolCallId, name: parsed.toolName, args });
					} else {
						log?.(
							'[ConversationContext] toReplayContent: dropped malformed tool_call row (bad id/name/args)',
						);
					}
				} catch {
					log?.('[ConversationContext] toReplayContent: dropped unparseable tool_call row');
				}
			} else if (item.role === 'tool_result') {
				try {
					const parsed = JSON.parse(item.content);
					if (typeof parsed.toolCallId === 'string' && typeof parsed.toolName === 'string') {
						items.push({
							type: 'tool_result',
							id: parsed.toolCallId,
							name: parsed.toolName,
							result: parsed.result,
							...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
						});
					} else {
						log?.(
							'[ConversationContext] toReplayContent: dropped malformed tool_result row (missing id/name)',
						);
					}
				} catch {
					log?.('[ConversationContext] toReplayContent: dropped unparseable tool_result row');
				}
			} else if (item.role === 'transfer') {
				const match = item.content.match(/Transfer:\s*(.+?)\s*→\s*(.+)/);
				if (match) {
					items.push({ type: 'transfer', fromAgent: match[1], toAgent: match[2] });
				} else {
					items.push({ type: 'text', role: 'assistant', text: item.content });
				}
			} else {
				const role = item.role === 'user' ? 'user' : 'assistant';
				items.push({ type: 'text', role, text: item.content });
			}
		}

		return items;
	}
}
