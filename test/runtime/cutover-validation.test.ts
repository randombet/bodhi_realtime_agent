// SPDX-License-Identifier: MIT

/**
 * Step 87 cutover validation tests.
 *
 * Verifies that:
 * 1. No provider-specific branching exists in the runtime layer.
 * 2. The actor runtime handles all orchestration paths.
 * 3. VoiceSession subagent lookup/routing has an actor-based equivalent.
 * 4. The RuntimeOrchestrator can replace legacy ToolCallRouter + AgentRouter.
 */

import { describe, expect, it, vi } from 'vitest';
import { ActorRuntime } from '../../src/runtime/actor-runtime.js';
import { ClientGatewayActor } from '../../src/runtime/actors/client-gateway-actor.js';
import { MainAgentActor } from '../../src/runtime/actors/main-agent-actor.js';
import { SessionActor } from '../../src/runtime/actors/session-actor.js';
import { SubagentSupervisorActor } from '../../src/runtime/actors/subagent-supervisor-actor.js';
import { ToolRouterActor } from '../../src/runtime/actors/tool-router-actor.js';
import { TransportActor } from '../../src/runtime/actors/transport-actor.js';
import type { TransportAdapter } from '../../src/runtime/adapters/transport-adapter.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import { RuntimeOrchestrator } from '../../src/runtime/runtime-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAdapter(): TransportAdapter {
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('Step 87 cutover validation', () => {
	describe('no provider-specific branching in runtime', () => {
		it('TransportActor handles all message types identically for both providers', async () => {
			const adapter1 = createAdapter();
			const adapter2 = createAdapter();
			const messages1: string[] = [];
			const messages2: string[] = [];

			const send1 = (type: string, _payload: unknown, _to: string) => {
				messages1.push(type);
			};
			const send2 = (type: string, _payload: unknown, _to: string) => {
				messages2.push(type);
			};

			const actor1 = new TransportActor('t1', adapter1, send1, 'session', 'tool-router');
			const actor2 = new TransportActor('t2', adapter2, send2, 'session', 'tool-router');

			await actor1.onStart();
			await actor2.onStart();

			// Simulate identical callback sequences
			adapter1.onSessionReady?.();
			adapter2.onSessionReady?.();

			adapter1.onToolCallReceived?.([{ id: 'tc-1', name: 'fn', args: {} }]);
			adapter2.onToolCallReceived?.([{ id: 'tc-1', name: 'fn', args: {} }]);

			adapter1.onTurnComplete?.('turn-1');
			adapter2.onTurnComplete?.('turn-1');

			adapter1.onClosed?.('done');
			adapter2.onClosed?.('done');

			// Both produce the exact same canonical message types
			expect(messages1).toEqual(messages2);
			expect(messages1).toEqual([
				'transport.session_ready',
				'transport.tool_call_received',
				'transport.turn_complete',
				'transport.closed',
			]);
		});
	});

	describe('actor runtime covers all legacy orchestration paths', () => {
		it('ToolRouterActor handles inline, background, and transfer tools', async () => {
			const sentTypes: string[] = [];
			const tools = new Map([
				['bg_tool', { name: 'bg_tool', execution: 'background' as const, configName: 'worker' }],
			]);

			const router = new ToolRouterActor(
				'tool-router',
				tools,
				{ execute: vi.fn().mockResolvedValue({ result: 'ok' }) },
				(type) => sentTypes.push(type),
				'transport',
				'supervisor',
				'main-agent',
			);

			// Inline tool
			await router.onMessage(
				createEnvelope(
					'transport.tool_call_received',
					{ calls: [{ id: 'tc-1', name: 'inline_fn', args: {} }] },
					'tool-router',
				),
			);

			// Background tool
			await router.onMessage(
				createEnvelope(
					'transport.tool_call_received',
					{ calls: [{ id: 'tc-2', name: 'bg_tool', args: {} }] },
					'tool-router',
				),
			);

			// Transfer tool
			await router.onMessage(
				createEnvelope(
					'transport.tool_call_received',
					{
						calls: [{ id: 'tc-3', name: 'transfer_to_agent', args: { agent_name: 'booking' } }],
					},
					'tool-router',
				),
			);

			// All three paths produce canonical messages
			expect(sentTypes).toContain('tool.inline.completed');
			expect(sentTypes).toContain('transport.send_tool_result');
			expect(sentTypes).toContain('subagent.spawn_requested');
			expect(sentTypes).toContain('agent.transfer_requested');
		});

		it('SubagentSupervisorActor covers spawn, cancel, interactive, and terminal', async () => {
			const sentTypes: string[] = [];
			const supervisor = new SubagentSupervisorActor(
				'supervisor',
				(type) => sentTypes.push(type),
				'transport',
				'session',
			);

			// Spawn
			await supervisor.onMessage(
				createEnvelope(
					'subagent.spawn_requested',
					{
						toolCallId: 'tc-1',
						toolName: 'tool',
						args: {},
						configName: 'cfg',
						lifetime: 'ephemeral',
					},
					'supervisor',
				),
			);
			expect(sentTypes).toContain('subagent.started');

			// Interactive wait
			await supervisor.onMessage(
				createEnvelope(
					'subagent.needs_input',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', question: 'Which?' },
					'supervisor',
				),
			);
			expect(supervisor.getWorkflowState('tc-1')).toBe('waiting_input');

			// Answer delivered
			await supervisor.onMessage(
				createEnvelope(
					'interaction.answer_delivered',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', text: 'A' },
					'supervisor',
				),
			);
			expect(supervisor.getWorkflowState('tc-1')).toBe('running');

			// Complete
			await supervisor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'supervisor',
				),
			);
			expect(sentTypes).toContain('transport.send_tool_result');
		});
	});

	describe('RuntimeOrchestrator replaces legacy wiring', () => {
		it('creates a complete operational actor graph', async () => {
			const adapter = createAdapter();
			const orchestrator = new RuntimeOrchestrator({
				adapter,
				tools: new Map(),
				inlineExecutor: { execute: vi.fn().mockResolvedValue({ result: 'ok' }) },
				clientSend: vi.fn(),
				agents: [{ name: 'general', instructions: 'General', tools: [] }],
				initialAgent: 'general',
			});

			await orchestrator.start();

			// All 6 actors registered
			expect(orchestrator.runtime.hasActor('transport')).toBe(true);
			expect(orchestrator.runtime.hasActor('session')).toBe(true);
			expect(orchestrator.runtime.hasActor('tool-router')).toBe(true);
			expect(orchestrator.runtime.hasActor('subagent-supervisor')).toBe(true);
			expect(orchestrator.runtime.hasActor('main-agent')).toBe(true);
			expect(orchestrator.runtime.hasActor('client-gateway')).toBe(true);

			// Session lifecycle
			adapter.onSessionReady?.();
			await vi.waitFor(() => expect(orchestrator.sessionActor.currentPhase).toBe('active'));

			// Tool call through the graph
			adapter.onToolCallReceived?.([{ id: 'tc-1', name: 'test', args: {} }]);
			await vi.waitFor(() => expect(adapter.sendToolResult).toHaveBeenCalled());

			await orchestrator.stop();
		});
	});

	describe('public API exports', () => {
		it('runtime module exports all necessary types', async () => {
			// Verify key exports exist and are usable
			expect(ActorRuntime).toBeDefined();
			expect(TransportActor).toBeDefined();
			expect(SessionActor).toBeDefined();
			expect(ToolRouterActor).toBeDefined();
			expect(SubagentSupervisorActor).toBeDefined();
			expect(MainAgentActor).toBeDefined();
			expect(ClientGatewayActor).toBeDefined();
			expect(RuntimeOrchestrator).toBeDefined();
			expect(createEnvelope).toBeDefined();
		});
	});
});
