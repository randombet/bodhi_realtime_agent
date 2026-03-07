// SPDX-License-Identifier: MIT

/**
 * Integration tests for the V2 interactive subagent system.
 * Tests the full flow across SubagentSession, InteractionModeManager,
 * and the ask_user tool without requiring a real LLM.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	CancelledError,
	InputTimeoutError,
	SessionCompletedError,
	SubagentSessionImpl,
} from '../../src/agent/subagent-session.js';
import type { SubagentMessage } from '../../src/agent/subagent-session.js';
import { BackgroundNotificationQueue } from '../../src/core/background-notification-queue.js';
import { InteractionModeManager } from '../../src/core/interaction-mode.js';
import { TranscriptManager } from '../../src/core/transcript-manager.js';
import type { TranscriptSink } from '../../src/core/transcript-manager.js';

function createSink(): TranscriptSink {
	return {
		sendToClient: vi.fn(),
		addUserMessage: vi.fn(),
		addAssistantMessage: vi.fn(),
	};
}

describe('Interactive Subagent Integration', () => {
	it('full flow: question → user response → result', async () => {
		const session = new SubagentSessionImpl('tc-1');
		const messages: SubagentMessage[] = [];
		session.onMessage((msg) => messages.push(msg));

		// 1. Subagent asks a question
		session.sendToUser({ type: 'question', text: 'What language?', blocking: true });
		expect(session.state).toBe('waiting_for_input');
		expect(messages).toHaveLength(1);
		expect(messages[0].text).toBe('What language?');

		// 2. Start waiting for input
		const inputPromise = session.waitForInput(5000);

		// 3. User responds
		session.sendToSubagent('TypeScript');
		const response = await inputPromise;
		expect(response).toBe('TypeScript');
		expect(session.state).toBe('running');

		// 4. Subagent delivers result
		session.sendToUser({ type: 'result', text: 'Code written in TypeScript' });
		session.complete({ text: 'Done' });
		expect(session.state).toBe('completed');
	});

	it('timeout: waitForInput rejects after timeout, session eventually cancels', async () => {
		vi.useFakeTimers();
		try {
			const session = new SubagentSessionImpl('tc-1', {
				name: 'test',
				instructions: '',
				tools: {},
				interactive: true,
				inputTimeout: 50,
				maxInputRetries: 2,
			});

			session.sendToUser({ type: 'question', text: 'Hello?', blocking: true });
			const p = session.waitForInput();

			vi.advanceTimersByTime(51);
			await expect(p).rejects.toBeInstanceOf(InputTimeoutError);
		} finally {
			vi.useRealTimers();
		}
	});

	it('cancellation: cancel rejects all pending Promises', async () => {
		const session = new SubagentSessionImpl('tc-1');

		session.sendToUser({ type: 'question', text: 'Q?', blocking: true });
		const inputPromise = session.waitForInput(60_000);

		const session2 = new SubagentSessionImpl('tc-2');
		const cancelPromise = session2.cancellation();

		session.cancel();
		session2.cancel();

		await expect(inputPromise).rejects.toBeInstanceOf(CancelledError);
		await expect(cancelPromise).rejects.toBeInstanceOf(CancelledError);
	});

	it('concurrent: FIFO queue promotes second subagent after first completes', async () => {
		const mode = new InteractionModeManager();

		// First subagent activates immediately
		await mode.activate('tc-1');
		expect(mode.getActiveToolCallId()).toBe('tc-1');

		// Second subagent is queued
		let promoted = false;
		const p = mode.activate('tc-2').then(() => {
			promoted = true;
		});
		expect(mode.queueLength).toBe(1);
		expect(promoted).toBe(false);

		// First completes → second is promoted
		mode.deactivate('tc-1');
		await p;
		expect(promoted).toBe(true);
		expect(mode.getActiveToolCallId()).toBe('tc-2');

		// Second completes → back to main_agent
		mode.deactivate('tc-2');
		expect(mode.getMode()).toEqual({ type: 'main_agent' });
	});

	it('transcript routing: onInputFinalized relays to subagent session', () => {
		const sink = createSink();
		const tm = new TranscriptManager(sink);
		const session = new SubagentSessionImpl('tc-1');
		const mode = new InteractionModeManager();

		// Activate interaction mode
		mode.activate('tc-1');

		// Wire up transcript relay
		tm.onInputFinalized = (text) => {
			if (mode.isSubagentActive() && session.state === 'waiting_for_input') {
				session.sendToSubagent(text);
			}
		};

		// Subagent asks question
		session.sendToUser({ type: 'question', text: 'Which file?', blocking: true });
		expect(session.state).toBe('waiting_for_input');

		// Create pending input listener
		const inputPromise = session.nextUserInput();

		// User speaks → transcript accumulates → flushInput fires onInputFinalized
		tm.handleInput('main.ts');
		tm.flushInput();

		// Verify relay worked
		return expect(inputPromise).resolves.toBe('main.ts');
	});

	it('transcript routing via flush() also fires onInputFinalized', () => {
		const sink = createSink();
		const tm = new TranscriptManager(sink);
		const session = new SubagentSessionImpl('tc-1');

		session.sendToUser({ type: 'question', text: 'Q?', blocking: true });
		const inputPromise = session.nextUserInput();

		tm.onInputFinalized = (text) => {
			if (session.state === 'waiting_for_input') {
				session.sendToSubagent(text);
			}
		};

		tm.handleInput('answer');
		tm.handleOutput('response');
		tm.flush();

		return expect(inputPromise).resolves.toBe('answer');
	});

	it('priority notification: high-priority delivered immediately when idle', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn(), false);

		// Idle — no audio received
		q.sendOrQueue([{ role: 'user', parts: [{ text: 'Urgent question' }] }], true, {
			priority: 'high',
		});

		expect(sendContent).toHaveBeenCalledTimes(1);
	});

	it('session completed while waiting for input rejects with SessionCompletedError', async () => {
		const session = new SubagentSessionImpl('tc-1');

		session.sendToUser({ type: 'question', text: 'Q?', blocking: true });
		const p = session.waitForInput(60_000);

		session.complete({ text: 'result' });

		await expect(p).rejects.toBeInstanceOf(SessionCompletedError);
		expect(session.state).toBe('completed');
	});
});
