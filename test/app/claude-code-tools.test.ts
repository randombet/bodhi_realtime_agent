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

/**
 * Setup a blocking query mock for AskUserQuestion interception.
 * The generator blocks at the canUseTool call until externally unblocked.
 */
function setupBlockingQuery(
	messagesBeforePause: unknown[],
	messagesAfterResume: unknown[],
	questionInput?: Record<string, unknown>,
) {
	let canUseToolFn:
		| ((toolName: string, input: Record<string, unknown>) => Promise<unknown>)
		| null = null;
	let resolveBlock: (() => void) | null = null;

	mockQuery.mockImplementation((args: { options?: { canUseTool?: typeof canUseToolFn } }) => {
		canUseToolFn = args.options?.canUseTool ?? null;

		const gen = {
			async *[Symbol.asyncIterator]() {
				for (const msg of messagesBeforePause) {
					yield msg;
				}

				if (canUseToolFn) {
					const askInput = questionInput ?? {
						questions: [
							{
								question: 'Which file to fix?',
								header: 'File',
								options: [
									{ label: 'auth.py', description: 'Auth module' },
									{ label: 'main.py', description: 'Main module' },
								],
								multiSelect: false,
							},
						],
					};
					const toolPromise = canUseToolFn('AskUserQuestion', askInput);

					await new Promise<void>((resolve) => {
						resolveBlock = () => resolve();
					});

					await toolPromise;

					for (const msg of messagesAfterResume) {
						yield msg;
					}
				}
			},
			close: vi.fn(),
			interrupt: vi.fn(),
		};

		return gen;
	});

	return {
		unblock: () => resolveBlock?.(),
	};
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

		it('returns needs_input with question on AskUserQuestion', async () => {
			const { unblock } = setupBlockingQuery(
				[createMockInitMessage(), createMockAssistantMessage('Looking...')],
				[createMockResultMessage()],
			);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;
			const result = (await tools.claude_code_start.execute({
				task: 'Fix the bug',
			})) as Record<string, unknown>;

			expect(result.status).toBe('needs_input');
			expect(result.question).toBe('Which file to fix?');
			expect(result.questionOptions).toEqual([
				{ label: 'auth.py', description: 'Auth module' },
				{ label: 'main.py', description: 'Main module' },
			]);

			// Clean up
			unblock();
			await config.dispose?.();
		});

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
		it('sends response and returns completed', async () => {
			let canUseToolFn:
				| ((toolName: string, input: Record<string, unknown>) => Promise<unknown>)
				| null = null;
			let resolveBlock: (() => void) | null = null;

			mockQuery.mockImplementation(
				(args: {
					options?: {
						canUseTool?: typeof canUseToolFn;
					};
				}) => {
					canUseToolFn = args.options?.canUseTool ?? null;
					let toolResolved = false;

					return {
						async *[Symbol.asyncIterator]() {
							yield createMockInitMessage();
							yield createMockAssistantMessage('Working...');

							if (canUseToolFn) {
								const promise = canUseToolFn('AskUserQuestion', {
									questions: [
										{
											question: 'Pick a file',
											header: 'File',
											options: [],
											multiSelect: false,
										},
									],
								});

								await new Promise<void>((resolve) => {
									resolveBlock = () => {
										toolResolved = true;
										resolve();
									};
								});

								await promise;
							}

							if (toolResolved) {
								yield createMockAssistantMessage(' Fixed!');
								yield createMockResultMessage({ num_turns: 4 });
							}
						},
						close: vi.fn(),
					};
				},
			);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;

			// Start — should pause on question
			const startResult = (await tools.claude_code_start.execute({
				task: 'Fix bug',
			})) as Record<string, unknown>;
			expect(startResult.status).toBe('needs_input');

			// Unblock the generator, then respond
			resolveBlock?.();

			const respondResult = (await tools.claude_code_respond.execute({
				sessionId: startResult.sessionId as string,
				response: 'auth.py',
			})) as Record<string, unknown>;

			expect(respondResult.status).toBe('completed');
			expect(respondResult.text).toBe('Working... Fixed!');
			expect(respondResult.turns).toBe(4);
		});

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
		it('aborts all active sessions and clears the map', async () => {
			const { unblock } = setupBlockingQuery(
				[createMockInitMessage(), createMockAssistantMessage('Working...')],
				[createMockResultMessage()],
			);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<unknown> }
			>;

			// Start a session that will pause
			const result = (await tools.claude_code_start.execute({
				task: 'Task',
			})) as Record<string, unknown>;
			expect(result.status).toBe('needs_input');

			// Dispose should abort the session
			unblock();
			await config.dispose?.();

			// The session should be gone — respond should throw
			await expect(
				tools.claude_code_respond.execute({
					sessionId: result.sessionId as string,
					response: 'answer',
				}),
			).rejects.toThrow('No active Claude Code session');
		});

		it('is idempotent', async () => {
			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });

			await config.dispose?.();
			await config.dispose?.(); // Should not throw
		});
	});
});
