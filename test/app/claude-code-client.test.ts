// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK before importing the module under test
const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: (...args: unknown[]) => mockQuery(...args),
}));

// Must import AFTER vi.mock
const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');

// ---------------------------------------------------------------------------
// Helpers — create mock async generators that simulate SDK behavior
// ---------------------------------------------------------------------------

function createMockInitMessage(sessionId = 'test-session-123') {
	return { type: 'system', subtype: 'init', session_id: sessionId, tools: [], model: 'test' };
}

function createMockAssistantMessage(text: string) {
	return {
		type: 'assistant',
		session_id: 'test-session-123',
		message: { content: [{ type: 'text', text }] },
	};
}

function createMockResultMessage(
	overrides: Partial<{
		subtype: string;
		total_cost_usd: number;
		num_turns: number;
		errors: string[];
	}> = {},
) {
	return {
		type: 'result',
		subtype: 'success',
		session_id: 'test-session-123',
		total_cost_usd: 0.01,
		num_turns: 1,
		...overrides,
	};
}

/** Create a mock query that yields messages in sequence. */
function setupSimpleQuery(messages: unknown[]) {
	const mockGen = {
		async *[Symbol.asyncIterator]() {
			for (const msg of messages) {
				yield msg;
			}
		},
		close: vi.fn(),
		interrupt: vi.fn(),
	};
	mockQuery.mockReturnValue(mockGen);
	return mockGen;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeSession', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// -- start() ---------------------------------------------------------------

	it('start() returns completed for simple tasks', async () => {
		setupSimpleQuery([
			createMockInitMessage(),
			createMockAssistantMessage('Done! Fixed the bug.'),
			createMockResultMessage(),
		]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		const result = await session.start('Fix the bug');

		expect(result.status).toBe('completed');
		expect(result.text).toBe('Done! Fixed the bug.');
		expect(result.sdkSessionId).toBe('test-session-123');
		expect(result.cost).toBe(0.01);
		expect(result.turns).toBe(1);
	});

	// NOTE: AskUserQuestion interception via canUseTool was removed because
	// the SDK adds --permission-prompt-tool stdio when canUseTool is present,
	// which conflicts with single-turn query mode and prevents ALL tool calls.
	// Tests for needs_input / respond() / auto-approve were removed.

	it('start() accumulates text from multiple assistant messages', async () => {
		setupSimpleQuery([
			createMockInitMessage(),
			createMockAssistantMessage('Part 1. '),
			createMockAssistantMessage('Part 2. '),
			createMockAssistantMessage('Part 3.'),
			createMockResultMessage(),
		]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		const result = await session.start('Task');

		expect(result.text).toBe('Part 1. Part 2. Part 3.');
	});

	it('start() throws when already started', async () => {
		setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		await session.start('Task 1');

		await expect(session.start('Task 2')).rejects.toThrow('already started');
	});

	it('start() handles error results', async () => {
		setupSimpleQuery([
			createMockInitMessage(),
			createMockResultMessage({
				subtype: 'error_max_turns',
				errors: ['Exceeded max turns'],
			}),
		]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		const result = await session.start('Task');

		expect(result.status).toBe('error');
		expect(result.error).toBe('Exceeded max turns');
	});

	it('start() returns error when stream ends without terminal result', async () => {
		setupSimpleQuery([createMockInitMessage(), createMockAssistantMessage('Working...')]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		const result = await session.start('Task');

		expect(result.status).toBe('error');
		expect(result.text).toBe('Working...');
		expect(result.error).toContain('terminal result message');
	});

	it('respond() throws when no pending question', async () => {
		setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		await session.start('Task');

		await expect(session.respond('answer')).rejects.toThrow('No pending question');
	});

	it('respond() throws after abort', async () => {
		setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		await session.start('Task');
		await session.abort();

		await expect(session.respond('answer')).rejects.toThrow('aborted');
	});

	// -- resume() ---------------------------------------------------------------

	it('resume() passes sdkSessionId to SDK options', async () => {
		setupSimpleQuery([createMockInitMessage('resumed-session'), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		const result = await session.resume('Continue the fix', 'prior-session-id');

		expect(result.status).toBe('completed');
		expect(result.sdkSessionId).toBe('resumed-session');

		// Verify the resume option was passed
		expect(mockQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'Continue the fix',
				options: expect.objectContaining({
					resume: 'prior-session-id',
				}),
			}),
		);
	});

	it('resume() throws after abort', async () => {
		const session = new ClaudeCodeSession({ cwd: '/test' });
		await session.abort();

		await expect(session.resume('Task', 'session-id')).rejects.toThrow('aborted');
	});

	// -- abort() ----------------------------------------------------------------

	it('abort() terminates session', async () => {
		const mockGen = setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		await session.start('Task');
		await session.abort();

		expect(session.isAborted).toBe(true);
		expect(mockGen.close).toHaveBeenCalled();
	});

	it('abort() is idempotent', async () => {
		setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		await session.start('Task');

		await session.abort();
		await session.abort(); // Should not throw

		expect(session.isAborted).toBe(true);
	});

	// -- Options ----------------------------------------------------------------

	it('passes through configuration options', async () => {
		setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

		const session = new ClaudeCodeSession({
			cwd: '/my/project',
			model: 'claude-opus-4-6',
			maxTurns: 10,
			systemPrompt: 'Custom prompt',
			permissionMode: 'acceptEdits',
			allowedTools: ['Read', 'Grep'],
		});
		await session.start('Task');

		expect(mockQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({
					model: 'claude-opus-4-6',
					maxTurns: 10,
					systemPrompt: 'Custom prompt',
					permissionMode: 'acceptEdits',
					cwd: '/my/project',
					allowedTools: ['Read', 'Grep'],
				}),
			}),
		);
	});

	it('uses default options when not specified', async () => {
		setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		await session.start('Task');

		expect(mockQuery).toHaveBeenCalledWith(
			expect.objectContaining({
				options: expect.objectContaining({
					model: 'claude-sonnet-4-5-20250929',
					maxTurns: 20,
					permissionMode: 'bypassPermissions',
					allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
				}),
			}),
		);
	});

	// -- sdkSessionId -----------------------------------------------------------

	it('sdkSessionId present in all results', async () => {
		setupSimpleQuery([createMockInitMessage('my-session-id'), createMockResultMessage()]);

		const session = new ClaudeCodeSession({ cwd: '/test' });
		const result = await session.start('Task');

		expect(result.sdkSessionId).toBe('my-session-id');
	});

	// -- Error handling ---------------------------------------------------------

	it('SDK error returns error result', async () => {
		mockQuery.mockImplementation(() => ({
			async *[Symbol.asyncIterator]() {
				yield createMockInitMessage();
				throw new Error('API rate limited');
			},
			close: vi.fn(),
		}));

		const session = new ClaudeCodeSession({ cwd: '/test' });
		const result = await session.start('Task');

		expect(result.status).toBe('error');
		expect(result.error).toBe('API rate limited');
	});
});
