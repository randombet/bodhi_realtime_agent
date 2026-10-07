import { describe, expect, it, vi } from 'vitest';
import { ConversationContext } from '../../src/core/conversation-context.js';
import { ConversationHistoryWriter } from '../../src/core/conversation-history-writer.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { ConversationHistoryStore, SessionRecord } from '../../src/types/history.js';

function createMockStore(): ConversationHistoryStore & {
	createSession: ReturnType<typeof vi.fn>;
	ensureSession: ReturnType<typeof vi.fn>;
	reactivateSession: ReturnType<typeof vi.fn>;
	updateSession: ReturnType<typeof vi.fn>;
	addItems: ReturnType<typeof vi.fn>;
	saveSessionReport: ReturnType<typeof vi.fn>;
	getSession: ReturnType<typeof vi.fn>;
	getSessionItems: ReturnType<typeof vi.fn>;
	listUserSessions: ReturnType<typeof vi.fn>;
} {
	const record: SessionRecord = {
		id: 'sess_1',
		userId: 'user_1',
		initialAgentName: 'echo',
		status: 'ended',
		startedAt: 500,
		metadata: { priorKey: 'priorValue' },
	};
	return {
		createSession: vi.fn(async () => {}),
		ensureSession: vi.fn(async () => record),
		reactivateSession: vi.fn(async () => {}),
		updateSession: vi.fn(async () => {}),
		addItems: vi.fn(async () => {}),
		saveSessionReport: vi.fn(async () => {}),
		getSession: vi.fn(async () => null),
		getSessionItems: vi.fn(async () => []),
		listUserSessions: vi.fn(async () => []),
	};
}

describe('ConversationHistoryWriter', () => {
	it('creates session on session.start', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		eventBus.publish('session.start', { sessionId: 'sess_1', userId: 'user_1', agentName: 'echo' });
		await writer.drain();

		expect(store.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'sess_1',
				userId: 'user_1',
				initialAgentName: 'echo',
				status: 'active',
			}),
		);
	});

	it('flushes items on turn.end', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		convCtx.addUserMessage('Hello');
		convCtx.addAssistantMessage('Hi there');

		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });
		await writer.drain();

		expect(store.addItems).toHaveBeenCalledOnce();
		expect(store.addItems).toHaveBeenCalledWith(
			'sess_1',
			expect.arrayContaining([
				expect.objectContaining({ role: 'user', content: 'Hello' }),
				expect.objectContaining({ role: 'assistant', content: 'Hi there' }),
			]),
		);
	});

	it('advances checkpoint so no duplicates on next flush', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		convCtx.addUserMessage('First');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });

		convCtx.addUserMessage('Second');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_2' });
		await writer.drain();

		const secondCall = store.addItems.mock.calls[1];
		expect(secondCall[1]).toHaveLength(1);
		expect(secondCall[1][0].content).toBe('Second');
	});

	it('does not flush when no new items', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });
		await writer.drain();

		expect(store.addItems).not.toHaveBeenCalled();
	});

	it('flushes on agent.transfer', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		convCtx.addUserMessage('Transfer me');

		eventBus.publish('agent.transfer', {
			sessionId: 'sess_1',
			fromAgent: 'echo',
			toAgent: 'booking',
		});
		await writer.drain();

		expect(store.addItems).toHaveBeenCalledOnce();
	});

	it('saves session report on session.close', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		convCtx.addUserMessage('Goodbye');

		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'user_hangup' });
		await writer.drain();

		expect(store.saveSessionReport).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'sess_1', status: 'ended', disconnectReason: 'user_hangup' }),
		);
	});

	it('tracks analytics across turns', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		convCtx.addUserMessage('Q1');
		convCtx.addAssistantMessage('A1');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });

		convCtx.addUserMessage('Q2');
		convCtx.addAssistantMessage('A2');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_2' });

		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'normal' });
		await writer.drain();

		const report = store.saveSessionReport.mock.calls[0][0];
		expect(report.analytics.turnCount).toBe(2);
		expect(report.analytics.userMessageCount).toBe(2);
		expect(report.analytics.assistantMessageCount).toBe(2);
	});

	it('ignores events from other sessions', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		convCtx.addUserMessage('Hello');
		eventBus.publish('turn.end', { sessionId: 'sess_other', turnId: 'turn_1' });
		await writer.drain();

		expect(store.addItems).not.toHaveBeenCalled();
	});

	it('dispose unsubscribes from events', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		writer.dispose();

		convCtx.addUserMessage('After dispose');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });
		await writer.drain();

		expect(store.addItems).not.toHaveBeenCalled();
	});

	// --- E5: resume-aware persistence ---------------------------------------------------------

	it('copy mode (default): createSession, and analytics seeded from initialAnalytics without double-count', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();
		// Two prior items already loaded (copy re-flushes them, but must not re-count them).
		convCtx.loadItems(
			[
				{ role: 'user', content: 'prior q', timestamp: 1 },
				{ role: 'assistant', content: 'prior a', timestamp: 2 },
			],
			{ alreadyPersisted: false },
		);
		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
			undefined,
			{
				historyResumeMode: 'copy',
				initialItemCount: 2,
				initialAnalytics: {
					turnCount: 3,
					userMessageCount: 1,
					assistantMessageCount: 1,
					toolCallCount: 0,
					agentTransferCount: 0,
					totalTokens: 100,
				},
			},
		);

		eventBus.publish('session.start', { sessionId: 'sess_1', userId: 'user_1', agentName: 'echo' });
		// one new turn
		convCtx.addUserMessage('new q');
		convCtx.addAssistantMessage('new a');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 't' });
		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'normal' });
		await writer.drain();

		expect(store.createSession).toHaveBeenCalled();
		expect(store.ensureSession).not.toHaveBeenCalled();
		const report = store.saveSessionReport.mock.calls[0][0];
		// prior counts preserved (seeded) + only the NEW user/assistant counted (+1 each)
		expect(report.analytics.userMessageCount).toBe(2);
		expect(report.analytics.assistantMessageCount).toBe(2);
		expect(report.analytics.totalTokens).toBe(100); // carried from initialAnalytics
	});

	it('attach mode: ensureSession + reactivateSession (not createSession); startedAt + metadata from prior record', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore(); // ensureSession returns record with startedAt 500, metadata {priorKey}
		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
			{ resumedFromSessionId: 'sess_0' },
			{ historyResumeMode: 'attach', initialItemCount: 0 },
		);

		eventBus.publish('session.start', { sessionId: 'sess_1', userId: 'user_1', agentName: 'echo' });
		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'normal' });
		await writer.drain();

		expect(store.ensureSession).toHaveBeenCalled();
		expect(store.reactivateSession).toHaveBeenCalledWith('sess_1');
		expect(store.createSession).not.toHaveBeenCalled();
		const report = store.saveSessionReport.mock.calls[0][0];
		expect(report.startedAt).toBe(500); // preserved from the prior record
		expect(report.metadata).toEqual({ priorKey: 'priorValue', resumedFromSessionId: 'sess_0' }); // merged
	});

	it('copy mode WITHOUT initialAnalytics counts the re-flushed prior items (full-transcript counts)', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();
		convCtx.loadItems(
			[
				{ role: 'user', content: 'prior q', timestamp: 1 },
				{ role: 'assistant', content: 'prior a', timestamp: 2 },
				{ role: 'transfer', content: 'Transfer: echo → booker', timestamp: 3 },
			],
			{ alreadyPersisted: false },
		);
		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
			undefined,
			{ historyResumeMode: 'copy', initialItemCount: 3 }, // NO initialAnalytics
		);

		eventBus.publish('session.start', { sessionId: 'sess_1', userId: 'user_1', agentName: 'echo' });
		convCtx.addUserMessage('new q');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 't' });
		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'normal' });
		await writer.drain();

		const report = store.saveSessionReport.mock.calls[0][0];
		// prior items are re-flushed into the fresh record, so counts reflect the FULL transcript:
		// 2 prior user/assistant + 1 new user = 2 user, 1 assistant, and the prior transfer is counted.
		expect(report.analytics.userMessageCount).toBe(2);
		expect(report.analytics.assistantMessageCount).toBe(1);
		expect(report.analytics.agentTransferCount).toBe(1);
	});

	it('counts a live agent.transfer exactly once (item-derived, not double-counted)', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();
		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		// AgentRouter appends the transfer item BEFORE publishing the event.
		convCtx.addAgentTransfer('echo', 'booker');
		eventBus.publish('agent.transfer', {
			sessionId: 'sess_1',
			fromAgent: 'echo',
			toAgent: 'booker',
		});
		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'normal' });
		await writer.drain();

		expect(store.saveSessionReport.mock.calls[0][0].analytics.agentTransferCount).toBe(1);
	});

	it('attach without ensureSession support does NOT createSession (no destructive wipe)', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();
		// Remove attach support.
		(store as { ensureSession?: unknown }).ensureSession = undefined;
		(store as { reactivateSession?: unknown }).reactivateSession = undefined;
		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
			undefined,
			{ historyResumeMode: 'attach' },
		);

		eventBus.publish('session.start', { sessionId: 'sess_1', userId: 'user_1', agentName: 'echo' });
		await writer.drain();

		expect(store.createSession).not.toHaveBeenCalled();
	});

	it('flushNow persists unflushed items once and a later turn.end does not re-persist them', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);

		convCtx.addUserMessage('Hello');
		convCtx.addAssistantMessage('Hi there');
		writer.flushNow();
		await writer.drain();

		expect(store.addItems).toHaveBeenCalledOnce();
		expect(store.addItems.mock.calls[0][1].map((i: { content: string }) => i.content)).toEqual([
			'Hello',
			'Hi there',
		]);

		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });
		await writer.drain();
		expect(store.addItems).toHaveBeenCalledOnce();

		convCtx.addUserMessage('Later');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_2' });
		await writer.drain();
		expect(store.addItems).toHaveBeenCalledTimes(2);
		expect(store.addItems.mock.calls[1][1].map((i: { content: string }) => i.content)).toEqual([
			'Later',
		]);
	});

	it('drain() awaits ordered writes: session.close report lands even with a delayed store', async () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();
		const order: string[] = [];
		store.addItems = vi.fn(async () => {
			await new Promise((r) => setTimeout(r, 20));
			order.push('addItems');
		});
		store.saveSessionReport = vi.fn(async () => {
			order.push('saveSessionReport');
		});

		const writer = new ConversationHistoryWriter(
			'sess_1',
			'user_1',
			'echo',
			eventBus,
			convCtx,
			store,
		);
		convCtx.addUserMessage('hi');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 't' });
		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'normal' });
		await writer.drain();

		// Despite addItems being slow, the report lands AFTER it (serial queue), never before.
		expect(order).toEqual(['addItems', 'saveSessionReport']);
	});
});
