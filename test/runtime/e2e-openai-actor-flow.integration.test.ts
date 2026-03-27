// SPDX-License-Identifier: MIT

/**
 * End-to-end actor flow integration test — OpenAI provider variant.
 *
 * Wires the full actor graph using a mock OpenAI-like adapter and verifies
 * that the canonical message flow is identical to the Gemini variant.
 *
 * The only difference is the adapter mock — all orchestration messages and
 * actor behaviors must produce the exact same results.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorRuntime } from '../../src/runtime/actor-runtime.js';
import { ClientGatewayActor } from '../../src/runtime/actors/client-gateway-actor.js';
import { MainAgentActor } from '../../src/runtime/actors/main-agent-actor.js';
import { SessionActor } from '../../src/runtime/actors/session-actor.js';
import { SubagentSupervisorActor } from '../../src/runtime/actors/subagent-supervisor-actor.js';
import { ToolRouterActor } from '../../src/runtime/actors/tool-router-actor.js';
import type {
	InlineToolExecutor,
	ToolRoutingInfo,
} from '../../src/runtime/actors/tool-router-actor.js';
import { TransportActor } from '../../src/runtime/actors/transport-actor.js';
import type { TransportAdapter } from '../../src/runtime/adapters/transport-adapter.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

// ---------------------------------------------------------------------------
// Helpers — OpenAI-like mock adapter
// ---------------------------------------------------------------------------

function createOpenAIAdapter(): TransportAdapter {
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

// ---------------------------------------------------------------------------
// Full actor graph setup
// ---------------------------------------------------------------------------

function createActorGraph(options?: {
	tools?: Map<string, ToolRoutingInfo>;
	inlineExecutor?: InlineToolExecutor;
}) {
	const runtime = new ActorRuntime();
	const adapter = createOpenAIAdapter();
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
		options?.tools ?? new Map(),
		options?.inlineExecutor ?? { execute: vi.fn().mockResolvedValue({ result: 'ok' }) },
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
		sendFn,
	};
}

async function startAllActors(g: ReturnType<typeof createActorGraph>) {
	await g.runtime.startActor(g.transportActor);
	await g.runtime.startActor(g.sessionActor);
	await g.runtime.startActor(g.toolRouter);
	await g.runtime.startActor(g.subagentSupervisor);
	await g.runtime.startActor(g.mainAgent);
	await g.runtime.startActor(g.clientGateway);
}

// ---------------------------------------------------------------------------
// Tests — identical canonical assertions as Gemini variant
// ---------------------------------------------------------------------------

describe('E2E OpenAI actor flow', () => {
	let g: ReturnType<typeof createActorGraph>;

	beforeEach(async () => {
		g = createActorGraph();
		await startAllActors(g);
	});

	describe('session lifecycle', () => {
		it('adapter session_ready transitions session to active', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));
		});

		it('adapter closed transitions session to closed', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onClosed?.('connection reset');
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('closed'));
		});

		it('recoverable error triggers reconnect flow', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onError?.('temporary failure', true);
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('reconnecting'));
		});
	});

	describe('inline tool call flow', () => {
		it('tool call → inline execution → tool result back to transport', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onToolCallReceived?.([{ id: 'tc-1', name: 'get_weather', args: { city: 'NYC' } }]);

			await vi.waitFor(() => expect(g.adapter.sendToolResult).toHaveBeenCalled());

			const toolResult = g.allMessages.find(
				(m) => m.type === 'transport.send_tool_result' && m.to === 'transport',
			);
			expect(toolResult).toBeDefined();
			expect(toolResult?.payload).toMatchObject({
				id: 'tc-1',
				name: 'get_weather',
				scheduling: 'immediate',
			});
		});

		it('inline tool failure delivers error result to transport', async () => {
			const failingExecutor: InlineToolExecutor = {
				execute: vi.fn().mockRejectedValue(new Error('tool crashed')),
			};
			g = createActorGraph({ inlineExecutor: failingExecutor });
			await startAllActors(g);

			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onToolCallReceived?.([{ id: 'tc-fail', name: 'broken_tool', args: {} }]);

			await vi.waitFor(() => expect(g.adapter.sendToolResult).toHaveBeenCalled());

			const errorResult = g.allMessages.find(
				(m) =>
					m.type === 'transport.send_tool_result' && (m.payload as { id: string }).id === 'tc-fail',
			);
			expect(errorResult).toBeDefined();
			expect((errorResult?.payload as { result: { error: string } }).result.error).toBe(
				'tool crashed',
			);
		});
	});

	describe('background subagent flow', () => {
		it('tool call → spawn → completion → when_idle result', async () => {
			const tools = new Map<string, ToolRoutingInfo>([
				[
					'ask_coder',
					{
						name: 'ask_coder',
						execution: 'background',
						configName: 'coder',
						lifetime: 'ephemeral',
					},
				],
			]);
			g = createActorGraph({ tools });
			await startAllActors(g);

			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onToolCallReceived?.([
				{ id: 'tc-bg', name: 'ask_coder', args: { task: 'review' } },
			]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-bg')).toBe(true));

			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-bg', workflowId: 'wf-1', result: 'all good' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.adapter.sendToolResult).toHaveBeenCalledWith(
					'tc-bg',
					'coder',
					{ result: 'all good' },
					'when_idle',
				),
			);
		});

		it('subagent failure delivers error result with when_idle', async () => {
			const tools = new Map<string, ToolRoutingInfo>([
				[
					'flaky_tool',
					{
						name: 'flaky_tool',
						execution: 'background',
						configName: 'flaky',
						lifetime: 'ephemeral',
					},
				],
			]);
			g = createActorGraph({ tools });
			await startAllActors(g);

			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onToolCallReceived?.([{ id: 'tc-err', name: 'flaky_tool', args: {} }]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-err')).toBe(true));

			g.runtime.send(
				createEnvelope(
					'subagent.failed',
					{ toolCallId: 'tc-err', workflowId: 'wf-1', error: 'timeout' },
					'subagent-supervisor',
				),
			);

			await vi.waitFor(() =>
				expect(g.adapter.sendToolResult).toHaveBeenCalledWith(
					'tc-err',
					'flaky',
					{ error: 'timeout' },
					'when_idle',
				),
			);
		});
	});

	describe('agent transfer flow', () => {
		it('transfer_to_agent → transport.transfer_session + ack', async () => {
			g.mainAgent.registerAgents([
				{ name: 'general', instructions: 'General agent', tools: [] },
				{ name: 'booking', instructions: 'Booking agent', tools: ['book_flight'] },
			]);
			g.mainAgent.setActiveAgent('general');

			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onToolCallReceived?.([
				{ id: 'tc-xfer', name: 'transfer_to_agent', args: { agent_name: 'booking' } },
			]);

			await vi.waitFor(() => expect(g.adapter.transferSession).toHaveBeenCalled());

			expect(g.mainAgent.activeAgentName).toBe('booking');

			const ack = g.allMessages.find(
				(m) =>
					m.type === 'transport.send_tool_result' &&
					(m.payload as { result: { status: string } }).result.status === 'transferred',
			);
			expect(ack).toBeDefined();
		});

		it('transfer to unknown agent sends failure', async () => {
			g.mainAgent.registerAgents([{ name: 'general', instructions: 'General agent', tools: [] }]);
			g.mainAgent.setActiveAgent('general');

			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onToolCallReceived?.([
				{ id: 'tc-bad', name: 'transfer_to_agent', args: { agent_name: 'nonexistent' } },
			]);

			await vi.waitFor(() => {
				const failure = g.allMessages.find((m) => m.type === 'agent.transfer_failed');
				expect(failure).toBeDefined();
			});
		});
	});

	describe('interaction flow', () => {
		it('subagent question notification reaches client', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.runtime.send(
				createEnvelope(
					'interaction.question_presented',
					{
						toolCallId: 'tc-q',
						workflowId: 'wf-1',
						question: 'Which environment?',
					},
					'client-gateway',
				),
			);

			await vi.waitFor(() => expect(g.client.send).toHaveBeenCalled());

			expect(g.client.messages[0]).toMatchObject({
				type: 'subagent.question',
				toolCallId: 'tc-q',
				question: 'Which environment?',
			});
		});
	});
});
