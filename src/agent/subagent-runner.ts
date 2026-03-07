// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '../core/constants.js';
import type { HooksManager } from '../core/hooks.js';
import type { SubagentConfig } from '../types/agent.js';
import type { SubagentContextSnapshot, SubagentResult } from '../types/conversation.js';
import { InputTimeoutError } from './subagent-session.js';
import type { InteractiveSubagentConfig, SubagentSession } from './subagent-session.js';

/** Options for running a background subagent via the Vercel AI SDK. */
export interface RunSubagentOptions {
	/** Subagent configuration (instructions, tools, maxSteps). */
	config: SubagentConfig;
	/** Conversation snapshot providing context for the subagent. */
	context: SubagentContextSnapshot;
	/** Hook manager for onSubagentStep notifications. */
	hooks: HooksManager;
	/** Language model to use for the subagent's generateText call. */
	model: LanguageModelV1;
	/** Signal to abort the subagent execution (e.g. on tool cancellation). */
	abortSignal?: AbortSignal;
	/** Interactive session for user input. Required when config.interactive is true. */
	session?: SubagentSession;
}

/**
 * Assemble a system prompt from the conversation snapshot.
 * Includes agent instructions, task description, summary, recent turns, and memory facts.
 */
function buildSystemPrompt(context: SubagentContextSnapshot): string {
	const parts: string[] = [];

	parts.push(`# Instructions\n${context.agentInstructions}`);
	parts.push(`\n# Task\n${context.task.description}`);

	if (context.task.args && Object.keys(context.task.args).length > 0) {
		parts.push(`\n# Task Arguments\n${JSON.stringify(context.task.args, null, 2)}`);
	}

	if (context.conversationSummary) {
		parts.push(`\n# Conversation Summary\n${context.conversationSummary}`);
	}

	if (context.recentTurns.length > 0) {
		const turns = context.recentTurns.map((t) => `[${t.role}]: ${t.content}`).join('\n');
		parts.push(`\n# Recent Conversation\n${turns}`);
	}

	if (context.relevantMemoryFacts.length > 0) {
		const facts = context.relevantMemoryFacts.map((f) => `- ${f.content}`).join('\n');
		parts.push(`\n# Relevant Memory\n${facts}`);
	}

	return parts.join('\n');
}

/**
 * Create an AI SDK `tool()` that lets the subagent ask the user a question
 * and wait for a response via the interactive SubagentSession.
 */
export function createAskUserTool(session: SubagentSession, maxInputRetries: number) {
	let consecutiveTimeouts = 0;

	return tool({
		description:
			'Ask the user a question and wait for their response. Use this when you need information from the user to proceed.',
		parameters: z.object({
			question: z.string().describe('The question to ask the user'),
		}),
		execute: async ({ question }) => {
			consecutiveTimeouts = 0; // Reset on new question
			session.sendToUser({ type: 'question', text: question, blocking: true });

			try {
				const text = await session.waitForInput();
				return { userResponse: text };
			} catch (err) {
				if (err instanceof InputTimeoutError) {
					consecutiveTimeouts++;
					if (consecutiveTimeouts >= maxInputRetries) {
						throw new Error(
							`User did not respond after ${consecutiveTimeouts} attempts. Aborting.`,
						);
					}
					return {
						error: `The user did not respond in time. You may re-ask or try a different question. (attempt ${consecutiveTimeouts}/${maxInputRetries})`,
					};
				}
				throw err;
			}
		},
	});
}

/**
 * Execute a background subagent using the Vercel AI SDK's generateText.
 * Fires onSubagentStep hooks after each LLM step.
 * Returns the final text result and step count.
 *
 * When `config.interactive` is true and a `session` is provided, an `ask_user`
 * tool is injected and this function owns the session's terminal transitions
 * (complete on success, cancel on error).
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentResult> {
	const { config, context, hooks, model, abortSignal, session } = options;
	const maxSteps = config.maxSteps ?? 5;
	const timeoutMs = config.timeout ?? DEFAULT_SUBAGENT_TIMEOUT_MS;

	// Compose timeout signal with caller-provided abort signal
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onCallerAbort = () => controller.abort();
	abortSignal?.addEventListener('abort', onCallerAbort);

	// Build tool set — inject ask_user when interactive
	const tools = { ...config.tools } as Record<string, unknown>;
	if (config.interactive && session) {
		const maxRetries = (config as InteractiveSubagentConfig).maxInputRetries ?? 3;
		(tools as Record<string, unknown>).ask_user = createAskUserTool(session, maxRetries);
	}

	let stepCount = 0;

	try {
		const result = await generateText({
			model,
			system: buildSystemPrompt(context),
			prompt:
				Object.keys(context.task.args).length > 0
					? `Execute the task: ${context.task.description}\nArguments: ${JSON.stringify(context.task.args)}`
					: `Execute the task: ${context.task.description}`,
			tools: tools as Parameters<typeof generateText>[0]['tools'],
			maxSteps,
			abortSignal: controller.signal,
			onStepFinish: (step) => {
				stepCount++;
				if (hooks.onSubagentStep) {
					hooks.onSubagentStep({
						subagentName: config.name,
						stepNumber: stepCount,
						toolCalls: step.toolCalls?.map((tc: { toolName: string }) => tc.toolName) ?? [],
						tokensUsed: step.usage?.totalTokens ?? 0,
					});
				}
			},
		});

		const subagentResult: SubagentResult = {
			text: result.text,
			stepCount,
		};

		// Terminal transition: complete on success
		if (session) {
			session.complete(subagentResult);
		}

		return subagentResult;
	} catch (err) {
		// Terminal transition: cancel on error
		if (session) {
			session.cancel();
		}
		throw err;
	} finally {
		clearTimeout(timer);
		abortSignal?.removeEventListener('abort', onCallerAbort);
	}
}

export { buildSystemPrompt as _buildSystemPromptForTest };
