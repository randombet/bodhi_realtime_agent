// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent, OpenClawClient } from '../../examples/openclaw/lib/openclaw-client.js';
import { runOpenClawInteractiveSession } from '../../examples/openclaw/lib/openclaw-interactive-session.js';
import { SubagentSessionImpl } from '../../src/agent/subagent-session.js';

/**
 * Create a mock OpenClawClient with controllable event delivery.
 * Events are delivered by resolving per-runId promise chains.
 */
function createMockClient() {
	const eventResolvers: Array<{ runId: string; resolve: (event: ChatEvent) => void }> = [];

	const client = {
		chatSend: vi.fn(async (_sessionKey: string, _message: string) => ({
			runId: `run-${Math.random().toString(36).slice(2, 6)}`,
		})),
		chatAbort: vi.fn(async (_runId: string) => {}),
		nextChatEvent: vi.fn(
			(runId: string) =>
				new Promise<ChatEvent>((resolve) => {
					eventResolvers.push({ runId, resolve });
				}),
		),
		sessionKey: vi.fn((sid: string) => `bodhi:${sid}`),
	} as unknown as OpenClawClient;

	/** Deliver a ChatEvent to the next waiting nextChatEvent() for the given runId. */
	function deliverEvent(runId: string, event: ChatEvent) {
		const idx = eventResolvers.findIndex((r) => r.runId === runId);
		if (idx >= 0) {
			const { resolve } = eventResolvers[idx];
			eventResolvers.splice(idx, 1);
			resolve(event);
		}
	}

	/** Wait for nextChatEvent() to be called for a given runId. */
	async function waitForEventRequest(runId: string, timeoutMs = 500): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (eventResolvers.some((r) => r.runId === runId)) return;
			await new Promise((r) => setTimeout(r, 5));
		}
		throw new Error(`Timed out waiting for nextChatEvent(${runId})`);
	}

	return { client, deliverEvent, waitForEventRequest };
}

describe('runOpenClawInteractiveSession', () => {
	it('returns SubagentResult when OpenClaw completes (finalDisposition=completed)', async () => {
		const { client, deliverEvent, waitForEventRequest } = createMockClient();
		const session = new SubagentSessionImpl('tc-1');

		vi.mocked(client.chatSend).mockResolvedValueOnce({ runId: 'run-1' });

		const resultPromise = runOpenClawInteractiveSession(client, session, 'bodhi:s1', 'Write code');

		await waitForEventRequest('run-1');
		deliverEvent('run-1', {
			source: 'chat',
			runId: 'run-1',
			state: 'delta',
			text: 'Working...',
		});

		await waitForEventRequest('run-1');
		deliverEvent('run-1', {
			source: 'chat',
			runId: 'run-1',
			state: 'final',
			text: 'Done! Code written.',
			finalDisposition: 'completed',
			stopReason: 'stop',
		});

		const result = await resultPromise;
		expect(result.text).toBe('Done! Code written.');
	});

	it('relays needs_input to user and sends user response back to OpenClaw', async () => {
		const { client, deliverEvent, waitForEventRequest } = createMockClient();
		const session = new SubagentSessionImpl('tc-1');

		vi.mocked(client.chatSend).mockResolvedValueOnce({ runId: 'run-1' });
		vi.mocked(client.chatSend).mockResolvedValueOnce({ runId: 'run-2' });

		const resultPromise = runOpenClawInteractiveSession(client, session, 'bodhi:s1', 'Edit file');

		// OpenClaw asks for clarification
		await waitForEventRequest('run-1');
		deliverEvent('run-1', {
			source: 'chat',
			runId: 'run-1',
			state: 'final',
			text: 'Which file should I edit?',
			finalDisposition: 'needs_input',
			stopReason: 'needs_input',
		});

		// Wait for the session to transition to waiting_for_input
		await new Promise((r) => setTimeout(r, 20));
		expect(session.state).toBe('waiting_for_input');

		// User responds
		session.sendToSubagent('edit main.ts');

		// Wait for the second chatSend to fire
		await new Promise((r) => setTimeout(r, 20));
		expect(client.chatSend).toHaveBeenCalledTimes(2);
		expect(client.chatSend).toHaveBeenLastCalledWith('bodhi:s1', 'edit main.ts');

		// OpenClaw completes
		await waitForEventRequest('run-2');
		deliverEvent('run-2', {
			source: 'chat',
			runId: 'run-2',
			state: 'final',
			text: 'Edited main.ts successfully.',
			finalDisposition: 'completed',
			stopReason: 'stop',
		});

		const result = await resultPromise;
		expect(result.text).toBe('Edited main.ts successfully.');
	});

	it('throws on protocol_error finalDisposition', async () => {
		const { client, deliverEvent, waitForEventRequest } = createMockClient();
		const session = new SubagentSessionImpl('tc-1');

		vi.mocked(client.chatSend).mockResolvedValueOnce({ runId: 'run-1' });

		const resultPromise = runOpenClawInteractiveSession(
			client,
			session,
			'bodhi:s1',
			'Do something',
		);

		await waitForEventRequest('run-1');
		deliverEvent('run-1', {
			source: 'chat',
			runId: 'run-1',
			state: 'final',
			text: 'Some text',
			finalDisposition: 'protocol_error',
		});

		await expect(resultPromise).rejects.toThrow('missing disposition metadata');
	});

	it('throws on error state from OpenClaw', async () => {
		const { client, deliverEvent, waitForEventRequest } = createMockClient();
		const session = new SubagentSessionImpl('tc-1');

		vi.mocked(client.chatSend).mockResolvedValueOnce({ runId: 'run-1' });

		const resultPromise = runOpenClawInteractiveSession(client, session, 'bodhi:s1', 'Fail');

		await waitForEventRequest('run-1');
		deliverEvent('run-1', {
			source: 'chat',
			runId: 'run-1',
			state: 'error',
			error: 'Internal server error',
		});

		await expect(resultPromise).rejects.toThrow('OpenClaw run error');
	});

	it('aborts OpenClaw run on session cancellation', async () => {
		const { client } = createMockClient();
		const session = new SubagentSessionImpl('tc-1');

		vi.mocked(client.chatSend).mockResolvedValueOnce({ runId: 'run-1' });
		vi.mocked(client.chatAbort).mockResolvedValue(undefined);

		const resultPromise = runOpenClawInteractiveSession(client, session, 'bodhi:s1', 'Long task');

		// Wait for the race to be entered
		await new Promise((r) => setTimeout(r, 20));

		// Cancel the session
		session.cancel();

		await expect(resultPromise).rejects.toThrow('cancelled');
		expect(client.chatAbort).toHaveBeenCalledWith('run-1');
	});

	it('does NOT call session.complete() or session.cancel() (caller owns terminal transitions)', async () => {
		const { client, deliverEvent, waitForEventRequest } = createMockClient();
		const session = new SubagentSessionImpl('tc-1');

		vi.mocked(client.chatSend).mockResolvedValueOnce({ runId: 'run-1' });

		const resultPromise = runOpenClawInteractiveSession(client, session, 'bodhi:s1', 'Quick task');

		await waitForEventRequest('run-1');
		deliverEvent('run-1', {
			source: 'chat',
			runId: 'run-1',
			state: 'final',
			text: 'Done',
			finalDisposition: 'completed',
			stopReason: 'stop',
		});

		await resultPromise;

		// Session should still be in 'running' state — relay doesn't own terminal transitions
		expect(session.state).toBe('running');
	});
});
