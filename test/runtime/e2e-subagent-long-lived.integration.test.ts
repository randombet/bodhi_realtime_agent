// SPDX-License-Identifier: MIT

/**
 * End-to-end integration test for long-lived (persistent) subagent workflows.
 *
 * Verifies that persistent subagent state survives across multiple turns,
 * interactive waits, cancellation, and reconnect — and that the behavior
 * is identical regardless of transport provider.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorRuntime } from '../../src/runtime/actor-runtime.js';
import { ClientGatewayActor } from '../../src/runtime/actors/client-gateway-actor.js';
import { MainAgentActor } from '../../src/runtime/actors/main-agent-actor.js';
import { SessionActor } from '../../src/runtime/actors/session-actor.js';
import { SubagentSupervisorActor } from '../../src/runtime/actors/subagent-supervisor-actor.js';
import { ToolRouterActor } from '../../src/runtime/actors/tool-router-actor.js';
import type { ToolRoutingInfo } from '../../src/runtime/actors/tool-router-actor.js';
import { TransportActor } from '../../src/runtime/actors/transport-actor.js';
import type { TransportAdapter } from '../../src/runtime/adapters/transport-adapter.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(): TransportAdapter {
	return {
		onSessionReady: undefined,
		onTurnComplete: undefined,
		onInterrupted: undefined,
		onToolCallReceived: undefined,
		onToolCallCancelled: undefined,
		onError: undefined,
		onClosed: undefined,
		sendContent: vi.fn(),
		sendToolResult: vi.fn(),
		transferSession: vi.fn().mockResolvedValue(undefined),
		cancelGeneration: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

function createClientRecorder() {
	const messages: Record<string, unknown>[] = [];
	return { send: vi.fn((msg: Record<string, unknown>) => messages.push(msg)), messages };
}

const PERSISTENT_TOOLS: Map<string, ToolRoutingInfo> = new Map([
	[
		'ask_coder',
		{
			name: 'ask_coder',
			execution: 'background',
			configName: 'coder',
			lifetime: 'persistent_session',
		},
	],
	[
		'ask_reviewer',
		{
			name: 'ask_reviewer',
			execution: 'background',
			configName: 'reviewer',
			lifetime: 'persistent_session',
		},
	],
]);

function createGraph() {
	const runtime = new ActorRuntime();
	const adapter = createMockAdapter();
	const client = createClientRecorder();
	const allMessages: Array<{ type: string; payload: unknown; to: string }> = [];

	const sendFn = (type: string, payload: unknown, to: string) => {
		allMessages.push({ type, payload, to });
		runtime.tell(type, payload, to);
	};

	const transportActor = new TransportActor('transport', adapter, sendFn, 'session', 'tool-router');
	const sessionActor = new SessionActor('session', sendFn, 'transport');
	const toolRouter = new ToolRouterActor(
		'tool-router',
		PERSISTENT_TOOLS,
		{ execute: vi.fn().mockResolvedValue({ result: 'ok' }) },
		sendFn,
		'transport',
		'subagent-supervisor',
		'main-agent',
	);
	const subagentSupervisor = new SubagentSupervisorActor(
		'subagent-supervisor',
		sendFn,
		'transport',
		'session',
	);
	const mainAgent = new MainAgentActor('main-agent', sendFn, 'transport', 'session');
	const clientGateway = new ClientGatewayActor('client-gateway', sendFn, client.send, 'session');

	return {
		runtime,
		adapter,
		client,
		allMessages,
		transportActor,
		sessionActor,
		toolRouter,
		subagentSupervisor,
		mainAgent,
		clientGateway,
	};
}

async function startAll(g: ReturnType<typeof createGraph>) {
	await g.runtime.startActor(g.transportActor);
	await g.runtime.startActor(g.sessionActor);
	await g.runtime.startActor(g.toolRouter);
	await g.runtime.startActor(g.subagentSupervisor);
	await g.runtime.startActor(g.mainAgent);
	await g.runtime.startActor(g.clientGateway);
	g.adapter.onSessionReady?.();
	await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E long-lived subagent workflows', () => {
	let g: ReturnType<typeof createGraph>;

	beforeEach(async () => {
		g = createGraph();
		await startAll(g);
	});

	describe('persistent workflow lifecycle', () => {
		it('spawns a persistent workflow and completes across turns', async () => {
			// Turn 1: spawn the persistent subagent
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-p1', name: 'ask_coder', args: { task: 'implement feature' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-p1')).toBe(true));
			expect(g.subagentSupervisor.getWorkflowState('tc-p1')).toBe('running');

			// Simulate a turn completing (voice turn boundary)
			g.adapter.onTurnComplete?.('turn-1');

			// Workflow should still be active
			expect(g.subagentSupervisor.hasWorkflow('tc-p1')).toBe(true);

			// Turn 2: another voice turn, workflow still going
			g.adapter.onTurnComplete?.('turn-2');
			expect(g.subagentSupervisor.hasWorkflow('tc-p1')).toBe(true);

			// Subagent completes in the background
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-p1', workflowId: 'wf-1', result: 'feature done' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.adapter.sendToolResult).toHaveBeenCalledWith(
					'tc-p1',
					'coder',
					{ result: 'feature done' },
					'when_idle',
				),
			);
		});

		it('supports multiple concurrent persistent workflows', async () => {
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-c1', name: 'ask_coder', args: { task: 'write tests' } },
			]);
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-r1', name: 'ask_reviewer', args: { task: 'review PR' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-c1')).toBe(true));
			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-r1')).toBe(true));

			// Complete coder first
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-c1', workflowId: 'wf-1', result: 'tests written' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.adapter.sendToolResult).toHaveBeenCalledWith(
					'tc-c1',
					'coder',
					{ result: 'tests written' },
					'when_idle',
				),
			);

			// Reviewer still active
			expect(g.subagentSupervisor.hasWorkflow('tc-r1')).toBe(true);

			// Complete reviewer
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-r1', workflowId: 'wf-2', result: 'LGTM' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.adapter.sendToolResult).toHaveBeenCalledWith(
					'tc-r1',
					'reviewer',
					{ result: 'LGTM' },
					'when_idle',
				),
			);
		});
	});

	describe('interactive wait/resume', () => {
		it('workflow transitions to waiting_input and back to running on answer', async () => {
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-int', name: 'ask_coder', args: { task: 'need clarification' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-int')).toBe(true));

			// Subagent needs input
			g.runtime.send(
				createEnvelope(
					'subagent.needs_input',
					{
						toolCallId: 'tc-int',
						workflowId: 'wf-1',
						question: 'Which database?',
					},
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.subagentSupervisor.getWorkflowState('tc-int')).toBe('waiting_input'),
			);

			// User responds
			g.runtime.send(
				createEnvelope(
					'interaction.answer_delivered',
					{
						toolCallId: 'tc-int',
						workflowId: 'wf-1',
						text: 'PostgreSQL',
					},
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.subagentSupervisor.getWorkflowState('tc-int')).toBe('running'),
			);

			// Workflow eventually completes
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-int', workflowId: 'wf-1', result: 'done with PG' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() => expect(g.adapter.sendToolResult).toHaveBeenCalled());
		});
	});

	describe('cancellation semantics', () => {
		it('cancel during running prevents completion', async () => {
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-cx', name: 'ask_coder', args: { task: 'long task' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-cx')).toBe(true));

			// Cancel via tool call cancellation
			g.adapter.onToolCallCancelled?.(['tc-cx']);

			await vi.waitFor(() =>
				expect(g.subagentSupervisor.getWorkflowState('tc-cx')).toBeUndefined(),
			);

			// Late completion ignored
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-cx', workflowId: 'wf-1', result: 'late' },
					'subagent-supervisor',
				),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(g.adapter.sendToolResult).not.toHaveBeenCalled();
		});

		it('cancel during waiting_input transitions to cancelled', async () => {
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-cw', name: 'ask_coder', args: { task: 'interactive' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-cw')).toBe(true));

			g.runtime.send(
				createEnvelope(
					'subagent.needs_input',
					{ toolCallId: 'tc-cw', workflowId: 'wf-1', question: 'Which?' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.subagentSupervisor.getWorkflowState('tc-cw')).toBe('waiting_input'),
			);

			g.adapter.onToolCallCancelled?.(['tc-cw']);

			await vi.waitFor(() =>
				expect(g.subagentSupervisor.getWorkflowState('tc-cw')).toBeUndefined(),
			);
		});
	});

	describe('session continuity under reconnect', () => {
		it('persistent workflows survive transport error + reconnect', async () => {
			// Spawn a persistent workflow
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-rc', name: 'ask_coder', args: { task: 'survive reconnect' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-rc')).toBe(true));

			// Transport error — session goes to reconnecting
			g.adapter.onError?.('connection lost', true);
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('reconnecting'));

			// Workflow should still be tracked
			expect(g.subagentSupervisor.hasWorkflow('tc-rc')).toBe(true);
			expect(g.subagentSupervisor.getWorkflowState('tc-rc')).toBe('running');

			// Reconnect succeeds
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			// Workflow completes after reconnect
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-rc', workflowId: 'wf-1', result: 'survived' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.adapter.sendToolResult).toHaveBeenCalledWith(
					'tc-rc',
					'coder',
					{ result: 'survived' },
					'when_idle',
				),
			);
		});
	});

	describe('one terminal event per workflow', () => {
		it('double completion is ignored', async () => {
			g.adapter.onToolCallReceived?.([{ id: 'tc-dbl', name: 'ask_coder', args: { task: 'once' } }]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-dbl')).toBe(true));

			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-dbl', workflowId: 'wf-1', result: 'first' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() => expect(g.adapter.sendToolResult).toHaveBeenCalledTimes(1));

			// Second completion — ignored
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-dbl', workflowId: 'wf-1', result: 'second' },
					'subagent-supervisor',
				),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(g.adapter.sendToolResult).toHaveBeenCalledTimes(1);
		});

		it('failure after completion is ignored', async () => {
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-fc', name: 'ask_coder', args: { task: 'finish then fail' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-fc')).toBe(true));

			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-fc', workflowId: 'wf-1', result: 'done' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() => expect(g.adapter.sendToolResult).toHaveBeenCalledTimes(1));

			// Late failure
			g.runtime.send(
				createEnvelope(
					'subagent.failed',
					{ toolCallId: 'tc-fc', workflowId: 'wf-1', error: 'oops' },
					'subagent-supervisor',
				),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(g.adapter.sendToolResult).toHaveBeenCalledTimes(1);
		});
	});
});
