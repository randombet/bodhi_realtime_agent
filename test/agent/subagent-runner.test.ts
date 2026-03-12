// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { _buildSystemPromptForTest, runSubagent } from '../../src/agent/subagent-runner.js';
import { SubagentSessionImpl } from '../../src/agent/subagent-session.js';
import { HooksManager } from '../../src/core/hooks.js';
import type { SubagentContextSnapshot } from '../../src/types/conversation.js';

// Mock the ai module
vi.mock('ai', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		generateText: vi.fn(async (opts: { onStepFinish?: (step: unknown) => void }) => {
			// Simulate one step
			opts.onStepFinish?.({
				toolCalls: [{ toolName: 'search' }],
				usage: { totalTokens: 100 },
			});
			return { text: 'Subagent completed the task.' };
		}),
	};
});

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createTestContext(overrides?: Partial<SubagentContextSnapshot>): SubagentContextSnapshot {
	return {
		task: {
			description: 'Search for flights',
			toolCallId: 'tc_1',
			toolName: 'flight_search',
			args: { from: 'SFO', to: 'JFK' },
		},
		conversationSummary: null,
		recentTurns: [],
		relevantMemoryFacts: [],
		agentInstructions: 'You are a booking agent.',
		...overrides,
	};
}

describe('buildSystemPrompt', () => {
	it('includes instructions and task', () => {
		const prompt = _buildSystemPromptForTest(createTestContext());
		expect(prompt).toContain('You are a booking agent.');
		expect(prompt).toContain('Search for flights');
	});

	it('includes conversation summary when present', () => {
		const prompt = _buildSystemPromptForTest(
			createTestContext({ conversationSummary: 'User wants to fly to NYC' }),
		);
		expect(prompt).toContain('User wants to fly to NYC');
	});

	it('includes recent turns when present', () => {
		const prompt = _buildSystemPromptForTest(
			createTestContext({
				recentTurns: [
					{ role: 'user', content: 'Find flights', timestamp: 1 },
					{ role: 'assistant', content: 'Looking now', timestamp: 2 },
				],
			}),
		);
		expect(prompt).toContain('[user]: Find flights');
		expect(prompt).toContain('[assistant]: Looking now');
	});

	it('includes task arguments when present', () => {
		const prompt = _buildSystemPromptForTest(createTestContext());
		expect(prompt).toContain('# Task Arguments');
		expect(prompt).toContain('"from": "SFO"');
		expect(prompt).toContain('"to": "JFK"');
	});

	it('omits task arguments section when args are empty', () => {
		const prompt = _buildSystemPromptForTest(
			createTestContext({
				task: {
					description: 'Do something',
					toolCallId: 'tc_2',
					toolName: 'noop',
					args: {},
				},
			}),
		);
		expect(prompt).not.toContain('# Task Arguments');
	});

	it('includes memory facts when present', () => {
		const prompt = _buildSystemPromptForTest(
			createTestContext({
				relevantMemoryFacts: [
					{ content: 'Prefers window seat', category: 'preference', timestamp: 1 },
				],
			}),
		);
		expect(prompt).toContain('Prefers window seat');
	});
});

describe('runSubagent', () => {
	it('calls generateText with correct params', async () => {
		const { generateText } = await import('ai');
		const hooks = new HooksManager();

		await runSubagent({
			config: {
				name: 'test-subagent',
				instructions: 'Test instructions',
				tools: {},
				maxSteps: 3,
			},
			context: createTestContext(),
			hooks,
			model: mockModel,
		});

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				maxSteps: 3,
				prompt: expect.stringContaining('Search for flights'),
				model: mockModel,
			}),
		);
	});

	it('includes task args in the prompt sent to generateText', async () => {
		const { generateText } = await import('ai');
		const hooks = new HooksManager();

		await runSubagent({
			config: {
				name: 'test-subagent',
				instructions: 'Test instructions',
				tools: {},
			},
			context: createTestContext(),
			hooks,
			model: mockModel,
		});

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining('"from":"SFO"'),
				system: expect.stringContaining('"from": "SFO"'),
			}),
		);
	});

	it('omits args from prompt when args are empty', async () => {
		const { generateText } = await import('ai');
		const hooks = new HooksManager();

		await runSubagent({
			config: {
				name: 'test-subagent',
				instructions: 'Test instructions',
				tools: {},
			},
			context: createTestContext({
				task: {
					description: 'Do something',
					toolCallId: 'tc_2',
					toolName: 'noop',
					args: {},
				},
			}),
			hooks,
			model: mockModel,
		});

		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: 'Execute the task: Do something',
			}),
		);
	});

	it('fires onSubagentStep hook', async () => {
		const hooks = new HooksManager();
		const onSubagentStep = vi.fn();
		hooks.register({ onSubagentStep });

		await runSubagent({
			config: {
				name: 'test-subagent',
				instructions: 'Test instructions',
				tools: {},
			},
			context: createTestContext(),
			hooks,
			model: mockModel,
		});

		expect(onSubagentStep).toHaveBeenCalledWith(
			expect.objectContaining({
				subagentName: 'test-subagent',
				stepNumber: 1,
				toolCalls: ['search'],
				tokensUsed: 100,
			}),
		);
	});

	it('returns SubagentResult with text and stepCount', async () => {
		const hooks = new HooksManager();
		const result = await runSubagent({
			config: {
				name: 'test-subagent',
				instructions: 'Test instructions',
				tools: {},
			},
			context: createTestContext(),
			hooks,
			model: mockModel,
		});

		expect(result.text).toBe('Subagent completed the task.');
		expect(result.stepCount).toBe(1);
	});

	it('passes abortSignal to generateText', async () => {
		const { generateText } = await import('ai');
		const hooks = new HooksManager();
		const controller = new AbortController();

		await runSubagent({
			config: {
				name: 'test-subagent',
				instructions: 'Test instructions',
				tools: {},
			},
			context: createTestContext(),
			hooks,
			model: mockModel,
			abortSignal: controller.signal,
		});

		// The internal timeout controller's signal is passed (not the caller's directly),
		// but caller abort propagates to it — verify an AbortSignal is always provided
		expect(generateText).toHaveBeenCalledWith(
			expect.objectContaining({
				abortSignal: expect.any(AbortSignal),
			}),
		);
	});

	it('propagates caller abort to generateText signal', async () => {
		const { generateText } = await import('ai');
		const hooks = new HooksManager();
		const controller = new AbortController();

		// Capture the signal passed to generateText and abort the caller mid-execution
		let capturedSignal: AbortSignal | undefined;
		vi.mocked(generateText).mockImplementationOnce(async (opts: { abortSignal?: AbortSignal }) => {
			capturedSignal = opts.abortSignal;
			// Abort the caller while generateText is still in-flight
			controller.abort();
			expect(capturedSignal?.aborted).toBe(true);
			return { text: 'done' } as ReturnType<typeof generateText>;
		});

		await runSubagent({
			config: {
				name: 'test-subagent',
				instructions: 'Test instructions',
				tools: {},
			},
			context: createTestContext(),
			hooks,
			model: mockModel,
			abortSignal: controller.signal,
		});

		expect(capturedSignal).toBeDefined();
	});

	describe('interactive session (ask_user)', () => {
		it('injects ask_user tool when config.interactive is true', async () => {
			const { generateText } = await import('ai');
			const hooks = new HooksManager();
			const session = new SubagentSessionImpl('tc-1', {
				name: 'interactive-agent',
				instructions: '',
				tools: {},
				interactive: true,
			});

			await runSubagent({
				config: {
					name: 'interactive-agent',
					instructions: 'Test',
					tools: {},
					interactive: true,
				},
				context: createTestContext(),
				hooks,
				model: mockModel,
				session,
			});

			expect(generateText).toHaveBeenCalledWith(
				expect.objectContaining({
					tools: expect.objectContaining({
						ask_user: expect.anything(),
					}),
				}),
			);
		});

		it('does not inject ask_user when config.interactive is false', async () => {
			const { generateText } = await import('ai');
			const hooks = new HooksManager();

			await runSubagent({
				config: {
					name: 'non-interactive',
					instructions: 'Test',
					tools: {},
				},
				context: createTestContext(),
				hooks,
				model: mockModel,
			});

			const callArgs = vi.mocked(generateText).mock.calls.at(-1)?.[0] as {
				tools?: Record<string, unknown>;
			};
			expect(callArgs.tools?.ask_user).toBeUndefined();
		});

		it('completes session after successful generateText()', async () => {
			const hooks = new HooksManager();
			const session = new SubagentSessionImpl('tc-1', {
				name: 'test',
				instructions: '',
				tools: {},
				interactive: true,
			});

			await runSubagent({
				config: {
					name: 'test',
					instructions: 'Test',
					tools: {},
					interactive: true,
				},
				context: createTestContext(),
				hooks,
				model: mockModel,
				session,
			});

			expect(session.state).toBe('completed');
		});

		it('cancels session on error', async () => {
			const { generateText } = await import('ai');
			vi.mocked(generateText).mockRejectedValueOnce(new Error('LLM error'));

			const hooks = new HooksManager();
			const session = new SubagentSessionImpl('tc-1', {
				name: 'test',
				instructions: '',
				tools: {},
				interactive: true,
			});

			await expect(
				runSubagent({
					config: {
						name: 'test',
						instructions: 'Test',
						tools: {},
						interactive: true,
					},
					context: createTestContext(),
					hooks,
					model: mockModel,
					session,
				}),
			).rejects.toThrow('LLM error');

			expect(session.state).toBe('cancelled');
		});
	});
});
