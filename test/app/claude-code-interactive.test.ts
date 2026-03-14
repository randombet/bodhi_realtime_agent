// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: (...args: unknown[]) => mockQuery(...args),
}));

const { createClaudeCodeSubagentConfig, _ClaudeCodeSessionClass } = await import(
	'../../examples/claude_code/claude-code-tools.js'
);

function createMockInitMessage(sessionId: string) {
	return { type: 'system', subtype: 'init', session_id: sessionId, tools: [], model: 'test' };
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

describe('claude continuity integration', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('resumes within the same thread but keeps different threads isolated', async () => {
		mockQuery
			.mockReturnValueOnce(
				createMockQuery([createMockInitMessage('sdk-a1'), createMockResultMessage()]),
			)
			.mockReturnValueOnce(
				createMockQuery([createMockInitMessage('sdk-a2'), createMockResultMessage()]),
			)
			.mockReturnValueOnce(
				createMockQuery([createMockInitMessage('sdk-b1'), createMockResultMessage()]),
			);

		const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
		const tools = config.tools as Record<
			string,
			{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
		>;

		await tools.claude_code_start.execute({
			task: 'Fix auth bug',
			threadKey: 'thread_auth',
			continuityMode: 'force_fresh',
		});
		await tools.claude_code_start.execute({
			task: 'Add tests for auth bug',
			threadKey: 'thread_auth',
			continuityMode: 'resume_if_available',
		});
		await tools.claude_code_start.execute({
			task: 'Refactor websocket layer',
			threadKey: 'thread_ws',
			continuityMode: 'resume_if_available',
		});

		expect(mockQuery).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				options: expect.objectContaining({ resume: 'sdk-a1' }),
			}),
		);
		expect(mockQuery).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				options: expect.not.objectContaining({ resume: expect.anything() }),
			}),
		);
	});

	it('applies one-time fresh fallback on invalid resume sessions', async () => {
		mockQuery
			.mockReturnValueOnce(
				createMockQuery([
					createMockInitMessage('sdk-resume-fail'),
					createMockResultMessage({ subtype: 'error_resume', errors: ['Session expired'] }),
				]),
			)
			.mockReturnValueOnce(
				createMockQuery([createMockInitMessage('sdk-fresh-success'), createMockResultMessage()]),
			);

		const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
		const tools = config.tools as Record<
			string,
			{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
		>;

		const result = await tools.claude_code_start.execute({
			task: 'Continue prior task',
			threadKey: 'thread_auth',
			resumeSessionId: 'stale-session-id',
			continuityMode: 'resume_if_available',
		});

		expect(result.status).toBe('completed');
		expect(result.resumeFallbackUsed).toBe(true);
		expect(result.sdkSessionId).toBe('sdk-fresh-success');
		expect(mockQuery).toHaveBeenCalledTimes(2);
	});

	it('updates thread state from claude_code_respond terminal path', async () => {
		vi.spyOn(_ClaudeCodeSessionClass.prototype, 'start').mockResolvedValueOnce({
			status: 'needs_input',
			text: 'Question',
			sdkSessionId: 'sdk-needs-input',
			question: 'Choose',
			questionOptions: [{ label: 'A', description: 'Option A' }],
		});
		vi.spyOn(_ClaudeCodeSessionClass.prototype, 'respond').mockResolvedValueOnce({
			status: 'completed',
			text: 'Completed from respond',
			sdkSessionId: 'sdk-after-respond',
		});

		const config = createClaudeCodeSubagentConfig({ projectDir: '/test' });
		const tools = config.tools as Record<
			string,
			{ execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> }
		>;

		const start = await tools.claude_code_start.execute({
			task: 'Interactive',
			threadKey: 'thread_interactive',
			continuityMode: 'force_fresh',
		});
		expect(start.status).toBe('needs_input');

		const done = await tools.claude_code_respond.execute({
			sessionId: start.sessionId as string,
			response: 'Option A',
		});
		expect(done.status).toBe('completed');
		expect(done.threadKey).toBe('thread_interactive');
	});
});
