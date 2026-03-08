// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import {
	CancelledError,
	InputTimeoutError,
	SessionCompletedError,
	SubagentSessionImpl,
} from '../../src/agent/subagent-session.js';
import type { SubagentMessage, SubagentSessionState } from '../../src/agent/subagent-session.js';

function createSession(opts?: { inputTimeout?: number }) {
	return new SubagentSessionImpl(
		'tool-1',
		opts ? { name: 'test', instructions: '', tools: {}, ...opts } : undefined,
	);
}

describe('SubagentSession', () => {
	// -- State transitions --------------------------------------------------

	it('starts in running state', () => {
		const s = createSession();
		expect(s.state).toBe('running');
	});

	it('transitions running → waiting_for_input → running → completed', () => {
		const s = createSession();
		const states: SubagentSessionState[] = [];
		s.onStateChange((n) => states.push(n));

		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		expect(s.state).toBe('waiting_for_input');

		s.sendToSubagent('answer');
		expect(s.state).toBe('running');

		s.complete({ text: 'done' });
		expect(s.state).toBe('completed');

		expect(states).toEqual(['waiting_for_input', 'running', 'completed']);
	});

	it('fires onStateChange handlers with old and new state', () => {
		const s = createSession();
		const transitions: Array<[SubagentSessionState, SubagentSessionState]> = [];
		s.onStateChange((n, o) => transitions.push([n, o]));

		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		s.sendToSubagent('a');

		expect(transitions).toEqual([
			['waiting_for_input', 'running'],
			['running', 'waiting_for_input'],
		]);
	});

	// -- sendToUser ---------------------------------------------------------

	it('sendToUser notifies message handlers', () => {
		const s = createSession();
		const msgs: SubagentMessage[] = [];
		s.onMessage((m) => msgs.push(m));

		s.sendToUser({ type: 'progress', text: 'working...' });
		expect(msgs).toHaveLength(1);
		expect(msgs[0].text).toBe('working...');
	});

	it('sendToUser with blocking=false does not transition state', () => {
		const s = createSession();
		s.sendToUser({ type: 'progress', text: 'status' });
		expect(s.state).toBe('running');
	});

	it('sendToUser throws when completed', () => {
		const s = createSession();
		s.complete({});
		expect(() => s.sendToUser({ type: 'progress', text: 'x' })).toThrow(
			"Cannot sendToUser in state 'completed'",
		);
	});

	it('sendToUser throws when cancelled', () => {
		const s = createSession();
		s.cancel();
		expect(() => s.sendToUser({ type: 'progress', text: 'x' })).toThrow(
			"Cannot sendToUser in state 'cancelled'",
		);
	});

	// -- sendToSubagent -----------------------------------------------------

	it('sendToSubagent throws when not in waiting_for_input', () => {
		const s = createSession();
		expect(() => s.sendToSubagent('text')).toThrow("Cannot sendToSubagent in state 'running'");
	});

	it('sendToSubagent resolves pending waitForInput()', async () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		const p = s.waitForInput(5000);
		s.sendToSubagent('the answer');
		await expect(p).resolves.toBe('the answer');
	});

	it('sendToSubagent resolves pending nextUserInput()', async () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		const p = s.nextUserInput();
		s.sendToSubagent('input text');
		await expect(p).resolves.toBe('input text');
	});

	// -- waitForInput -------------------------------------------------------

	it('waitForInput rejects on timeout with InputTimeoutError', async () => {
		vi.useFakeTimers();
		try {
			const s = createSession();
			s.sendToUser({ type: 'question', text: 'q?', blocking: true });
			const p = s.waitForInput(50);

			vi.advanceTimersByTime(51);
			await expect(p).rejects.toBeInstanceOf(InputTimeoutError);
		} finally {
			vi.useRealTimers();
		}
	});

	it('waitForInput uses config.inputTimeout as default', async () => {
		vi.useFakeTimers();
		try {
			const s = createSession({ inputTimeout: 30 });
			s.sendToUser({ type: 'question', text: 'q?', blocking: true });
			const p = s.waitForInput();

			vi.advanceTimersByTime(31);
			await expect(p).rejects.toBeInstanceOf(InputTimeoutError);
		} finally {
			vi.useRealTimers();
		}
	});

	it('waitForInput rejects on cancel with CancelledError', async () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		const p = s.waitForInput(60_000);
		s.cancel();
		await expect(p).rejects.toBeInstanceOf(CancelledError);
	});

	it('waitForInput rejects immediately if already cancelled', async () => {
		const s = createSession();
		s.cancel();
		await expect(s.waitForInput()).rejects.toBeInstanceOf(CancelledError);
	});

	// -- nextUserInput ------------------------------------------------------

	it('nextUserInput resolves on sendToSubagent', async () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		const p = s.nextUserInput();
		s.sendToSubagent('response');
		await expect(p).resolves.toBe('response');
	});

	// -- cancellation -------------------------------------------------------

	it('cancellation() rejects when cancel() is called', async () => {
		const s = createSession();
		const p = s.cancellation();
		s.cancel();
		await expect(p).rejects.toBeInstanceOf(CancelledError);
	});

	it('cancellation() rejects immediately if already cancelled', async () => {
		const s = createSession();
		s.cancel();
		await expect(s.cancellation()).rejects.toBeInstanceOf(CancelledError);
	});

	// -- cancel (idempotent) ------------------------------------------------

	it('cancel() is idempotent — no double-reject', () => {
		const s = createSession();
		s.cancel();
		// Second call should not throw
		expect(() => s.cancel()).not.toThrow();
		expect(s.state).toBe('cancelled');
	});

	it('cancel() rejects all pending Promises', async () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		const pInput = s.waitForInput(60_000);
		// Create a new session for cancellation promise (can't have two pending inputs)
		const s2 = createSession();
		const pCancel = s2.cancellation();

		s.cancel();
		s2.cancel();

		await expect(pInput).rejects.toBeInstanceOf(CancelledError);
		await expect(pCancel).rejects.toBeInstanceOf(CancelledError);
	});

	// -- complete -----------------------------------------------------------

	it('complete() transitions to completed and rejects pending', async () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		const p = s.waitForInput(60_000);
		s.complete({ text: 'result' });

		expect(s.state).toBe('completed');
		await expect(p).rejects.toBeInstanceOf(SessionCompletedError);
	});

	it('complete() is idempotent for terminal states', () => {
		const s = createSession();
		s.complete({});
		expect(() => s.complete({})).not.toThrow();
		expect(s.state).toBe('completed');
	});

	// -- Concurrent pending guard -------------------------------------------

	it('throws when two waitForInput() calls are pending simultaneously', () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		s.waitForInput(60_000); // first — pending
		expect(() => s.waitForInput(60_000)).toThrow(
			'Only one pending waitForInput()/nextUserInput() at a time',
		);
	});

	it('throws when waitForInput() and nextUserInput() are pending simultaneously', () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		s.waitForInput(60_000);
		expect(() => s.nextUserInput()).toThrow(
			'Only one pending waitForInput()/nextUserInput() at a time',
		);
	});

	// -- trySendToSubagent --------------------------------------------------

	it('trySendToSubagent returns true and resolves input in waiting_for_input state', async () => {
		const s = createSession();
		s.sendToUser({ type: 'question', text: 'q?', blocking: true });
		const p = s.waitForInput(5000);
		const ok = s.trySendToSubagent('answer');
		expect(ok).toBe(true);
		expect(s.state).toBe('running');
		await expect(p).resolves.toBe('answer');
	});

	it('trySendToSubagent returns false in running state', () => {
		const s = createSession();
		expect(s.trySendToSubagent('text')).toBe(false);
		expect(s.state).toBe('running');
	});

	it('trySendToSubagent returns false in completed state', () => {
		const s = createSession();
		s.complete({});
		expect(s.trySendToSubagent('text')).toBe(false);
	});

	it('trySendToSubagent returns false in cancelled state', () => {
		const s = createSession();
		s.cancel();
		expect(s.trySendToSubagent('text')).toBe(false);
	});

	// -- UI request registry ------------------------------------------------

	it('registerUiRequest + hasUiRequest', () => {
		const s = createSession();
		expect(s.hasUiRequest('req-1')).toBe(false);

		s.registerUiRequest('req-1', [
			{ id: 'opt_0', label: 'Yes', description: 'Accept' },
			{ id: 'opt_1', label: 'No', description: 'Decline' },
		]);
		expect(s.hasUiRequest('req-1')).toBe(true);
		expect(s.hasUiRequest('req-2')).toBe(false);
	});

	it('resolveOption returns the matching option', () => {
		const s = createSession();
		s.registerUiRequest('req-1', [
			{ id: 'opt_0', label: 'Yes', description: 'Accept' },
			{ id: 'opt_1', label: 'No', description: 'Decline' },
		]);

		const opt = s.resolveOption('req-1', 'opt_1');
		expect(opt).toEqual({ id: 'opt_1', label: 'No', description: 'Decline' });
	});

	it('resolveOption returns undefined for unknown requestId', () => {
		const s = createSession();
		expect(s.resolveOption('unknown', 'opt_0')).toBeUndefined();
	});

	it('resolveOption returns undefined for unknown optionId', () => {
		const s = createSession();
		s.registerUiRequest('req-1', [{ id: 'opt_0', label: 'Yes', description: 'Accept' }]);
		expect(s.resolveOption('req-1', 'opt_99')).toBeUndefined();
	});
});
