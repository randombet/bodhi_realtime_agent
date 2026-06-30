import { describe, expect, it, vi } from 'vitest';
import { MultiplexConversationHistoryStore } from '../../src/core/multiplex-conversation-history-store.js';
import type { ConversationItem } from '../../src/types/conversation.js';
import type {
	ConversationHistoryStore,
	SessionRecord,
	SessionReport,
} from '../../src/types/history.js';

function makeStore(overrides: Partial<ConversationHistoryStore> = {}): ConversationHistoryStore {
	return {
		createSession: vi.fn(async () => {}),
		updateSession: vi.fn(async () => {}),
		addItems: vi.fn(async () => {}),
		saveSessionReport: vi.fn(async () => {}),
		getSession: vi.fn(async () => null),
		getSessionItems: vi.fn(async () => []),
		listUserSessions: vi.fn(async () => []),
		...overrides,
	};
}

const sessionRecord: SessionRecord = {
	id: 'sess_1',
	userId: 'u_1',
	initialAgentName: 'main',
	status: 'active',
	startedAt: 1_700_000_000_000,
};

const sessionReport: SessionReport = {
	...sessionRecord,
	status: 'ended',
	items: [],
	pendingToolCalls: [],
};

describe('MultiplexConversationHistoryStore', () => {
	describe('construction', () => {
		it('throws when stores array is empty', () => {
			expect(() => new MultiplexConversationHistoryStore({ stores: [] })).toThrow(
				/at least one store/,
			);
		});

		it('accepts a single store', () => {
			const a = makeStore();
			expect(() => new MultiplexConversationHistoryStore({ stores: [a] })).not.toThrow();
		});
	});

	describe('write fan-out', () => {
		it('createSession reaches every store', async () => {
			const a = makeStore();
			const b = makeStore();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			await mux.createSession(sessionRecord);

			expect(a.createSession).toHaveBeenCalledWith(sessionRecord);
			expect(b.createSession).toHaveBeenCalledWith(sessionRecord);
		});

		it('addItems reaches every store with the same items', async () => {
			const a = makeStore();
			const b = makeStore();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			const items: ConversationItem[] = [
				{ role: 'user', content: 'hi', timestamp: 100 },
				{ role: 'assistant', content: 'hello', timestamp: 200 },
			];
			await mux.addItems('sess_1', items);

			expect(a.addItems).toHaveBeenCalledWith('sess_1', items);
			expect(b.addItems).toHaveBeenCalledWith('sess_1', items);
		});

		it('saveSessionReport reaches every store', async () => {
			const a = makeStore();
			const b = makeStore();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			await mux.saveSessionReport(sessionReport);

			expect(a.saveSessionReport).toHaveBeenCalledWith(sessionReport);
			expect(b.saveSessionReport).toHaveBeenCalledWith(sessionReport);
		});

		it('updateSession reaches every store', async () => {
			const a = makeStore();
			const b = makeStore();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			await mux.updateSession('sess_1', { status: 'ended' });

			expect(a.updateSession).toHaveBeenCalledWith('sess_1', { status: 'ended' });
			expect(b.updateSession).toHaveBeenCalledWith('sess_1', { status: 'ended' });
		});
	});

	describe('failure handling', () => {
		it('one rejecting store does not block siblings', async () => {
			const a = makeStore({
				addItems: vi.fn(async () => {
					throw new Error('disk full');
				}),
			});
			const b = makeStore();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			await expect(mux.addItems('sess_1', [])).resolves.toBeUndefined();
			expect(b.addItems).toHaveBeenCalled();
		});

		it('logs each rejection with the store index and method name', async () => {
			const a = makeStore({
				addItems: vi.fn(async () => {
					throw new Error('disk full');
				}),
			});
			const b = makeStore({
				addItems: vi.fn(async () => {
					throw new Error('network down');
				}),
			});
			const log = vi.fn();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b], log });

			await mux.addItems('sess_1', []);

			expect(log).toHaveBeenCalledTimes(2);
			expect(log).toHaveBeenCalledWith(
				expect.stringMatching(/store\[0\] addItems failed: disk full/),
			);
			expect(log).toHaveBeenCalledWith(
				expect.stringMatching(/store\[1\] addItems failed: network down/),
			);
		});

		it('handles non-Error rejection reasons', async () => {
			const a = makeStore({
				addItems: vi.fn(async () => {
					throw 'string error';
				}),
			});
			const log = vi.fn();
			const mux = new MultiplexConversationHistoryStore({ stores: [a], log });

			await mux.addItems('sess_1', []);

			expect(log).toHaveBeenCalledWith(expect.stringContaining('string error'));
		});

		it('does not call log when there is no failure', async () => {
			const a = makeStore();
			const log = vi.fn();
			const mux = new MultiplexConversationHistoryStore({ stores: [a], log });

			await mux.addItems('sess_1', []);

			expect(log).not.toHaveBeenCalled();
		});

		it('silently drops failures when no log callback is provided', async () => {
			const a = makeStore({
				addItems: vi.fn(async () => {
					throw new Error('boom');
				}),
			});
			const mux = new MultiplexConversationHistoryStore({ stores: [a] });

			// Should resolve without throwing; nothing else to assert beyond no crash.
			await expect(mux.addItems('sess_1', [])).resolves.toBeUndefined();
		});
	});

	describe('read routing', () => {
		it('getSession delegates to stores[0]', async () => {
			const a = makeStore({ getSession: vi.fn(async () => sessionRecord) });
			const b = makeStore({ getSession: vi.fn(async () => null) });
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			const result = await mux.getSession('sess_1');

			expect(a.getSession).toHaveBeenCalledWith('sess_1');
			expect(b.getSession).not.toHaveBeenCalled();
			expect(result).toBe(sessionRecord);
		});

		it('getSessionItems delegates to stores[0] with options', async () => {
			const items: ConversationItem[] = [{ role: 'user', content: 'hi', timestamp: 1 }];
			const a = makeStore({ getSessionItems: vi.fn(async () => items) });
			const b = makeStore();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			const result = await mux.getSessionItems('sess_1', { limit: 10, offset: 5 });

			expect(a.getSessionItems).toHaveBeenCalledWith('sess_1', { limit: 10, offset: 5 });
			expect(b.getSessionItems).not.toHaveBeenCalled();
			expect(result).toBe(items);
		});

		it('listUserSessions delegates to stores[0]', async () => {
			const a = makeStore();
			const b = makeStore();
			const mux = new MultiplexConversationHistoryStore({ stores: [a, b] });

			await mux.listUserSessions('u_1');

			expect(a.listUserSessions).toHaveBeenCalledWith('u_1', undefined);
			expect(b.listUserSessions).not.toHaveBeenCalled();
		});

		it('read failures from stores[0] propagate (not swallowed)', async () => {
			const a = makeStore({
				getSession: vi.fn(async () => {
					throw new Error('read error');
				}),
			});
			const mux = new MultiplexConversationHistoryStore({ stores: [a] });

			await expect(mux.getSession('sess_1')).rejects.toThrow('read error');
		});
	});
});
