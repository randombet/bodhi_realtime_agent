// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientGatewayActor } from '../../src/runtime/actors/client-gateway-actor.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import type { SubagentCompletion } from '../../src/runtime/subagent-completion.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SentMessage {
	type: string;
	payload: unknown;
	to: string;
}

function setup() {
	const messages: SentMessage[] = [];
	const send = (type: string, payload: unknown, to: string) => {
		messages.push({ type, payload, to });
	};

	const clientMessages: Record<string, unknown>[] = [];
	const clientSend = vi.fn((msg: Record<string, unknown>) => {
		clientMessages.push(msg);
	});

	const actor = new ClientGatewayActor('client-gateway', send, clientSend, 'session');

	return { actor, messages, clientSend, clientMessages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientGatewayActor', () => {
	let actor: ClientGatewayActor;
	let messages: SentMessage[];
	let clientSend: ReturnType<typeof vi.fn>;
	let clientMessages: Record<string, unknown>[];

	beforeEach(() => {
		const s = setup();
		actor = s.actor;
		messages = s.messages;
		clientSend = s.clientSend;
		clientMessages = s.clientMessages;
	});

	// -- Question presentation -----------------------------------------------

	describe('interaction.question_presented', () => {
		it('sends question to client', async () => {
			await actor.onMessage(
				createEnvelope(
					'interaction.question_presented',
					{
						toolCallId: 'tc-1',
						workflowId: 'wf-1',
						question: 'Which option?',
						requestId: 'req-1',
					},
					'client-gateway',
				),
			);

			expect(clientSend).toHaveBeenCalledTimes(1);
			expect(clientMessages[0]).toEqual({
				type: 'subagent.question',
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				question: 'Which option?',
				requestId: 'req-1',
			});
		});
	});

	// -- User input forwarding -----------------------------------------------

	describe('user input forwarding', () => {
		it('forwards user_text_received to session actor', async () => {
			await actor.onMessage(
				createEnvelope('interaction.user_text_received', { text: 'hello' }, 'client-gateway'),
			);

			expect(messages).toHaveLength(1);
			expect(messages[0].type).toBe('interaction.user_text_received');
			expect(messages[0].to).toBe('session');
		});

		it('forwards user_option_selected to session actor', async () => {
			await actor.onMessage(
				createEnvelope(
					'interaction.user_option_selected',
					{ requestId: 'req-1', selectedOptionId: 'opt-2' },
					'client-gateway',
				),
			);

			expect(messages).toHaveLength(1);
			expect(messages[0].type).toBe('interaction.user_option_selected');
			expect(messages[0].to).toBe('session');
		});
	});

	// -- Subagent completion notification ------------------------------------

	describe('subagent completion', () => {
		it('sends completion notification to client on completed', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'client-gateway',
				),
			);

			expect(clientSend).toHaveBeenCalledTimes(1);
			expect(clientMessages[0]).toEqual({
				type: 'subagent.completion',
				toolCallId: 'tc-1',
				status: 'success',
			});
		});

		it('sends failure notification to client', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.failed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', error: 'timeout' },
					'client-gateway',
				),
			);

			expect(clientMessages[0]).toEqual({
				type: 'subagent.completion',
				toolCallId: 'tc-1',
				status: 'failed',
			});
		});

		it('sends cancelled notification to client', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.cancelled',
					{ toolCallId: 'tc-1', workflowId: 'wf-1' },
					'client-gateway',
				),
			);

			expect(clientMessages[0]).toEqual({
				type: 'subagent.completion',
				toolCallId: 'tc-1',
				status: 'cancelled',
			});
		});

		it('uses structured completion when provided', async () => {
			const completion: SubagentCompletion = {
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				status: 'success',
				summaryText: 'Code written',
				uiPayload: { card: 'result' },
				artifacts: [{ type: 'code', name: 'main.ts', content: 'x' }],
				metadata: {
					configName: 'coder',
					durationMs: 1000,
					lifetime: 'ephemeral',
				},
			};

			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{
						toolCallId: 'tc-1',
						workflowId: 'wf-1',
						result: 'done',
						completion,
					},
					'client-gateway',
				),
			);

			expect(clientMessages[0]).toEqual({
				type: 'subagent.completion',
				toolCallId: 'tc-1',
				status: 'success',
				summaryText: 'Code written',
				uiPayload: { card: 'result' },
				artifacts: [{ type: 'code', name: 'main.ts', content: 'x' }],
				metadata: {
					configName: 'coder',
					durationMs: 1000,
					lifetime: 'ephemeral',
				},
			});
		});

		it('deduplicates notifications for same toolCallId', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'client-gateway',
				),
			);

			// Second notification for same toolCallId should be ignored
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done again' },
					'client-gateway',
				),
			);

			expect(clientSend).toHaveBeenCalledTimes(1);
		});

		it('allows notifications for different toolCallIds', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'client-gateway',
				),
			);
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-2', workflowId: 'wf-2', result: 'done' },
					'client-gateway',
				),
			);

			expect(clientSend).toHaveBeenCalledTimes(2);
		});
	});

	// -- Progress messages ---------------------------------------------------

	describe('subagent progress', () => {
		it('forwards progress to client', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.progress',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', text: 'Step 1 of 3' },
					'client-gateway',
				),
			);

			expect(clientMessages[0]).toEqual({
				type: 'subagent.progress',
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				text: 'Step 1 of 3',
			});
		});
	});

	// -- Notification state reset -------------------------------------------

	describe('resetNotificationState', () => {
		it('allows re-notification after reset', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'client-gateway',
				),
			);

			actor.resetNotificationState();

			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'client-gateway',
				),
			);

			expect(clientSend).toHaveBeenCalledTimes(2);
		});
	});
});
