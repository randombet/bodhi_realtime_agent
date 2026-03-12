// SPDX-License-Identifier: MIT

/**
 * End-to-end actor flow integration test — Gemini provider variant.
 *
 * Wires the full actor graph (TransportActor → SessionActor, ToolRouterActor,
 * SubagentSupervisorActor, MainAgentActor, ClientGatewayActor) using a mock
 * Gemini-like adapter and verifies canonical message flow.
 *
 * The canonical message sequences must match the OpenAI variant identically —
 * provider differences are isolated to the adapter, not the orchestration layer.
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
// Helpers — Gemini-like mock adapter
// ---------------------------------------------------------------------------

function createGeminiAdapter(): TransportAdapter {
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

/** Collects all messages sent to the client. */
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
	const adapter = createGeminiAdapter();
	const client = createClientRecorder();

	// Track messages sent via runtime.tell
	const allMessages: Array<{ type: string; payload: unknown; to: string }> = [];
	const sendFn = (type: string, payload: unknown, to: string) => {
		allMessages.push({ type, payload, to });
		runtime.tell(type, payload, to);
	};

	// Create actors
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
// Tests
// ---------------------------------------------------------------------------

describe('E2E Gemini actor flow', () => {
	let g: ReturnType<typeof createActorGraph>;

	beforeEach(async () => {
		g = createActorGraph();
		await startAllActors(g);
	});

	describe('session lifecycle', () => {
		it('adapter session_ready transitions session to active', async () => {
			g.adapter.onSessionReady?.();
			// Drain mailbox
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));
		});

		it('adapter closed transitions session to closed', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onClosed?.('server shutdown');
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('closed'));
		});
	});

	describe('inline tool call flow', () => {
		it('tool call → inline execution → tool result back to transport', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			// Simulate tool call from adapter
			g.adapter.onToolCallReceived?.([{ id: 'tc-1', name: 'get_weather', args: { city: 'NYC' } }]);

			// Wait for the tool result to arrive at the adapter
			await vi.waitFor(() => expect(g.adapter.sendToolResult).toHaveBeenCalled());

			// Verify canonical message sequence
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

			// Trigger background tool
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-bg', name: 'ask_coder', args: { task: 'review' } },
			]);

			// Wait for spawn to be processed
			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-bg')).toBe(true));

			// Simulate subagent completing
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-bg', workflowId: 'wf-1', result: 'all good' },
					'subagent-supervisor',
				),
			);

			// Wait for the tool result to arrive at the adapter
			await vi.waitFor(() =>
				expect(g.adapter.sendToolResult).toHaveBeenCalledWith(
					'tc-bg',
					'coder',
					{ result: 'all good' },
					'when_idle',
				),
			);
		});

		it('tool call → spawn → cancellation prevents result delivery', async () => {
			const tools = new Map<string, ToolRoutingInfo>([
				[
					'long_task',
					{
						name: 'long_task',
						execution: 'background',
						configName: 'worker',
						lifetime: 'ephemeral',
					},
				],
			]);
			g = createActorGraph({ tools });
			await startAllActors(g);

			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			g.adapter.onToolCallReceived?.([{ id: 'tc-cancel', name: 'long_task', args: {} }]);

			await vi.waitFor(() => expect(g.subagentSupervisor.hasWorkflow('tc-cancel')).toBe(true));

			// Cancel the tool call
			g.adapter.onToolCallCancelled?.(['tc-cancel']);

			await vi.waitFor(() =>
				expect(g.subagentSupervisor.getWorkflowState('tc-cancel')).toBeUndefined(),
			);

			// Late completion after cancel — should be ignored
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-cancel', workflowId: 'wf-1', result: 'late' },
					'subagent-supervisor',
				),
			);

			// Give mailbox time to drain
			await new Promise((r) => setTimeout(r, 50));

			// No tool result should have been sent to transport
			expect(g.adapter.sendToolResult).not.toHaveBeenCalled();
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

			// Trigger transfer via tool call
			g.adapter.onToolCallReceived?.([
				{ id: 'tc-xfer', name: 'transfer_to_agent', args: { agent_name: 'booking' } },
			]);

			// Wait for the transfer session command to reach adapter
			await vi.waitFor(() => expect(g.adapter.transferSession).toHaveBeenCalled());

			// Verify active agent changed
			expect(g.mainAgent.activeAgentName).toBe('booking');

			// Verify the ack was sent to transport
			const ack = g.allMessages.find(
				(m) =>
					m.type === 'transport.send_tool_result' &&
					(m.payload as { result: { status: string } }).result.status === 'transferred',
			);
			expect(ack).toBeDefined();
		});
	});

	describe('client gateway notifications', () => {
		it('subagent completion notification reaches client', async () => {
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

			// Send completion directly to client gateway
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-notify', workflowId: 'wf-1', result: 'done' },
					'client-gateway',
				),
			);

			await vi.waitFor(() => expect(g.client.send).toHaveBeenCalled());

			expect(g.client.messages[0]).toMatchObject({
				type: 'subagent.completion',
				toolCallId: 'tc-notify',
				status: 'success',
			});
		});

		it('deduplicates client notifications per toolCallId', async () => {
			g.adapter.onSessionReady?.();
			await vi.waitFor(() => expect(g.sessionActor.currentPhase).toBe('active'));

			// Send same completion twice
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-dup', workflowId: 'wf-1', result: 'done' },
					'client-gateway',
				),
			);
			g.runtime.send(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-dup', workflowId: 'wf-1', result: 'done again' },
					'client-gateway',
				),
			);

			await vi.waitFor(() => expect(g.client.send).toHaveBeenCalled());
			// Give second message time to be processed
			await new Promise((r) => setTimeout(r, 50));

			expect(g.client.messages.filter((m) => m.toolCallId === 'tc-dup')).toHaveLength(1);
		});
	});
});
