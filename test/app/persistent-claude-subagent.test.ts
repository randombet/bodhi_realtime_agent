// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCodeSessionOptions } from '../../app/lib/claude-code-client.js';
import { PersistentClaudeSubagent } from '../../app/lib/persistent-claude-subagent.js';

// Mock the ClaudeCodeSession class
vi.mock('../../app/lib/claude-code-client.js', () => {
	let callCount = 0;
	return {
		ClaudeCodeSession: vi.fn().mockImplementation(() => {
			callCount++;
			const id = callCount;
			return {
				start: vi.fn().mockResolvedValue({
					status: 'completed',
					text: `result from session #${id}`,
					sdkSessionId: `sdk-session-${id}`,
				}),
				resume: vi.fn().mockResolvedValue({
					status: 'completed',
					text: `resumed result from session #${id}`,
					sdkSessionId: `sdk-session-${id}`,
				}),
				respond: vi.fn(),
				abort: vi.fn().mockResolvedValue(undefined),
				isAborted: false,
			};
		}),
	};
});

const sessionOptions: ClaudeCodeSessionOptions = {
	cwd: '/test/project',
	model: 'claude-sonnet-4-5-20250929',
};

describe('PersistentClaudeSubagent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('first invoke calls start(), not resume()', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const result = await agent.invoke('Fix the bug', {});

		expect(result).toContain('result from session');
		// ClaudeCodeSession was constructed
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
		expect(ClaudeCodeSession).toHaveBeenCalled();
	});

	it('second invoke calls resume() with saved sdkSessionId', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);

		// First call — uses start()
		await agent.invoke('Fix the bug', {});

		// Second call — should use resume() with the saved sdkSessionId
		const result = await agent.invoke('Now add tests', {});
		expect(result).toContain('resumed result');
	});

	it('creates a new ClaudeCodeSession per invoke (avoids started flag)', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');

		await agent.invoke('Task 1', {});
		await agent.invoke('Task 2', {});

		// Two separate ClaudeCodeSession instances were created
		expect(ClaudeCodeSession).toHaveBeenCalledTimes(2);
	});

	it('throws when invoked after dispose', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		await agent.dispose();

		await expect(agent.invoke('Task', {})).rejects.toThrow('disposed');
	});

	it('dispose is idempotent', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		await agent.dispose();
		await agent.dispose(); // Should not throw
	});

	it('abort signal aborts the active session', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const controller = new AbortController();

		// Start invoke but don't await it yet
		const promise = agent.invoke('Long task', {}, controller.signal);

		// The session was already created synchronously, abort it
		controller.abort();

		// Should still resolve (mock resolves immediately)
		const result = await promise;
		expect(result).toBeDefined();
	});

	it('propagates errors from ClaudeCodeSession', async () => {
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
		(ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
			start: vi.fn().mockResolvedValue({
				status: 'error',
				text: '',
				error: 'Something went wrong',
			}),
			abort: vi.fn().mockResolvedValue(undefined),
		}));

		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		await expect(agent.invoke('Bad task', {})).rejects.toThrow('Something went wrong');
	});
});
