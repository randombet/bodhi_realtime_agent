// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { ConversationContext } from '../../src/core/conversation-context.js';

describe('ConversationContext', () => {
	it('starts empty', () => {
		const ctx = new ConversationContext();
		expect(ctx.items).toHaveLength(0);
		expect(ctx.summary).toBeNull();
		expect(ctx.tokenEstimate).toBe(0);
	});

	it('addUserMessage appends item with correct role', () => {
		const ctx = new ConversationContext();
		ctx.addUserMessage('hello');
		expect(ctx.items).toHaveLength(1);
		expect(ctx.items[0].role).toBe('user');
		expect(ctx.items[0].content).toBe('hello');
		expect(ctx.items[0].timestamp).toBeGreaterThan(0);
	});

	it('addAssistantMessage appends item with correct role', () => {
		const ctx = new ConversationContext();
		ctx.addAssistantMessage('hi there');
		expect(ctx.items[0].role).toBe('assistant');
		expect(ctx.items[0].content).toBe('hi there');
	});

	it('addToolCall serializes call to JSON', () => {
		const ctx = new ConversationContext();
		ctx.addToolCall({ toolCallId: 'tc_1', toolName: 'search', args: { q: 'test' } });
		expect(ctx.items[0].role).toBe('tool_call');
		const parsed = JSON.parse(ctx.items[0].content);
		expect(parsed.toolCallId).toBe('tc_1');
	});

	it('addToolResult serializes result to JSON', () => {
		const ctx = new ConversationContext();
		ctx.addToolResult({ toolCallId: 'tc_1', toolName: 'search', result: 'found' });
		expect(ctx.items[0].role).toBe('tool_result');
		const parsed = JSON.parse(ctx.items[0].content);
		expect(parsed.result).toBe('found');
	});

	it('addAgentTransfer records transfer', () => {
		const ctx = new ConversationContext();
		ctx.addAgentTransfer('general', 'booking');
		expect(ctx.items[0].role).toBe('transfer');
		expect(ctx.items[0].content).toContain('general');
		expect(ctx.items[0].content).toContain('booking');
	});

	it('tokenEstimate increases with items', () => {
		const ctx = new ConversationContext();
		expect(ctx.tokenEstimate).toBe(0);
		ctx.addUserMessage('a'.repeat(100));
		expect(ctx.tokenEstimate).toBe(25); // 100/4
		ctx.addAssistantMessage('b'.repeat(200));
		expect(ctx.tokenEstimate).toBe(75); // (100+200)/4
	});

	it('tokenEstimate includes summary', () => {
		const ctx = new ConversationContext();
		ctx.addUserMessage('a'.repeat(100));
		ctx.markCheckpoint();
		ctx.setSummary('s'.repeat(40));
		// After setSummary, old items evicted. Only summary token count remains.
		expect(ctx.tokenEstimate).toBe(10); // 40/4
	});

	describe('checkpoint', () => {
		it('getItemsSinceCheckpoint returns all items initially', () => {
			const ctx = new ConversationContext();
			ctx.addUserMessage('a');
			ctx.addAssistantMessage('b');
			expect(ctx.getItemsSinceCheckpoint()).toHaveLength(2);
		});

		it('markCheckpoint advances cursor', () => {
			const ctx = new ConversationContext();
			ctx.addUserMessage('a');
			ctx.markCheckpoint();
			ctx.addAssistantMessage('b');
			const since = ctx.getItemsSinceCheckpoint();
			expect(since).toHaveLength(1);
			expect(since[0].content).toBe('b');
		});

		it('getItemsSinceCheckpoint returns empty after checkpoint with no new items', () => {
			const ctx = new ConversationContext();
			ctx.addUserMessage('a');
			ctx.markCheckpoint();
			expect(ctx.getItemsSinceCheckpoint()).toHaveLength(0);
		});
	});

	describe('setSummary', () => {
		it('stores summary and evicts old items', () => {
			const ctx = new ConversationContext();
			ctx.addUserMessage('old1');
			ctx.addAssistantMessage('old2');
			ctx.markCheckpoint();
			ctx.addUserMessage('new1');

			ctx.setSummary('Summary of old conversation');

			expect(ctx.summary).toBe('Summary of old conversation');
			// Only items since checkpoint remain
			expect(ctx.items).toHaveLength(1);
			expect(ctx.items[0].content).toBe('new1');
		});
	});

	describe('getSubagentContext', () => {
		it('assembles snapshot with summary, recent turns, and memory', () => {
			const ctx = new ConversationContext();
			ctx.addUserMessage('turn1');
			ctx.addAssistantMessage('turn2');
			ctx.addUserMessage('turn3');

			const task = {
				description: 'Search for flights',
				toolCallId: 'tc_1',
				toolName: 'search',
				args: { query: 'flights' },
			};
			const facts = [
				{ content: 'Likes window seat', category: 'preference' as const, timestamp: 1 },
			];
			const snapshot = ctx.getSubagentContext(task, 'You are a booking agent.', facts, 2);

			expect(snapshot.task).toBe(task);
			expect(snapshot.conversationSummary).toBeNull();
			expect(snapshot.recentTurns).toHaveLength(2);
			expect(snapshot.recentTurns[0].content).toBe('turn2');
			expect(snapshot.relevantMemoryFacts).toEqual(facts);
			expect(snapshot.agentInstructions).toBe('You are a booking agent.');
		});
	});

	describe('toReplayContent', () => {
		it('formats user/assistant items as text ReplayItems', () => {
			const ctx = new ConversationContext();
			ctx.addUserMessage('hello');
			ctx.addAssistantMessage('hi');

			const content = ctx.toReplayContent();
			expect(content).toHaveLength(2);
			expect(content[0]).toEqual({ type: 'text', role: 'user', text: 'hello' });
			expect(content[1]).toEqual({ type: 'text', role: 'assistant', text: 'hi' });
		});

		it('prepends summary as user text ReplayItem', () => {
			const ctx = new ConversationContext();
			ctx.addUserMessage('msg');
			ctx.markCheckpoint();
			ctx.setSummary('Previous context');
			ctx.addUserMessage('new msg');

			const content = ctx.toReplayContent();
			expect(content[0]).toEqual({
				type: 'text',
				role: 'user',
				text: '[Context summary]: Previous context',
			});
			expect(content[1]).toEqual({ type: 'text', role: 'user', text: 'new msg' });
		});

		it('maps tool_call to typed ReplayItem', () => {
			const ctx = new ConversationContext();
			ctx.addToolCall({ toolCallId: 'tc', toolName: 'fn', args: { x: 1 } });
			const content = ctx.toReplayContent();
			expect(content[0]).toEqual({
				type: 'tool_call',
				id: 'tc',
				name: 'fn',
				args: { x: 1 },
			});
		});

		it('maps tool_result to typed ReplayItem', () => {
			const ctx = new ConversationContext();
			ctx.addToolResult({ toolCallId: 'tc', toolName: 'fn', result: 'found' });
			const content = ctx.toReplayContent();
			expect(content[0]).toEqual({
				type: 'tool_result',
				id: 'tc',
				name: 'fn',
				result: 'found',
			});
		});

		it('maps transfer to typed ReplayItem', () => {
			const ctx = new ConversationContext();
			ctx.addAgentTransfer('general', 'booking');
			const content = ctx.toReplayContent();
			expect(content[0]).toEqual({
				type: 'transfer',
				fromAgent: 'general',
				toAgent: 'booking',
			});
		});
	});

	it('items are exposed as readonly', () => {
		const ctx = new ConversationContext();
		ctx.addUserMessage('test');
		const items = ctx.items;
		// TypeScript prevents mutation, but at runtime it's an array reference
		expect(Array.isArray(items)).toBe(true);
	});
});
