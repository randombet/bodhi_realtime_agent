// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import { SubagentSupervisorActor } from '../../src/runtime/actors/subagent-supervisor-actor.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

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

	const actor = new SubagentSupervisorActor(
		'subagent-supervisor',
		send,
		'transport', // transportActorId
		'session', // sessionActorId
	);

	return { actor, messages };
}

function spawnEnvelope(
	toolCallId: string,
	configName = 'coder',
	lifetime: 'ephemeral' | 'persistent_session' = 'ephemeral',
) {
	return createEnvelope(
		'subagent.spawn_requested',
		{
			toolCallId,
			toolName: configName,
			args: {},
			configName,
			lifetime,
		},
		'subagent-supervisor',
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubagentSupervisorActor', () => {
	let actor: SubagentSupervisorActor;
	let messages: SentMessage[];

	beforeEach(() => {
		const s = setup();
		actor = s.actor;
		messages = s.messages;
	});

	// -- Spawn ----------------------------------------------------------------

	describe('spawn', () => {
		it('creates a workflow and sends subagent.started', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));

			expect(actor.hasWorkflow('tc-1')).toBe(true);
			expect(actor.getWorkflowState('tc-1')).toBe('running');
			expect(messages).toHaveLength(1);
			expect(messages[0].type).toBe('subagent.started');
			expect(messages[0].to).toBe('session');
		});

		it('assigns unique workflow IDs', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			await actor.onMessage(spawnEnvelope('tc-2'));

			const wf1 = (messages[0].payload as { workflowId: string }).workflowId;
			const wf2 = (messages[1].payload as { workflowId: string }).workflowId;
			expect(wf1).not.toBe(wf2);
		});
	});

	// -- Completion -----------------------------------------------------------

	describe('completion', () => {
		it('sends tool result on completion', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'subagent-supervisor',
				),
			);

			const toolResult = messages.find((m) => m.type === 'transport.send_tool_result');
			expect(toolResult).toBeDefined();
			expect(toolResult?.to).toBe('transport');
			expect((toolResult?.payload as { scheduling: string }).scheduling).toBe('when_idle');
			expect(actor.hasWorkflow('tc-1')).toBe(false);
		});

		it('ignores duplicate completion (terminal state immutability)', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'subagent-supervisor',
				),
			);
			messages.length = 0;

			// Second completion should be ignored
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done again' },
					'subagent-supervisor',
				),
			);

			expect(messages).toHaveLength(0);
		});
	});

	// -- Failure --------------------------------------------------------------

	describe('failure', () => {
		it('sends error tool result on failure', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope(
					'subagent.failed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', error: 'timeout' },
					'subagent-supervisor',
				),
			);

			const toolResult = messages.find((m) => m.type === 'transport.send_tool_result');
			expect(toolResult).toBeDefined();
			expect((toolResult?.payload as { result: { error: string } }).result.error).toBe('timeout');
			expect(actor.hasWorkflow('tc-1')).toBe(false);
		});
	});

	// -- Cancellation ---------------------------------------------------------

	describe('cancellation', () => {
		it('cancels a running workflow', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope('subagent.cancel_requested', { toolCallId: 'tc-1' }, 'subagent-supervisor'),
			);

			const cancelled = messages.find((m) => m.type === 'subagent.cancelled');
			expect(cancelled).toBeDefined();
			expect(actor.hasWorkflow('tc-1')).toBe(false);
		});

		it('ignores cancel for already-completed workflow', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'subagent-supervisor',
				),
			);
			messages.length = 0;

			await actor.onMessage(
				createEnvelope('subagent.cancel_requested', { toolCallId: 'tc-1' }, 'subagent-supervisor'),
			);

			expect(messages).toHaveLength(0);
		});

		it('ignores cancel for non-existent workflow', async () => {
			await actor.onMessage(
				createEnvelope(
					'subagent.cancel_requested',
					{ toolCallId: 'nonexistent' },
					'subagent-supervisor',
				),
			);

			expect(messages).toHaveLength(0);
		});
	});

	// -- Interactive input ----------------------------------------------------

	describe('interactive input', () => {
		it('transitions to waiting_input on needs_input', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope(
					'subagent.needs_input',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', question: 'Q?' },
					'subagent-supervisor',
				),
			);

			expect(actor.getWorkflowState('tc-1')).toBe('waiting_input');
			const presented = messages.find((m) => m.type === 'interaction.question_presented');
			expect(presented).toBeDefined();
		});

		it('transitions back to running on answer_delivered', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			await actor.onMessage(
				createEnvelope(
					'subagent.needs_input',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', question: 'Q?' },
					'subagent-supervisor',
				),
			);

			await actor.onMessage(
				createEnvelope(
					'interaction.answer_delivered',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', text: 'A' },
					'subagent-supervisor',
				),
			);

			expect(actor.getWorkflowState('tc-1')).toBe('running');
		});

		it('can cancel during waiting_input', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			await actor.onMessage(
				createEnvelope(
					'subagent.needs_input',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', question: 'Q?' },
					'subagent-supervisor',
				),
			);
			messages.length = 0;

			await actor.onMessage(
				createEnvelope('subagent.cancel_requested', { toolCallId: 'tc-1' }, 'subagent-supervisor'),
			);

			const cancelled = messages.find((m) => m.type === 'subagent.cancelled');
			expect(cancelled).toBeDefined();
			expect(actor.hasWorkflow('tc-1')).toBe(false);
		});
	});

	// -- Concurrent isolation -------------------------------------------------

	describe('concurrent subagent isolation', () => {
		it('manages multiple independent workflows', async () => {
			await actor.onMessage(spawnEnvelope('tc-1', 'coder'));
			await actor.onMessage(spawnEnvelope('tc-2', 'researcher'));

			expect(actor.activeWorkflowCount).toBe(2);

			// Complete one
			await actor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'subagent-supervisor',
				),
			);

			expect(actor.activeWorkflowCount).toBe(1);
			expect(actor.hasWorkflow('tc-1')).toBe(false);
			expect(actor.hasWorkflow('tc-2')).toBe(true);
		});

		it('cancellation of one does not affect another', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			await actor.onMessage(spawnEnvelope('tc-2'));

			await actor.onMessage(
				createEnvelope('subagent.cancel_requested', { toolCallId: 'tc-1' }, 'subagent-supervisor'),
			);

			expect(actor.hasWorkflow('tc-1')).toBe(false);
			expect(actor.hasWorkflow('tc-2')).toBe(true);
			expect(actor.getWorkflowState('tc-2')).toBe('running');
		});
	});

	// -- Persistent lifecycle -------------------------------------------------

	describe('persistent subagent lifecycle', () => {
		it('tracks persistent_session lifetime in workflow', async () => {
			await actor.onMessage(spawnEnvelope('tc-1', 'coder', 'persistent_session'));

			expect(actor.hasWorkflow('tc-1')).toBe(true);
			// The supervisor tracks the workflow; the persistent instance
			// management is handled by PersistentSubagentManager separately.
		});
	});

	// -- Timeout handling -----------------------------------------------------

	describe('timeout', () => {
		it('treats timeout as cancel request', async () => {
			await actor.onMessage(spawnEnvelope('tc-1'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope(
					'subagent.timeout',
					{ toolCallId: 'tc-1', workflowId: 'wf-1' },
					'subagent-supervisor',
				),
			);

			const cancelled = messages.find((m) => m.type === 'subagent.cancelled');
			expect(cancelled).toBeDefined();
		});
	});

	// -- Execution bridge -----------------------------------------------------

	describe('execution bridge', () => {
		it('runs executionHandler and emits completion tool result', async () => {
			const bridgeMessages: SentMessage[] = [];
			const send = (type: string, payload: unknown, to: string) => {
				bridgeMessages.push({ type, payload, to });
			};
			const actorWithBridge = new SubagentSupervisorActor(
				'subagent-supervisor',
				send,
				'transport',
				'session',
				async () => 'background done',
			);

			await actorWithBridge.onMessage(spawnEnvelope('tc-bridge', 'ask_openclaw'));

			await new Promise((r) => setTimeout(r, 10));
			const toolResult = bridgeMessages.find((m) => m.type === 'transport.send_tool_result');
			expect(toolResult).toBeDefined();
			expect((toolResult?.payload as { id: string }).id).toBe('tc-bridge');
			expect((toolResult?.payload as { result: { result: string } }).result.result).toBe(
				'background done',
			);
		});
	});
});
