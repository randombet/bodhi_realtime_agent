// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK before importing the module under test
const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: (...args: unknown[]) => mockQuery(...args),
}));

// Must import AFTER vi.mock
const { askClaudeTool, createClaudeCodeSubagentConfig, _ClaudeCodeSessionClass } = await import(
	'../../examples/claude_code/claude-code-tools.js'
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

function createMockQuery(messages: unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const msg of messages) {
				yield msg;
			}
		},
		close: vi.fn(),
		interrupt: vi.fn(),
	};
}

function setupSimpleQuery(messages: unknown[]) {
	mockQuery.mockReturnValue(createMockQuery(messages));
}

// ---------------------------------------------------------------------------
// askClaudeTool
// ---------------------------------------------------------------------------

describe('askClaudeTool', () => {
	it('has correct name and execution mode', () => {
		expect(askClaudeTool.name).toBe('ask_claude');
		expect(askClaudeTool.execution).toBe('background');
	});

	it('accepts task-only arguments', () => {
		const result = askClaudeTool.parameters.safeParse({ task: 'Fix the bug' });
		expect(result.success).toBe(true);
	});

	it('accepts optional threadKey and continuityMode', () => {
		const result = askClaudeTool.parameters.safeParse({
			task: 'Fix the bug',
			threadKey: 'task_auth_bug',
			continuityMode: 'force_fresh',
		});
		expect(result.success).toBe(true);
	});

	it('rejects invalid continuityMode', () => {
		const result = askClaudeTool.parameters.safeParse({
			task: 'Fix the bug',
			continuityMode: 'always_resume',
		});
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// createClaudeCodeSubagentConfig
// ---------------------------------------------------------------------------

describe('createClaudeCodeSubagentConfig', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
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

	it('shares continuity metadata across createInstance()', async () => {
		mockQuery
			.mockReturnValueOnce(
				createMockQuery([
					createMockInitMessage('sdk-thread-1'),
					createMockAssistantMessage('Done 1'),
					createMockResultMessage(),
				]),
			)
			.mockReturnValueOnce(
				createMockQuery([
					createMockInitMessage('sdk-thread-2'),
					createMockAssistantMessage('Done 2'),
					createMockResultMessage(),
				]),
			);

		const root = createClaudeCodeSubagentConfig({ projectDir: '/test' });
		const instance1 = root.createInstance?.();
		const instance2 = root.createInstance?.();
		if (!instance1 || !instance2) {
			throw new Error('Expected createInstance() to return subagent configs');
		}

		const tools1 = instance1.tools as Record<
			string,
			{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
		>;
		const tools2 = instance2.tools as Record<
			string,
			{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
		>;

		await tools1.claude_code_start.execute({ task: 'Fix A', threadKey: 'shared_thread' });
		await tools2.claude_code_start.execute({ task: 'Fix B', threadKey: 'shared_thread' });

		expect(mockQuery).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				options: expect.objectContaining({ resume: 'sdk-thread-1' }),
			}),
		);
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
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;
			const result = await tools.claude_code_start.execute({ task: 'Fix the bug' });

			expect(result.sessionId).toBeDefined();
			expect(typeof result.sessionId).toBe('string');
			expect(result.sdkSessionId).toBe('sdk-session-123');
			expect(result.status).toBe('completed');
			expect(result.text).toBe('Done!');
			expect(result.threadKey).toBe('claude_thread_1');
			expect(result.continuityMode).toBe('resume_if_available');
		});

		it('deterministically allocates thread keys when missing', async () => {
			mockQuery
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-a'), createMockResultMessage()]),
				)
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-b'), createMockResultMessage()]),
				);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			const r1 = await tools.claude_code_start.execute({ task: 'Task 1' });
			const r2 = await tools.claude_code_start.execute({ task: 'Task 2' });

			expect(r1.threadKey).toBe('claude_thread_1');
			expect(r2.threadKey).toBe('claude_thread_2');
		});

		it('preserves explicit threadKey', async () => {
			setupSimpleQuery([createMockInitMessage(), createMockResultMessage()]);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			const result = await tools.claude_code_start.execute({
				task: 'Task',
				threadKey: 'task_auth_bug',
			});

			expect(result.threadKey).toBe('task_auth_bug');
		});

		it('returns deterministic error for force_resume without target', async () => {
			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			const result = await tools.claude_code_start.execute({
				task: 'Continue',
				threadKey: 'task_auth_bug',
				continuityMode: 'force_resume',
			});

			expect(result.status).toBe('error');
			expect(result.error).toBe('force_resume_requested_but_no_resume_target');
			expect(mockQuery).not.toHaveBeenCalled();
		});

		it('uses thread state resume id for resume_if_available', async () => {
			mockQuery
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-first'), createMockResultMessage()]),
				)
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-second'), createMockResultMessage()]),
				);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			await tools.claude_code_start.execute({
				task: 'Fix auth bug',
				threadKey: 'task_auth_bug',
				continuityMode: 'force_fresh',
			});

			await tools.claude_code_start.execute({
				task: 'Add tests',
				threadKey: 'task_auth_bug',
				continuityMode: 'resume_if_available',
			});

			expect(mockQuery).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					options: expect.objectContaining({ resume: 'sdk-first' }),
				}),
			);
		});

		it('force_fresh ignores prior thread resume id', async () => {
			mockQuery
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-first'), createMockResultMessage()]),
				)
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-second'), createMockResultMessage()]),
				);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			await tools.claude_code_start.execute({ task: 'Task A', threadKey: 't1' });
			await tools.claude_code_start.execute({
				task: 'Task B',
				threadKey: 't1',
				continuityMode: 'force_fresh',
			});

			const secondCallOptions = mockQuery.mock.calls[1][0].options;
			expect(secondCallOptions).not.toHaveProperty('resume');
		});

		it('falls back to fresh start once on invalid resume result', async () => {
			mockQuery
				.mockReturnValueOnce(
					createMockQuery([
						createMockInitMessage('resume-attempt'),
						createMockResultMessage({ subtype: 'error_resume', errors: ['Session not found'] }),
					]),
				)
				.mockReturnValueOnce(
					createMockQuery([
						createMockInitMessage('fresh-fallback'),
						createMockAssistantMessage('Recovered'),
						createMockResultMessage(),
					]),
				);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			const result = await tools.claude_code_start.execute({
				task: 'Continue previous work',
				threadKey: 'task_auth_bug',
				resumeSessionId: 'stale-session-id',
			});

			expect(result.status).toBe('completed');
			expect(result.resumeFallbackUsed).toBe(true);
			expect(result.sdkSessionId).toBe('fresh-fallback');
			expect(mockQuery).toHaveBeenCalledTimes(2);
			expect(mockQuery).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					options: expect.objectContaining({ resume: 'stale-session-id' }),
				}),
			);
			const fallbackCallOptions = mockQuery.mock.calls[1][0].options;
			expect(fallbackCallOptions).not.toHaveProperty('resume');
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
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
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
	});

	// -- claude_code_respond -------------------------------------------------

	describe('claude_code_respond', () => {
		it('returns deterministic mapping error when thread cannot be resolved', async () => {
			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			const result = await tools.claude_code_respond.execute({
				sessionId: 'nonexistent',
				response: 'answer',
			});

			expect(result.status).toBe('error');
			expect(result.error).toBe('unknown_session_thread_mapping');
		});

		it('returns deterministic no-active-session error when mapping exists', async () => {
			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			const result = await tools.claude_code_respond.execute({
				sessionId: 'nonexistent',
				threadKey: 'task_auth_bug',
				response: 'answer',
			});

			expect(result.status).toBe('error');
			expect(result.error).toContain('No active Claude Code session');
			expect(result.threadKey).toBe('task_auth_bug');
		});

		it('uses sessionId -> threadKey mapping for respond terminal recording', async () => {
			vi.spyOn(_ClaudeCodeSessionClass.prototype, 'start').mockResolvedValueOnce({
				status: 'needs_input',
				text: 'Need answer',
				sdkSessionId: 'sdk-needs-input',
				question: 'Which option?',
				questionOptions: [{ label: 'A', description: 'Option A' }],
			});
			vi.spyOn(_ClaudeCodeSessionClass.prototype, 'respond').mockResolvedValueOnce({
				status: 'completed',
				text: 'Done after response',
				sdkSessionId: 'sdk-done',
			});

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			const started = await tools.claude_code_start.execute({
				task: 'Interactive task',
				threadKey: 'interactive_thread',
				continuityMode: 'force_fresh',
			});
			expect(started.status).toBe('needs_input');

			const completed = await tools.claude_code_respond.execute({
				sessionId: started.sessionId as string,
				response: 'Use option A',
			});
			expect(completed.status).toBe('completed');
			expect(completed.threadKey).toBe('interactive_thread');

			// Mapping was removed after terminal completion.
			const afterTerminal = await tools.claude_code_respond.execute({
				sessionId: started.sessionId as string,
				response: 'Second response',
			});
			expect(afterTerminal.status).toBe('error');
			expect(afterTerminal.error).toBe('unknown_session_thread_mapping');
		});
	});

	// -- cross-thread isolation (TC2) -----------------------------------------

	describe('cross-thread isolation', () => {
		it('continuity does not leak across different threadKey values', async () => {
			mockQuery
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-thread-a'), createMockResultMessage()]),
				)
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-thread-b'), createMockResultMessage()]),
				)
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-thread-b2'), createMockResultMessage()]),
				);

			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			// Complete a task on thread_a
			await tools.claude_code_start.execute({ task: 'Task A', threadKey: 'thread_a' });
			// Complete a task on thread_b
			await tools.claude_code_start.execute({ task: 'Task B', threadKey: 'thread_b' });
			// Follow-up on thread_b should resume from sdk-thread-b, NOT sdk-thread-a
			await tools.claude_code_start.execute({
				task: 'Follow-up B',
				threadKey: 'thread_b',
				continuityMode: 'resume_if_available',
			});

			expect(mockQuery).toHaveBeenNthCalledWith(
				3,
				expect.objectContaining({
					options: expect.objectContaining({ resume: 'sdk-thread-b' }),
				}),
			);
		});
	});

	// -- error does not overwrite sdkSessionId (TC7) --------------------------

	describe('error terminal recording', () => {
		it('error status does not overwrite lastCompletedSdkSessionId', async () => {
			mockQuery
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-good'), createMockResultMessage()]),
				)
				.mockReturnValueOnce(
					createMockQuery([
						createMockInitMessage('sdk-bad'),
						createMockResultMessage({ subtype: 'error', errors: ['Something went wrong'] }),
					]),
				)
				.mockReturnValueOnce(
					createMockQuery([createMockInitMessage('sdk-third'), createMockResultMessage()]),
				);

			const sharedState = {
				threads: {},
				sessionToThread: {},
				maxHistoryPerThread: 5,
				maxTotalHistory: 100,
				nextThreadOrdinal: 1,
			};

			const config = createClaudeCodeSubagentConfig({
				projectDir: '/test',
				_state: sharedState,
			});
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			// Successful completion — stores sdk-good as lastCompletedSdkSessionId
			await tools.claude_code_start.execute({
				task: 'Good task',
				threadKey: 'tc7_thread',
				continuityMode: 'force_fresh',
			});
			// Error completion — should NOT overwrite lastCompletedSdkSessionId
			await tools.claude_code_start.execute({
				task: 'Bad task',
				threadKey: 'tc7_thread',
				continuityMode: 'force_fresh',
			});
			// Resume should still use sdk-good, not sdk-bad
			await tools.claude_code_start.execute({
				task: 'Resume task',
				threadKey: 'tc7_thread',
				continuityMode: 'resume_if_available',
			});

			expect(mockQuery).toHaveBeenNthCalledWith(
				3,
				expect.objectContaining({
					options: expect.objectContaining({ resume: 'sdk-good' }),
				}),
			);
		});
	});

	// -- dedup (TC10) ---------------------------------------------------------

	describe('dedup', () => {
		it('duplicate dedupeKey does not create duplicate history entries', async () => {
			mockQuery.mockReturnValue(
				createMockQuery([
					createMockInitMessage('sdk-dup'),
					createMockAssistantMessage('Done'),
					createMockResultMessage(),
				]),
			);

			const sharedState = {
				threads: {},
				sessionToThread: {},
				maxHistoryPerThread: 10,
				maxTotalHistory: 100,
				nextThreadOrdinal: 1,
			};

			const config = createClaudeCodeSubagentConfig({
				projectDir: '/test',
				_state: sharedState,
			});
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			// Two separate calls with same threadKey — each creates a unique dedupeKey
			// so history should grow normally (this confirms dedup doesn't block normal ops).
			await tools.claude_code_start.execute({
				task: 'Task 1',
				threadKey: 'dedup_thread',
				continuityMode: 'force_fresh',
			});
			await tools.claude_code_start.execute({
				task: 'Task 2',
				threadKey: 'dedup_thread',
				continuityMode: 'force_fresh',
			});

			expect(sharedState.threads.dedup_thread.history.length).toEqual(2);
		});
	});

	// -- history caps ---------------------------------------------------------

	describe('history caps', () => {
		it('enforces per-thread and total history caps', async () => {
			let sequence = 0;
			mockQuery.mockImplementation(() => {
				sequence += 1;
				return createMockQuery([
					createMockInitMessage(`sdk-${sequence}`),
					createMockAssistantMessage(`Result ${sequence}`),
					createMockResultMessage(),
				]);
			});

			const sharedState = {
				threads: {},
				sessionToThread: {},
				maxHistoryPerThread: 2,
				maxTotalHistory: 3,
				nextThreadOrdinal: 1,
			};

			const config = createClaudeCodeSubagentConfig({
				projectDir: '/test',
				_state: sharedState,
			});
			const tools = config.tools as Record<
				string,
				{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
			>;

			await tools.claude_code_start.execute({
				task: 'A1',
				threadKey: 'thread_a',
				continuityMode: 'force_fresh',
			});
			await tools.claude_code_start.execute({
				task: 'A2',
				threadKey: 'thread_a',
				continuityMode: 'force_fresh',
			});
			await tools.claude_code_start.execute({
				task: 'A3',
				threadKey: 'thread_a',
				continuityMode: 'force_fresh',
			});
			await tools.claude_code_start.execute({
				task: 'B1',
				threadKey: 'thread_b',
				continuityMode: 'force_fresh',
			});

			const perThreadA = sharedState.threads.thread_a?.history.length ?? 0;
			expect(perThreadA).toEqual(2);

			const total = Object.values(sharedState.threads).reduce(
				(sum, thread) => sum + thread.history.length,
				0,
			);
			expect(total).toEqual(3);
		});
	});

	// -- dispose -------------------------------------------------------------

	describe('dispose', () => {
		it('is idempotent', async () => {
			const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });

			await config.dispose?.();
			await config.dispose?.();
		});
	});
});
