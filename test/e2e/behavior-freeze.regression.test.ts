// SPDX-License-Identifier: MIT

/**
 * Behavior-freeze regression tests.
 *
 * These tests verify that user-facing response semantics remain stable
 * during internal V4 actor runtime migration. Each test captures a
 * representative behavior (tool result delivery, notification format,
 * completion contract) and asserts against a baseline snapshot.
 *
 * If any of these tests break, it signals unintended user-visible
 * behavior drift that must be investigated before merging.
 */

import { describe, expect, it, vi } from 'vitest';
import { ClientGatewayActor } from '../../src/runtime/actors/client-gateway-actor.js';
import { SubagentSupervisorActor } from '../../src/runtime/actors/subagent-supervisor-actor.js';
import { ToolRouterActor } from '../../src/runtime/actors/tool-router-actor.js';
import type {
	InlineToolExecutor,
	ToolRoutingInfo,
} from '../../src/runtime/actors/tool-router-actor.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import { buildSuccessCompletion } from '../../src/runtime/subagent-completion.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SentMessage {
	type: string;
	payload: unknown;
	to: string;
}

function createSender() {
	const messages: SentMessage[] = [];
	const send = (type: string, payload: unknown, to: string) => {
		messages.push({ type, payload, to });
	};
	return { send, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Behavior-freeze regression', () => {
	describe('inline tool result format', () => {
		it('produces stable tool result envelope shape', async () => {
			const { send, messages } = createSender();
			const executor: InlineToolExecutor = {
				execute: vi.fn().mockResolvedValue({ result: { weather: 'sunny', temp: 72 } }),
			};
			const router = new ToolRouterActor(
				'tool-router',
				new Map<string, ToolRoutingInfo>(),
				executor,
				send,
				'transport',
				'subagent-supervisor',
				'main-agent',
			);

			await router.onMessage(
				createEnvelope(
					'transport.tool_call_received',
					{ calls: [{ id: 'tc-1', name: 'get_weather', args: { city: 'NYC' } }] },
					'tool-router',
				),
			);

			const toolResult = messages.find(
				(m) => m.type === 'transport.send_tool_result' && m.to === 'transport',
			);
			expect(toolResult).toBeDefined();

			// Snapshot: the shape of a tool result must remain stable
			const payload = toolResult?.payload as Record<string, unknown>;
			expect(payload).toMatchObject({
				id: 'tc-1',
				name: 'get_weather',
				result: { weather: 'sunny', temp: 72 },
				scheduling: 'immediate',
			});
		});
	});

	describe('background tool spawn format', () => {
		it('produces stable spawn_requested envelope shape', async () => {
			const { send, messages } = createSender();
			const tools = new Map<string, ToolRoutingInfo>([
				[
					'ask_coder',
					{
						name: 'ask_coder',
						execution: 'background',
						configName: 'coder',
						lifetime: 'persistent_session',
					},
				],
			]);
			const executor: InlineToolExecutor = { execute: vi.fn() };
			const router = new ToolRouterActor(
				'tool-router',
				tools,
				executor,
				send,
				'transport',
				'subagent-supervisor',
				'main-agent',
			);

			await router.onMessage(
				createEnvelope(
					'transport.tool_call_received',
					{ calls: [{ id: 'tc-1', name: 'ask_coder', args: { task: 'write code' } }] },
					'tool-router',
				),
			);

			const spawn = messages.find((m) => m.type === 'subagent.spawn_requested');
			expect(spawn).toBeDefined();

			// Snapshot: spawn payload must match this shape
			expect(spawn?.payload).toEqual({
				toolCallId: 'tc-1',
				toolName: 'ask_coder',
				args: { task: 'write code' },
				configName: 'coder',
				lifetime: 'persistent_session',
			});
		});
	});

	describe('subagent completion notification format', () => {
		it('produces stable completion notification to client', async () => {
			const { send } = createSender();
			const clientMessages: Record<string, unknown>[] = [];
			const clientSend = vi.fn((msg: Record<string, unknown>) => clientMessages.push(msg));
			const gateway = new ClientGatewayActor('client-gateway', send, clientSend, 'session');

			const completion = buildSuccessCompletion({
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				result: 'Code review complete',
				configName: 'reviewer',
				durationMs: 5000,
				lifetime: 'ephemeral',
				stepCount: 3,
			});

			await gateway.onMessage(
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

			// Snapshot: client notification shape
			expect(clientMessages[0]).toEqual({
				type: 'subagent.completion',
				toolCallId: 'tc-1',
				status: 'success',
				summaryText: 'Code review complete',
				uiPayload: undefined,
				artifacts: undefined,
				metadata: {
					configName: 'reviewer',
					durationMs: 5000,
					stepCount: 3,
					lifetime: 'ephemeral',
				},
			});
		});
	});

	describe('subagent workflow state machine invariants', () => {
		it('supervisor produces exactly one terminal notification per workflow', async () => {
			const { send, messages } = createSender();
			const supervisor = new SubagentSupervisorActor(
				'subagent-supervisor',
				send,
				'transport',
				'session',
			);

			// Spawn a workflow
			await supervisor.onMessage(
				createEnvelope(
					'subagent.spawn_requested',
					{
						toolCallId: 'tc-1',
						toolName: 'coder',
						args: {},
						configName: 'coder',
						lifetime: 'ephemeral',
					},
					'subagent-supervisor',
				),
			);
			messages.length = 0;

			// Complete it
			await supervisor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
					'subagent-supervisor',
				),
			);

			// Try to complete again — must be ignored
			await supervisor.onMessage(
				createEnvelope(
					'subagent.completed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done again' },
					'subagent-supervisor',
				),
			);

			// Try to fail after completion — must be ignored
			await supervisor.onMessage(
				createEnvelope(
					'subagent.failed',
					{ toolCallId: 'tc-1', workflowId: 'wf-1', error: 'late' },
					'subagent-supervisor',
				),
			);

			// Exactly one terminal event (the first completion)
			const terminals = messages.filter((m) => m.type === 'transport.send_tool_result');
			expect(terminals).toHaveLength(1);
		});
	});

	describe('transfer acknowledgement format', () => {
		it('produces stable transfer acknowledgement', async () => {
			const { send, messages } = createSender();
			const executor: InlineToolExecutor = { execute: vi.fn() };
			const router = new ToolRouterActor(
				'tool-router',
				new Map<string, ToolRoutingInfo>(),
				executor,
				send,
				'transport',
				'subagent-supervisor',
				'main-agent',
			);

			await router.onMessage(
				createEnvelope(
					'transport.tool_call_received',
					{ calls: [{ id: 'tc-1', name: 'transfer_to_agent', args: { agent_name: 'booking' } }] },
					'tool-router',
				),
			);

			const ack = messages.find(
				(m) =>
					m.type === 'transport.send_tool_result' &&
					(m.payload as { result: { status: string } }).result.status === 'transferred',
			);
			expect(ack).toBeDefined();

			// Snapshot: transfer ack shape
			expect(ack?.payload).toMatchObject({
				id: 'tc-1',
				name: 'transfer_to_agent',
				result: { status: 'transferred' },
				scheduling: 'immediate',
			});
		});
	});
});
