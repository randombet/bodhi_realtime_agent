// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	InlineToolExecutor,
	ToolRoutingInfo,
} from '../../src/runtime/actors/tool-router-actor.js';
import { ToolRouterActor } from '../../src/runtime/actors/tool-router-actor.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SentMessage {
	type: string;
	payload: unknown;
	to: string;
}

function setup(tools: Array<ToolRoutingInfo> = [], executor?: InlineToolExecutor) {
	const messages: SentMessage[] = [];
	const send = (type: string, payload: unknown, to: string) => {
		messages.push({ type, payload, to });
	};
	const toolRegistry = new Map<string, ToolRoutingInfo>();
	for (const t of tools) toolRegistry.set(t.name, t);

	const inlineExecutor: InlineToolExecutor = executor ?? {
		execute: vi.fn().mockResolvedValue({ result: { ok: true } }),
	};

	const actor = new ToolRouterActor(
		'tool-router',
		toolRegistry,
		inlineExecutor,
		send,
		'transport', // transportActorId
		'subagent-supervisor', // subagentSupervisorId
		'main-agent', // mainAgentActorId
	);

	return { actor, messages, inlineExecutor };
}

function toolCallEnvelope(
	calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
) {
	return createEnvelope('transport.tool_call_received', { calls }, 'tool-router');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolRouterActor', () => {
	// -- Inline tool dispatch -------------------------------------------------

	describe('inline tool dispatch', () => {
		it('routes unknown tools as inline', async () => {
			const { actor, messages } = setup();
			await actor.onMessage(
				toolCallEnvelope([{ id: 'tc-1', name: 'get_weather', args: { city: 'NYC' } }]),
			);

			// Should have sent tool.inline.completed and transport.send_tool_result
			const types = messages.map((m) => m.type);
			expect(types).toContain('tool.inline.completed');
			expect(types).toContain('transport.send_tool_result');
		});

		it('routes explicitly inline tools to executor', async () => {
			const { actor, messages, inlineExecutor } = setup([
				{ name: 'get_weather', execution: 'inline' },
			]);

			await actor.onMessage(
				toolCallEnvelope([{ id: 'tc-1', name: 'get_weather', args: { city: 'NYC' } }]),
			);

			expect(inlineExecutor.execute).toHaveBeenCalledWith({
				toolCallId: 'tc-1',
				toolName: 'get_weather',
				args: { city: 'NYC' },
			});
			expect(messages.find((m) => m.type === 'transport.send_tool_result')).toBeDefined();
		});

		it('handles inline tool execution failure', async () => {
			const executor: InlineToolExecutor = {
				execute: vi.fn().mockRejectedValue(new Error('execution failed')),
			};
			const { actor, messages } = setup([{ name: 'failing_tool', execution: 'inline' }], executor);

			await actor.onMessage(toolCallEnvelope([{ id: 'tc-1', name: 'failing_tool', args: {} }]));

			const failed = messages.find((m) => m.type === 'tool.inline.failed');
			expect(failed).toBeDefined();
			expect((failed?.payload as { error: string }).error).toBe('execution failed');
		});
	});

	// -- Background tool dispatch --------------------------------------------

	describe('background tool dispatch', () => {
		it('sends spawn_requested to subagent supervisor', async () => {
			const { actor, messages } = setup([
				{
					name: 'ask_coder',
					execution: 'background',
					configName: 'coder',
					lifetime: 'persistent_session',
				},
			]);

			await actor.onMessage(
				toolCallEnvelope([{ id: 'tc-1', name: 'ask_coder', args: { task: 'write code' } }]),
			);

			const spawn = messages.find((m) => m.type === 'subagent.spawn_requested');
			expect(spawn).toBeDefined();
			expect(spawn?.to).toBe('subagent-supervisor');
			expect(spawn?.payload).toEqual({
				toolCallId: 'tc-1',
				toolName: 'ask_coder',
				args: { task: 'write code' },
				configName: 'coder',
				lifetime: 'persistent_session',
			});
		});

		it('sends pending message when configured', async () => {
			const { actor, messages } = setup([
				{
					name: 'ask_coder',
					execution: 'background',
					configName: 'coder',
					pendingMessage: 'Working on it...',
				},
			]);

			await actor.onMessage(toolCallEnvelope([{ id: 'tc-1', name: 'ask_coder', args: {} }]));

			const pending = messages.find(
				(m) =>
					m.type === 'transport.send_tool_result' &&
					(m.payload as { result: { status: string } }).result.status === 'still_in_progress',
			);
			expect(pending).toBeDefined();
		});

		it('defaults to ephemeral lifetime when not specified', async () => {
			const { actor, messages } = setup([
				{ name: 'quick_task', execution: 'background', configName: 'quick' },
			]);

			await actor.onMessage(toolCallEnvelope([{ id: 'tc-1', name: 'quick_task', args: {} }]));

			const spawn = messages.find((m) => m.type === 'subagent.spawn_requested');
			expect((spawn?.payload as { lifetime: string }).lifetime).toBe('ephemeral');
		});
	});

	// -- Transfer tool dispatch ----------------------------------------------

	describe('transfer tool dispatch', () => {
		it('routes transfer_to_agent to main-agent actor', async () => {
			const { actor, messages } = setup();

			await actor.onMessage(
				toolCallEnvelope([
					{ id: 'tc-1', name: 'transfer_to_agent', args: { agent_name: 'booking' } },
				]),
			);

			const transfer = messages.find((m) => m.type === 'agent.transfer_requested');
			expect(transfer).toBeDefined();
			expect(transfer?.to).toBe('main-agent');
			expect((transfer?.payload as { toAgent: string }).toAgent).toBe('booking');
		});

		it('sends immediate acknowledgement for transfers', async () => {
			const { actor, messages } = setup();

			await actor.onMessage(
				toolCallEnvelope([
					{ id: 'tc-1', name: 'transfer_to_agent', args: { agent_name: 'booking' } },
				]),
			);

			const ack = messages.find(
				(m) =>
					m.type === 'transport.send_tool_result' &&
					(m.payload as { result: { status: string } }).result.status === 'transferred',
			);
			expect(ack).toBeDefined();
		});
	});

	// -- Cancellation --------------------------------------------------------

	describe('tool call cancellation', () => {
		it('forwards cancel to subagent supervisor', async () => {
			const { actor, messages } = setup();

			await actor.onMessage(
				createEnvelope('transport.tool_call_cancelled', { ids: ['tc-1', 'tc-2'] }, 'tool-router'),
			);

			const cancels = messages.filter((m) => m.type === 'subagent.cancel_requested');
			expect(cancels).toHaveLength(2);
			expect(cancels[0].to).toBe('subagent-supervisor');
		});
	});

	// -- Multiple tool calls in single message --------------------------------

	describe('multiple tool calls', () => {
		it('dispatches each call independently', async () => {
			const { actor, messages } = setup([
				{ name: 'bg_tool', execution: 'background', configName: 'bg' },
			]);

			await actor.onMessage(
				toolCallEnvelope([
					{ id: 'tc-1', name: 'get_weather', args: {} },
					{ id: 'tc-2', name: 'bg_tool', args: {} },
				]),
			);

			// One inline, one background
			expect(messages.filter((m) => m.type === 'tool.inline.completed')).toHaveLength(1);
			expect(messages.filter((m) => m.type === 'subagent.spawn_requested')).toHaveLength(1);
		});
	});
});
