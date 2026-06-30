import type { ConversationItem } from '../types/conversation.js';
import type {
	ConversationHistoryStore,
	PaginationOptions,
	SessionRecord,
	SessionReport,
	SessionSummary,
} from '../types/history.js';

/** Options for {@link MultiplexConversationHistoryStore}. */
export interface MultiplexConversationHistoryStoreOptions {
	/** Backing stores. Writes fan out to all; reads delegate to `stores[0]`. */
	stores: ConversationHistoryStore[];
	/**
	 * Called for every `Promise.allSettled` rejection produced by a backing
	 * store. Without this, persistence failures are silently dropped — the
	 * `ConversationHistoryWriter` does not observe store rejections.
	 *
	 * Note: stores that intentionally swallow their own write failures (e.g.
	 * `MarkdownConversationHistoryStore`) resolve their public methods even on
	 * IO errors, so those failures do not surface here. Wire `log` on the
	 * backing store too.
	 */
	log?: (msg: string) => void;
}

/**
 * Fans `ConversationHistoryStore` writes out to multiple backing stores via
 * `Promise.allSettled` and delegates reads to the first store.
 *
 * Configuration order matters: put the queryable store first if your app
 * reads from history. Backing-store rejections are surfaced via `opts.log`.
 */
export class MultiplexConversationHistoryStore implements ConversationHistoryStore {
	constructor(private readonly opts: MultiplexConversationHistoryStoreOptions) {
		if (opts.stores.length === 0) {
			throw new Error('MultiplexConversationHistoryStore requires at least one store');
		}
	}

	private async fanOut(
		method: string,
		fn: (s: ConversationHistoryStore) => Promise<void>,
	): Promise<void> {
		const results = await Promise.allSettled(this.opts.stores.map(fn));
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.status === 'rejected') {
				const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
				this.opts.log?.(
					`MultiplexConversationHistoryStore: store[${i}] ${method} failed: ${reason}`,
				);
			}
		}
	}

	async createSession(session: SessionRecord): Promise<void> {
		await this.fanOut('createSession', (s) => s.createSession(session));
	}

	async updateSession(sessionId: string, update: Partial<SessionRecord>): Promise<void> {
		await this.fanOut('updateSession', (s) => s.updateSession(sessionId, update));
	}

	async addItems(sessionId: string, items: ConversationItem[]): Promise<void> {
		await this.fanOut('addItems', (s) => s.addItems(sessionId, items));
	}

	async saveSessionReport(report: SessionReport): Promise<void> {
		await this.fanOut('saveSessionReport', (s) => s.saveSessionReport(report));
	}

	getSession(sessionId: string): Promise<SessionRecord | null> {
		return this.opts.stores[0].getSession(sessionId);
	}

	getSessionItems(sessionId: string, options?: PaginationOptions): Promise<ConversationItem[]> {
		return this.opts.stores[0].getSessionItems(sessionId, options);
	}

	listUserSessions(userId: string, options?: PaginationOptions): Promise<SessionSummary[]> {
		return this.opts.stores[0].listUserSessions(userId, options);
	}
}
