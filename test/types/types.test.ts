// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type {
	ConversationItem,
	EventPayload,
	EventPayloadMap,
	EventType,
	FrameworkHooks,
	MainAgent,
	MemoryFact,
	SessionState,
	SubagentConfig,
	SubagentResult,
	ToolDefinition,
	UIPayload,
	UIResponse,
	Unsubscribe,
} from '../../src/types/index.js';

describe('type definitions', () => {
	it('EventType is a union of all event keys', () => {
		// @ts-expect-error - 'not.an.event' is not a valid EventType
		const _bad: EventType = 'not.an.event';

		const good: EventType = 'tool.call';
		expect(good).toBe('tool.call');
	});

	it('EventPayload resolves correct type per event', () => {
		type ToolCallPayload = EventPayload<'tool.call'>;
		const payload: ToolCallPayload = {
			toolCallId: 'tc_1',
			toolName: 'search',
			args: {},
			sessionId: 'sess_1',
			agentName: 'main',
		};
		expect(payload.toolCallId).toBe('tc_1');
	});

	it('SessionState is a finite union', () => {
		const states: SessionState[] = [
			'CREATED',
			'CONNECTING',
			'ACTIVE',
			'RECONNECTING',
			'TRANSFERRING',
			'CLOSED',
		];
		expect(states).toHaveLength(6);
	});

	it('ConversationItem role union', () => {
		const item: ConversationItem = {
			role: 'user',
			content: 'hello',
			timestamp: Date.now(),
		};
		expect(item.role).toBe('user');

		// @ts-expect-error - 'invalid' is not a valid role
		const _bad: ConversationItem = { role: 'invalid', content: '', timestamp: 0 };
	});

	it('UIPayload includes image type', () => {
		const payload: UIPayload = {
			type: 'image',
			data: { imageBase64: 'abc', mimeType: 'image/png' },
		};
		expect(payload.type).toBe('image');
	});

	it('SubagentResult can carry uiPayload', () => {
		const result: SubagentResult = {
			text: 'done',
			stepCount: 1,
			uiPayload: { type: 'confirmation', data: { status: 'ok' } },
		};
		expect(result.uiPayload?.type).toBe('confirmation');

		const resultNoUi: SubagentResult = { text: 'done', stepCount: 1 };
		expect(resultNoUi.uiPayload).toBeUndefined();
	});

	it('MemoryFact category union', () => {
		const fact: MemoryFact = {
			content: 'Likes coffee',
			category: 'preference',
			timestamp: Date.now(),
		};
		expect(fact.category).toBe('preference');
	});

	it('FrameworkHooks are all optional', () => {
		const hooks: FrameworkHooks = {};
		expect(hooks.onSessionStart).toBeUndefined();
		expect(hooks.onError).toBeUndefined();
	});

	it('Unsubscribe is a function returning void', () => {
		const unsub: Unsubscribe = () => {};
		expect(typeof unsub).toBe('function');
	});

	it('UIResponse has requestId', () => {
		const response: UIResponse = { requestId: 'req_1', selectedOptionId: 'opt_a' };
		expect(response.requestId).toBe('req_1');
	});

	it('EventPayloadMap covers all event categories', () => {
		// Verify key event types exist in the map
		type AgentEvent = EventPayload<'agent.transfer'>;
		type ToolEvent = EventPayload<'tool.result'>;
		type TurnEvent = EventPayload<'turn.end'>;
		type SessionEvent = EventPayload<'session.close'>;
		type UIEvent = EventPayload<'subagent.ui.send'>;
		type NotifEvent = EventPayload<'subagent.notification'>;

		// These are compile-time checks — if any type is wrong, TS will error
		const agentPayload: AgentEvent = {
			sessionId: 's',
			fromAgent: 'a',
			toAgent: 'b',
		};
		expect(agentPayload.fromAgent).toBe('a');
	});
});
