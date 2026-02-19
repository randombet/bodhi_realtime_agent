// SPDX-License-Identifier: MIT

import type { ConversationItem } from '../types/conversation.js';
import type { ConversationHistoryStore, SessionAnalytics } from '../types/history.js';
import type { ConversationContext } from './conversation-context.js';
import type { IEventBus } from './event-bus.js';

/**
 * EventBus-driven writer that persists conversation items to a ConversationHistoryStore.
 *
 * Subscribes to session lifecycle events and flushes incremental batches of conversation
 * items (since the last checkpoint) to the store. Tracks session analytics counters
 * and writes a final SessionReport on session close.
 *
 * Call `dispose()` to unsubscribe from all events.
 */
export class ConversationHistoryWriter {
	private unsubscribers: Array<() => void> = [];
	private analytics: SessionAnalytics = {
		turnCount: 0,
		userMessageCount: 0,
		assistantMessageCount: 0,
		toolCallCount: 0,
		agentTransferCount: 0,
	};

	constructor(
		private sessionId: string,
		private userId: string,
		private initialAgentName: string,
		private eventBus: IEventBus,
		private conversationContext: ConversationContext,
		private store: ConversationHistoryStore,
	) {
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
				this.analytics.agentTransferCount++;
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

	private handleSessionStart(agentName: string): void {
		this.store.createSession({
			id: this.sessionId,
			userId: this.userId,
			initialAgentName: agentName,
			status: 'active',
			startedAt: Date.now(),
		});
	}

	private handleTurnEnd(): void {
		this.analytics.turnCount++;
		this.flush();
	}

	private handleSessionClose(reason: string): void {
		this.flush();

		const items = [...this.conversationContext.items];
		this.store.saveSessionReport({
			id: this.sessionId,
			userId: this.userId,
			initialAgentName: this.initialAgentName,
			status: 'ended',
			startedAt: 0,
			disconnectReason: this.mapReason(reason),
			analytics: { ...this.analytics },
			items,
			pendingToolCalls: [],
		});

		this.dispose();
	}

	private flush(): void {
		const items = this.conversationContext.getItemsSinceCheckpoint();
		if (items.length === 0) return;

		this.updateAnalytics(items);
		this.store.addItems(this.sessionId, items);
		this.conversationContext.markCheckpoint();
	}

	private updateAnalytics(items: readonly ConversationItem[]): void {
		for (const item of items) {
			if (item.role === 'user') this.analytics.userMessageCount++;
			else if (item.role === 'assistant') this.analytics.assistantMessageCount++;
			else if (item.role === 'tool_call') this.analytics.toolCallCount++;
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
