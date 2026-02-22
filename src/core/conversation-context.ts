// SPDX-License-Identifier: MIT

import type {
	ConversationItem,
	SubagentContextSnapshot,
	SubagentTask,
	ToolCall,
	ToolResult,
} from '../types/conversation.js';
import type { MemoryFact } from '../types/memory.js';

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

	/** Return all items added since the last checkpoint (or all items if no checkpoint set). */
	getItemsSinceCheckpoint(): ConversationItem[] {
		return this._items.slice(this.checkpointIndex);
	}

	/** Advance the checkpoint cursor to the current end of the items list. */
	markCheckpoint(): void {
		this.checkpointIndex = this._items.length;
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
	): SubagentContextSnapshot {
		const recentTurns = this._items.slice(-recentTurnCount);
		return {
			task,
			conversationSummary: this._summary,
			recentTurns,
			relevantMemoryFacts: memoryFacts,
			agentInstructions,
		};
	}

	/** Format the conversation as Gemini-compatible Content array for replay after reconnection. */
	toReplayContent(): Array<{ role: string; parts: Array<{ text: string }> }> {
		const content: Array<{ role: string; parts: Array<{ text: string }> }> = [];

		if (this._summary) {
			content.push({
				role: 'user',
				parts: [{ text: `[Context summary]: ${this._summary}` }],
			});
		}

		for (const item of this._items) {
			const role = item.role === 'user' ? 'user' : 'model';
			content.push({ role, parts: [{ text: item.content }] });
		}

		return content;
	}
}
