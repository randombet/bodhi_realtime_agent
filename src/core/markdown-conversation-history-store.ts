// SPDX-License-Identifier: MIT

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { ConversationItem, ToolCall, ToolResult } from '../types/conversation.js';
import type {
	ConversationHistoryStore,
	PaginationOptions,
	SessionRecord,
	SessionReport,
	SessionSummary,
} from '../types/history.js';
import {
	type RenderItemState,
	renderFooter,
	renderFrontmatter,
	renderItem,
	renderOrphanToolCall,
	renderOrphanToolResult,
	renderToolCallPair,
} from './markdown-history-formatter.js';

/** Options for {@link MarkdownConversationHistoryStore}. */
export interface MarkdownConversationHistoryStoreOptions {
	/** Directory where `{sessionId}.md` files live. Created on first `createSession`. */
	baseDir: string;
	/** Optional model name embedded in the YAML frontmatter. */
	modelName?: string;
	/**
	 * Called when a write operation fails (mkdir, atomic rename, appendFile).
	 *
	 * Public markdown write methods log + swallow failures because the
	 * `ConversationHistoryWriter` fire-and-forgets store calls — rejecting
	 * promises here would surface as unhandled rejections. Wire this
	 * callback to your logger (e.g. `console.error` or a structured logger).
	 */
	log?: (msg: string) => void;
}

/** Per-session in-memory state, cleared on `saveSessionReport`. */
interface SessionRenderState {
	initialAgent: string;
	activeAgent: string;
	pendingToolCalls: Map<string, ToolCall>;
	agentsSeen: string[];
}

/** Replace anything that isn't safe in a filesystem path segment. */
function safeSegment(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Try to parse a JSON-stringified ToolCall content; return null on failure. */
function parseToolCall(content: string): ToolCall | null {
	try {
		const parsed = JSON.parse(content) as ToolCall;
		if (parsed && typeof parsed === 'object' && typeof parsed.toolCallId === 'string') {
			return parsed;
		}
	} catch {
		// fall through
	}
	return null;
}

/** Try to parse a JSON-stringified ToolResult content; return null on failure. */
function parseToolResult(content: string): ToolResult | null {
	try {
		const parsed = JSON.parse(content) as ToolResult;
		if (parsed && typeof parsed === 'object' && typeof parsed.toolCallId === 'string') {
			return parsed;
		}
	} catch {
		// fall through
	}
	return null;
}

/**
 * WhatsApp-style markdown chat-log writer. Implements
 * `ConversationHistoryStore` for transparent integration with
 * `ConversationHistoryWriter`, but is **write-only**: read methods throw.
 *
 * See `dev_docs/framework/design-markdown-conversation-history-store.md`
 * for the format spec, lifecycle, and design rationale.
 */
export class MarkdownConversationHistoryStore implements ConversationHistoryStore {
	private readonly opts: MarkdownConversationHistoryStoreOptions;
	private readonly state = new Map<string, SessionRenderState>();
	private readonly queues = new Map<string, Promise<void>>();

	constructor(opts: MarkdownConversationHistoryStoreOptions) {
		this.opts = opts;
	}

	private filePath(sessionId: string): string {
		return join(this.opts.baseDir, `${safeSegment(sessionId)}.md`);
	}

	/**
	 * Serialize work for one session. Each public method routes its IO
	 * through here so `createSession` → `addItems` → `saveSessionReport`
	 * land in order on disk regardless of whether the writer awaits.
	 *
	 * The chain advances on either success or failure; per-call rejections
	 * propagate to the returned promise, but {@link enqueueAndSwallow}
	 * wraps it so public methods can resolve.
	 */
	private enqueue<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
		const prior = this.queues.get(sessionId) ?? Promise.resolve();
		const result = prior.then(
			() => work(),
			() => work(),
		);
		this.queues.set(
			sessionId,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	/**
	 * Enqueue + log + resolve. Used by every public write method so the
	 * writer's fire-and-forget contract never produces unhandled rejections.
	 */
	private async enqueueAndSwallow(
		sessionId: string,
		method: string,
		work: () => Promise<void>,
	): Promise<void> {
		try {
			await this.enqueue(sessionId, work);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.opts.log?.(
				`MarkdownConversationHistoryStore: ${method}(${sessionId}) failed: ${reason}`,
			);
		}
	}

	async createSession(record: SessionRecord): Promise<void> {
		await this.enqueueAndSwallow(record.id, 'createSession', async () => {
			await mkdir(this.opts.baseDir, { recursive: true });
			const prelude = renderFrontmatter(record, { modelName: this.opts.modelName });
			await writeFileAtomic(this.filePath(record.id), prelude);
			this.state.set(record.id, {
				initialAgent: record.initialAgentName,
				activeAgent: record.initialAgentName,
				pendingToolCalls: new Map(),
				agentsSeen: [record.initialAgentName],
			});
		});
	}

	async updateSession(_sessionId: string, _update: Partial<SessionRecord>): Promise<void> {
		// No-op for v1: frontmatter is one-shot; rewriting an actively-appended
		// file is racy. Final agent / status surface in saveSessionReport's footer.
	}

	async addItems(sessionId: string, items: ConversationItem[]): Promise<void> {
		await this.enqueueAndSwallow(sessionId, 'addItems', async () => {
			const state = this.state.get(sessionId);
			if (!state) return; // createSession was never called for this session.
			let body = '';
			for (const item of items) {
				body += this.renderForState(item, state);
			}
			if (body.length > 0) {
				await appendFile(this.filePath(sessionId), body);
			}
		});
	}

	async saveSessionReport(report: SessionReport): Promise<void> {
		await this.enqueueAndSwallow(report.id, 'saveSessionReport', async () => {
			const state = this.state.get(report.id);
			let body = '';
			// Flush any orphan tool_calls that never received a matching result.
			if (state) {
				for (const call of state.pendingToolCalls.values()) {
					body += renderOrphanToolCall(call);
				}
			}
			const agentsSeen = state?.agentsSeen ?? [report.initialAgentName];
			const endTimeMs = report.endedAt ?? Date.now();
			body += renderFooter(report, agentsSeen, endTimeMs);
			await appendFile(this.filePath(report.id), body);
			this.state.delete(report.id);
			this.queues.delete(report.id);
		});
	}

	getSession(_sessionId: string): Promise<SessionRecord | null> {
		throw new Error(
			'MarkdownConversationHistoryStore is write-only — configure another ConversationHistoryStore for queries.',
		);
	}

	getSessionItems(_sessionId: string, _options?: PaginationOptions): Promise<ConversationItem[]> {
		throw new Error(
			'MarkdownConversationHistoryStore is write-only — configure another ConversationHistoryStore for queries.',
		);
	}

	listUserSessions(_userId: string, _options?: PaginationOptions): Promise<SessionSummary[]> {
		throw new Error(
			'MarkdownConversationHistoryStore is write-only — configure another ConversationHistoryStore for queries.',
		);
	}

	/** Internal: render one item, updating per-session state for transfers and tool pairing. */
	private renderForState(item: ConversationItem, state: SessionRenderState): string {
		// tool_call: buffer until matching tool_result.
		if (item.role === 'tool_call') {
			const call = parseToolCall(item.content);
			if (call) {
				state.pendingToolCalls.set(call.toolCallId, call);
			}
			return '';
		}
		// tool_result: pair with buffered call, or render orphan.
		if (item.role === 'tool_result') {
			const result = parseToolResult(item.content);
			if (!result) return '';
			const call = state.pendingToolCalls.get(result.toolCallId);
			if (call) {
				state.pendingToolCalls.delete(result.toolCallId);
				return renderToolCallPair(call, result);
			}
			return renderOrphanToolResult(result);
		}
		// transfer: update active agent + agentsSeen.
		if (item.role === 'transfer') {
			const match = item.content.match(/^Transfer:\s*(.+?)\s*→\s*(.+)$/);
			if (match) {
				const toAgent = match[2].trim();
				state.activeAgent = toAgent;
				if (!state.agentsSeen.includes(toAgent)) {
					state.agentsSeen.push(toAgent);
				}
			}
			const renderState: RenderItemState = {
				initialAgent: state.initialAgent,
				activeAgent: state.activeAgent,
			};
			return renderItem(item, renderState);
		}
		// user / assistant / summary-via-metadata.
		const renderState: RenderItemState = {
			initialAgent: state.initialAgent,
			activeAgent: state.activeAgent,
		};
		return renderItem(item, renderState);
	}
}
