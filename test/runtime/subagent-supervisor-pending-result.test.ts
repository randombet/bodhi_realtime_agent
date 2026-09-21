import { describe, expect, it } from 'vitest';
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
	const actor = new SubagentSupervisorActor('subagent-supervisor', send, 'transport', 'session');
	return { actor, messages };
}

function spawnEnvelope(overrides: Record<string, unknown> = {}) {
	return createEnvelope(
		'subagent.spawn_requested',
		{
			toolCallId: 'tc-1',
			toolName: 'ask_sutando',
			args: {},
			configName: 'ask_sutando',
			lifetime: 'persistent_session',
			...overrides,
		},
		'subagent-supervisor',
	);
}

function completedEnvelope() {
	return createEnvelope(
		'subagent.completed',
		{ toolCallId: 'tc-1', workflowId: 'wf-1', result: 'done' },
		'subagent-supervisor',
	);
}

function failedEnvelope() {
	return createEnvelope(
		'subagent.failed',
		{ toolCallId: 'tc-1', workflowId: 'wf-1', error: 'boom' },
		'subagent-supervisor',
	);
}

function toolResults(messages: SentMessage[]): SentMessage[] {
	return messages.filter((m) => m.type === 'transport.send_tool_result');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubagentSupervisorActor pendingResultSent gate', () => {
	it('suppresses the terminal tool result on completion when pendingResultSent', async () => {
		const { actor, messages } = setup();
		await actor.onMessage(spawnEnvelope({ pendingResultSent: true }));
		await actor.onMessage(completedEnvelope());

		expect(toolResults(messages)).toHaveLength(0);
	});

	it('suppresses the terminal tool result on failure when pendingResultSent', async () => {
		const { actor, messages } = setup();
		await actor.onMessage(spawnEnvelope({ pendingResultSent: true }));
		await actor.onMessage(failedEnvelope());

		expect(toolResults(messages)).toHaveLength(0);
	});

	it('still sends the terminal tool result on completion without pendingResultSent', async () => {
		const { actor, messages } = setup();
		await actor.onMessage(spawnEnvelope());
		await actor.onMessage(completedEnvelope());

		const results = toolResults(messages);
		expect(results).toHaveLength(1);
		expect(results[0].payload).toMatchObject({ id: 'tc-1', result: { result: 'done' } });
	});

	it('still sends the terminal tool result on failure without pendingResultSent', async () => {
		const { actor, messages } = setup();
		await actor.onMessage(spawnEnvelope({ pendingResultSent: false }));
		await actor.onMessage(failedEnvelope());

		const results = toolResults(messages);
		expect(results).toHaveLength(1);
		expect(results[0].payload).toMatchObject({ id: 'tc-1', result: { error: 'boom' } });
	});

	it('workflow is cleaned up either way', async () => {
		const { actor } = setup();
		await actor.onMessage(spawnEnvelope({ pendingResultSent: true }));
		expect(actor.hasWorkflow('tc-1')).toBe(true);
		await actor.onMessage(completedEnvelope());
		expect(actor.hasWorkflow('tc-1')).toBe(false);
	});
});

describe('ToolRouterActor → supervisor pendingResultSent handoff', () => {
	it('router stamps pendingResultSent for pending-message background tools', async () => {
		const { ToolRouterActor } = await import('../../src/runtime/actors/tool-router-actor.js');
		const messages: SentMessage[] = [];
		const send = (type: string, payload: unknown, to: string) => {
			messages.push({ type, payload, to });
		};
		const registry = new Map([
			[
				'ask_sutando',
				{
					name: 'ask_sutando',
					execution: 'background' as const,
					pendingMessage: 'on it',
				},
			],
			['plain_bg', { name: 'plain_bg', execution: 'background' as const }],
		]);
		const router = new ToolRouterActor(
			'tool-router',
			registry,
			{ execute: async () => ({ result: {} }) },
			send,
			'transport',
			'subagent-supervisor',
			'main-agent',
		);

		await router.onMessage(
			createEnvelope(
				'transport.tool_call_received',
				{
					calls: [
						{ id: 'tc-a', name: 'ask_sutando', args: {} },
						{ id: 'tc-b', name: 'plain_bg', args: {} },
					],
				},
				'tool-router',
			),
		);

		const spawns = messages.filter((m) => m.type === 'subagent.spawn_requested');
		expect(spawns).toHaveLength(2);
		expect(spawns[0].payload).toMatchObject({ toolCallId: 'tc-a', pendingResultSent: true });
		expect(spawns[1].payload).toMatchObject({ toolCallId: 'tc-b', pendingResultSent: false });

		// The pending-message tool also got its immediate pending tool result.
		const pending = toolResults(messages).filter(
			(m) => (m.payload as { id?: string }).id === 'tc-a',
		);
		expect(pending).toHaveLength(1);
	});
});
