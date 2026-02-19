// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { ConversationContext } from '../../src/core/conversation-context.js';
import { ConversationHistoryWriter } from '../../src/core/conversation-history-writer.js';
import { EventBus } from '../../src/core/event-bus.js';
import type { ConversationHistoryStore } from '../../src/types/history.js';

function createMockStore(): ConversationHistoryStore & {
	createSession: ReturnType<typeof vi.fn>;
	updateSession: ReturnType<typeof vi.fn>;
	addItems: ReturnType<typeof vi.fn>;
	saveSessionReport: ReturnType<typeof vi.fn>;
	getSession: ReturnType<typeof vi.fn>;
	getSessionItems: ReturnType<typeof vi.fn>;
	listUserSessions: ReturnType<typeof vi.fn>;
} {
	return {
		createSession: vi.fn(async () => {}),
		updateSession: vi.fn(async () => {}),
		addItems: vi.fn(async () => {}),
		saveSessionReport: vi.fn(async () => {}),
		getSession: vi.fn(async () => null),
		getSessionItems: vi.fn(async () => []),
		listUserSessions: vi.fn(async () => []),
	};
}

describe('ConversationHistoryWriter', () => {
	it('creates session on session.start', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		eventBus.publish('session.start', {
			sessionId: 'sess_1',
			userId: 'user_1',
			agentName: 'echo',
		});

		expect(store.createSession).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'sess_1',
				userId: 'user_1',
				initialAgentName: 'echo',
				status: 'active',
			}),
		);
	});

	it('flushes items on turn.end', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		convCtx.addUserMessage('Hello');
		convCtx.addAssistantMessage('Hi there');

		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });

		expect(store.addItems).toHaveBeenCalledOnce();
		expect(store.addItems).toHaveBeenCalledWith(
			'sess_1',
			expect.arrayContaining([
				expect.objectContaining({ role: 'user', content: 'Hello' }),
				expect.objectContaining({ role: 'assistant', content: 'Hi there' }),
			]),
		);
	});

	it('advances checkpoint so no duplicates on next flush', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		convCtx.addUserMessage('First');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });

		convCtx.addUserMessage('Second');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_2' });

		// Second flush should only contain "Second"
		const secondCall = store.addItems.mock.calls[1];
		expect(secondCall[1]).toHaveLength(1);
		expect(secondCall[1][0].content).toBe('Second');
	});

	it('does not flush when no new items', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });

		expect(store.addItems).not.toHaveBeenCalled();
	});

	it('flushes on agent.transfer', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		convCtx.addUserMessage('Transfer me');

		eventBus.publish('agent.transfer', {
			sessionId: 'sess_1',
			fromAgent: 'echo',
			toAgent: 'booking',
		});

		expect(store.addItems).toHaveBeenCalledOnce();
	});

	it('saves session report on session.close', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		convCtx.addUserMessage('Goodbye');

		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'user_hangup' });

		expect(store.saveSessionReport).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'sess_1',
				status: 'ended',
				disconnectReason: 'user_hangup',
			}),
		);
	});

	it('tracks analytics across turns', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		convCtx.addUserMessage('Q1');
		convCtx.addAssistantMessage('A1');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_1' });

		convCtx.addUserMessage('Q2');
		convCtx.addAssistantMessage('A2');
		eventBus.publish('turn.end', { sessionId: 'sess_1', turnId: 'turn_2' });

		eventBus.publish('session.close', { sessionId: 'sess_1', reason: 'normal' });

		const report = store.saveSessionReport.mock.calls[0][0];
		expect(report.analytics.turnCount).toBe(2);
		expect(report.analytics.userMessageCount).toBe(2);
		expect(report.analytics.assistantMessageCount).toBe(2);
	});

	it('ignores events from other sessions', () => {
		const eventBus = new EventBus();
		const convCtx = new ConversationContext();
		const store = createMockStore();

		new ConversationHistoryWriter('sess_1', 'user_1', 'echo', eventBus, convCtx, store);

		convCtx.addUserMessage('Hello');
		eventBus.publish('turn.end', { sessionId: 'sess_other', turnId: 'turn_1' });

		expect(store.addItems).not.toHaveBeenCalled();
	});

	it('dispose unsubscribes from events', () => {
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

		expect(store.addItems).not.toHaveBeenCalled();
	});
});
