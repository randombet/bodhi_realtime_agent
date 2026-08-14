import type { ConversationItem } from '../types/conversation.js';
import type {
	ConversationHistoryStore,
	SessionAnalytics,
	SessionRecord,
} from '../types/history.js';
import type { ConversationContext } from './conversation-context.js';
import type { IEventBus } from './event-bus.js';

/** Resume options (see design-composer-resume-history.md §2). Absent → plain new session. */
export interface HistoryWriterResumeOptions {
	/** `'copy'` (default): re-flush prior items into a fresh record via `createSession`.
	 *  `'attach'`: append to the prior record via `ensureSession` + `reactivateSession`. */
	historyResumeMode?: 'copy' | 'attach';
	/** Prior aggregate stats (source `SessionRecord.analytics`) — seeds the close report so it
	 *  reflects the full record (incl. `totalTokens`, which items cannot reconstruct). */
	initialAnalytics?: SessionAnalytics;
	/** Number of prior items loaded into the context before the session ran. In `copy` mode these
	 *  re-flush (checkpoint 0) but must NOT be re-counted on top of `initialAnalytics`, so the
	 *  analytics counter skips exactly this many leading items. */
	initialItemCount?: number;
}

/**
 * EventBus-driven writer that persists conversation items to a ConversationHistoryStore.
 *
 * Subscribes to session lifecycle events and flushes incremental batches of conversation
 * items (since the last checkpoint) to the store. Tracks session analytics counters
 * and writes a final SessionReport on session close.
 *
 * **Ordered persistence:** store writes run through a serial queue (start → flushes → close in
 * order). `drain()` awaits the queue — `VoiceSession.start()` awaits it after the start-phase
 * (so a resumed record reads `active` before start resolves) and `VoiceSession.close()` awaits it
 * before tearing down the event bus (so the final report always lands).
 *
 * Call `dispose()` to unsubscribe from all events.
 */
export class ConversationHistoryWriter {
	private unsubscribers: Array<() => void> = [];
	private analytics: SessionAnalytics;
	private readonly mode: 'copy' | 'attach';
	/** Leading items to skip when counting analytics (the prior items already in `initialAnalytics`,
	 *  which re-flush in `copy` mode). `attach` never re-flushes prior items, so it skips none. */
	private analyticsSkipRemaining: number;
	/** Original record start time — the createSession time (copy) or the prior record's `startedAt`
	 *  from `ensureSession` (attach). Used for the close report's `startedAt`/`durationMs`. */
	private recordStartedAt = 0;
	/** Metadata written on close — for `attach`, existing record metadata merged under the new. */
	private mergedMetadata?: Record<string, unknown>;
	/** Serial persistence queue tail; every store write chains here to preserve order. */
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private sessionId: string,
		private userId: string,
		private initialAgentName: string,
		private eventBus: IEventBus,
		private conversationContext: ConversationContext,
		private store: ConversationHistoryStore,
		private sessionMetadata?: Record<string, unknown>,
		resume?: HistoryWriterResumeOptions,
	) {
		this.mode = resume?.historyResumeMode ?? 'copy';
		this.analytics = resume?.initialAnalytics
			? { ...resume.initialAnalytics }
			: {
					turnCount: 0,
					userMessageCount: 0,
					assistantMessageCount: 0,
					toolCallCount: 0,
					agentTransferCount: 0,
				};
		this.mergedMetadata = this.sessionMetadata;
		// Skip re-counting the prior items ONLY when they are already reflected in a seeded
		// `initialAnalytics` (else we'd double-count). Without seeded analytics, `copy` re-flushes
		// the prior items into the fresh record, so count them so the derived counts match the
		// full transcript. `attach` never re-flushes prior items, so it skips none either way.
		this.analyticsSkipRemaining =
			this.mode === 'copy' && resume?.initialAnalytics ? (resume?.initialItemCount ?? 0) : 0;
		this.subscribe();
	}

	private subscribe(): void {
		this.unsubscribers.push(
			this.eventBus.subscribe('session.start', (payload) => {
				if (payload.sessionId !== this.sessionId) return;
				this.handleSessionStart(payload.agentName);
			}),
			this.eventBus.subscribe('turn.end', (payload) => {
				if (payload.sessionId !== this.sessionId) return;
				this.handleTurnEnd();
			}),
			this.eventBus.subscribe('agent.transfer', (payload) => {
				if (payload.sessionId !== this.sessionId) return;
				// The transfer item was already appended to the context (AgentRouter.transfer) before
				// this event fired, so flush() persists it and updateAnalytics() counts it — see there.
				// (Counting here too would double-count; counting only in updateAnalytics keeps
				// agentTransferCount item-derived, so resumed prior transfers are counted as well.)
				this.flush();
			}),
			this.eventBus.subscribe('session.close', (payload) => {
				if (payload.sessionId !== this.sessionId) return;
				this.handleSessionClose(payload.reason);
			}),
		);
	}

	dispose(): void {
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
	}

	/** Await all queued store writes (start-phase, flushes, close report). Never rejects. */
	async drain(): Promise<void> {
		await this.tail.catch(() => {});
	}

	/** Chain `fn` onto the serial queue so store writes complete in enqueue order. */
	private enqueue(label: string, fn: () => Promise<void>): void {
		const run = (): Promise<void> =>
			fn().catch((err) => {
				const reason = err instanceof Error ? err.message : String(err);
				console.error(`[ConversationHistoryWriter] ${label} failed: ${reason}`);
			});
		this.tail = this.tail.then(run, run);
	}

	private handleSessionStart(agentName: string): void {
		const record: SessionRecord = {
			id: this.sessionId,
			userId: this.userId,
			initialAgentName: agentName,
			status: 'active',
			startedAt: Date.now(),
			metadata: this.sessionMetadata,
		};
		const ensureSession = this.store.ensureSession?.bind(this.store);
		const reactivateSession = this.store.reactivateSession?.bind(this.store);
		if (this.mode === 'attach' && ensureSession && reactivateSession) {
			this.recordStartedAt = record.startedAt; // provisional; refined from the returned record
			this.enqueue('ensureSession', async () => {
				const existing = await ensureSession(record);
				this.recordStartedAt = existing.startedAt ?? record.startedAt;
				this.mergedMetadata = { ...(existing.metadata ?? {}), ...(this.sessionMetadata ?? {}) };
				await reactivateSession(this.sessionId);
			});
		} else if (this.mode === 'attach') {
			// Store cannot attach non-destructively. Do NOT call createSession — it may reset the
			// prior record's items, the exact thing `attach` exists to avoid. Skip the start-phase
			// persistence (a misconfiguration: attach requires ensureSession/reactivateSession).
			this.recordStartedAt = record.startedAt;
			console.error(
				'[ConversationHistoryWriter] historyResumeMode "attach" requires a store with ensureSession/reactivateSession; skipping start-phase creation to avoid wiping prior items',
			);
		} else {
			this.recordStartedAt = record.startedAt;
			this.enqueue('createSession', async () => {
				await this.store.createSession(record);
			});
		}
	}

	private handleTurnEnd(): void {
		this.analytics.turnCount++;
		this.flush();
	}

	private handleSessionClose(reason: string): void {
		this.flush();

		const items = [...this.conversationContext.items];
		const endedAt = Date.now();
		const analyticsSnapshot = { ...this.analytics };
		this.enqueue('saveSessionReport', async () => {
			// Read startedAt/metadata HERE (not at close time): the start-phase (createSession /
			// ensureSession+reactivateSession) ran earlier in this serial queue and set them.
			const startedAt = this.recordStartedAt || endedAt;
			await this.store.saveSessionReport({
				id: this.sessionId,
				userId: this.userId,
				initialAgentName: this.initialAgentName,
				status: 'ended',
				startedAt,
				endedAt,
				durationMs: Math.max(0, endedAt - startedAt),
				disconnectReason: this.mapReason(reason),
				analytics: analyticsSnapshot,
				metadata: this.mergedMetadata,
				items,
				pendingToolCalls: [],
			});
		});
		this.enqueue('dispose', async () => {
			this.dispose();
		});
	}

	private flush(): void {
		const items = this.conversationContext.getItemsSinceCheckpoint();
		if (items.length === 0) return;

		this.updateAnalytics(items);
		this.conversationContext.markCheckpoint();
		this.enqueue('addItems', async () => {
			await this.store.addItems(this.sessionId, items);
		});
	}

	private updateAnalytics(items: readonly ConversationItem[]): void {
		for (const item of items) {
			// Skip the leading prior items (copy-mode resume) — they are already in `initialAnalytics`.
			if (this.analyticsSkipRemaining > 0) {
				this.analyticsSkipRemaining--;
				continue;
			}
			if (item.role === 'user') this.analytics.userMessageCount++;
			else if (item.role === 'assistant') this.analytics.assistantMessageCount++;
			else if (item.role === 'tool_call') this.analytics.toolCallCount++;
			else if (item.role === 'transfer') this.analytics.agentTransferCount++;
		}
	}

	private mapReason(
		reason: string,
	): 'user_hangup' | 'error' | 'timeout' | 'go_away' | 'transfer' | undefined {
		const map: Record<string, 'user_hangup' | 'error' | 'timeout' | 'go_away' | 'transfer'> = {
			user_hangup: 'user_hangup',
			error: 'error',
			timeout: 'timeout',
			go_away: 'go_away',
			transfer: 'transfer',
		};
		return map[reason];
	}
}
