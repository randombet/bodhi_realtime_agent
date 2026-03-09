// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK before importing the module under test
const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: (...args: unknown[]) => mockQuery(...args),
}));

// Must import AFTER vi.mock
const { askClaudeTool, createClaudeCodeSubagentConfig } = await import(
	'../../app/lib/claude-code-tools.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockInitMessage(sessionId = 'sdk-session-123') {
	return { type: 'system', subtype: 'init', session_id: sessionId, tools: [], model: 'test' };
}

function createMockAssistantMessage(text: string) {
	return {
		type: 'assistant',
		session_id: 'sdk-session-123',
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
		session_id: 'sdk-session-123',
		total_cost_usd: 0.05,
		num_turns: 2,
		...overrides,
	};
}

/** Setup a simple query mock that yields messages in sequence. */
function setupSimpleQuery(messages: unknown[]) {
	mockQuery.mockReturnValue({
		async *[Symbol.asyncIterator]() {
			for (const msg of messages) {
				yield msg;
			}
		},
		close: vi.fn(),
		interrupt: vi.fn(),
	});
}

// ---------------------------------------------------------------------------
// askClaudeTool
// ---------------------------------------------------------------------------

describe('askClaudeTool', () => {
	it('has correct name and execution mode', () => {
		expect(askClaudeTool.name).toBe('ask_claude');
		expect(askClaudeTool.execution).toBe('background');
	});

	it('has a pending message', () => {
		expect(askClaudeTool.pendingMessage).toBeDefined();
		expect(typeof askClaudeTool.pendingMessage).toBe('string');
	});

	it('has a task parameter', () => {
		const schema = askClaudeTool.parameters;
		const result = schema.safeParse({ task: 'Fix the bug' });
		expect(result.success).toBe(true);
	});

	it('rejects missing task parameter', () => {
		const schema = askClaudeTool.parameters;
		const result = schema.safeParse({});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// createClaudeCodeSubagentConfig
// ---------------------------------------------------------------------------

describe('createClaudeCodeSubagentConfig', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns a valid SubagentConfig', () => {
		const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });

		expect(config.name).toBe('claude-code-relay');
		expect(config.interactive).toBe(true);
		expect(config.maxSteps).toBe(20);
		expect(config.timeout).toBe(600_000);
		expect(config.instructions).toContain('relay agent');
		expect(typeof config.dispose).toBe('function');
	});

	it('has both claude_code_start and claude_code_respond tools', () => {
		const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
		const tools = config.tools as Record<string, unknown>;

		expect(tools.claude_code_start).toBeDefined();
		expect(tools.claude_code_respond).toBeDefined();
	});

	it('createInstance returns isolated config objects', () => {
		const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
		expect(typeof config.createInstance).toBe('function');

		const a = config.createInstance?.();
		const b = config.createInstance?.();

		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a).not.toBe(b);
		expect(a?.tools).not.toBe(b?.tools);
	});

	// -- claude_code_start ---------------------------------------------------

	describe('claude_code_start', () => {
		it('returns sessionId and sdkSessionId on completed', async () => {
			setupSimpleQuery([
				createMockInitMessage(),
				createMockAssistantMessage('Done!'),
				createMockResultMessage(),
			]);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;
			const result = (await tools.claude_code_start.execute({
				task: 'Fix the bug',
			})) as Record<string, unknown>;

			expect(result.sessionId).toBeDefined();
			expect(typeof result.sessionId).toBe('string');
			expect(result.sdkSessionId).toBe('sdk-session-123');
			expect(result.status).toBe('completed');
			expect(result.text).toBe('Done!');
		});

		// NOTE: AskUserQuestion interception via canUseTool was removed because
		// the SDK adds --permission-prompt-tool stdio when canUseTool is present,
		// which conflicts with single-turn query mode and prevents ALL tool calls.

		it('passes options through to ClaudeCodeSession', async () => {
			setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

			const config = createClaudeCodeSubagentConfig({
				projectDir: '/my/project',
				model: 'claude-opus-4-6',
				permissionMode: 'acceptEdits',
				maxTurns: 10,
			});
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;
			await tools.claude_code_start.execute({ task: 'Task' });

			expect(mockQuery).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						cwd: '/my/project',
						model: 'claude-opus-4-6',
						permissionMode: 'acceptEdits',
						maxTurns: 10,
					}),
				}),
			);
		});

		it('uses resume when resumeSessionId is provided', async () => {
			setupSimpleQuery([createMockInitMessage('resumed-session'), createMockResultMessage()]);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;
			const result = (await tools.claude_code_start.execute({
				task: 'Continue the fix',
				resumeSessionId: 'prior-sdk-session',
			})) as Record<string, unknown>;

			expect(result.status).toBe('completed');
			expect(result.sdkSessionId).toBe('resumed-session');

			expect(mockQuery).toHaveBeenCalledWith(
				expect.objectContaining({
					options: expect.objectContaining({
						resume: 'prior-sdk-session',
					}),
				}),
			);
		});

		it('concurrent starts create independent sessions', async () => {
			// Each call gets its own mock query
			let callCount = 0;
			mockQuery.mockImplementation(() => {
				const id = `session-${++callCount}`;
				return {
					async *[Symbol.asyncIterator]() {
						yield createMockInitMessage(id);
						yield createMockAssistantMessage(`Result ${id}`);
						yield createMockResultMessage();
					},
					close: vi.fn(),
					interrupt: vi.fn(),
				};
			});

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;

			const [r1, r2] = (await Promise.all([
				tools.claude_code_start.execute({ task: 'Task 1' }),
				tools.claude_code_start.execute({ task: 'Task 2' }),
			])) as Record<string, unknown>[];

			expect(r1.sessionId).not.toBe(r2.sessionId);
			expect(r1.sdkSessionId).not.toBe(r2.sdkSessionId);
		});
	});

	// -- claude_code_respond -------------------------------------------------

	describe('claude_code_respond', () => {
		it('throws for unknown sessionId', async () => {
			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;

			await expect(
				tools.claude_code_respond.execute({
					sessionId: 'nonexistent',
					response: 'answer',
				}),
			).rejects.toThrow('No active Claude Code session');
		});
	});

	// -- dispose -------------------------------------------------------------

	describe('dispose', () => {
		it('is idempotent', async () => {
			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });

			await config.dispose?.();
			await config.dispose?.(); // Should not throw
		});
	});
});
