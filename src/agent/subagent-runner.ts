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

function isSubagentDebugLogging(): boolean {
	return process.env.LOG_LEVEL === 'debug';
}

/** Best-effort model id for logs (`@ai-sdk/*` models usually set `modelId`). */
function reasoningModelLabelForLog(model: LanguageModelV1): string {
	const m = model as { modelId?: string };
	return typeof m.modelId === 'string' && m.modelId.length > 0
		? m.modelId
		: '(LanguageModelV1: no modelId)';
}

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
 *
 * Supports optional structured `options` with stable IDs for dual-channel
 * delivery (voice + UI buttons). When options are present, a `uiPayload`
 * is included so the client can render clickable buttons.
 */
export function createAskUserTool(session: SubagentSession, maxInputRetries: number) {
	let consecutiveTimeouts = 0;

	return tool({
		description:
			'Ask the user a question and wait for their response. Use this when you need information from the user to proceed. Optionally provide structured options for UI buttons.',
		parameters: z.object({
			question: z.string().describe('The question to ask the user'),
			options: z
				.array(
					z.object({
						id: z.string().describe('Stable identifier for this option (e.g. "opt_0")'),
						label: z.string().describe('Short display label'),
						description: z.string().describe('What this option means'),
					}),
				)
				.optional()
				.describe(
					'Structured choices for the user. If present, sent via UI payload for clickable buttons.',
				),
		}),
		execute: async ({ question, options }) => {
			consecutiveTimeouts = 0; // Reset on new question

			// Build uiPayload when structured options are present
			const requestId = options ? crypto.randomUUID() : undefined;
			if (options && requestId) {
				session.registerUiRequest(requestId, options);
			}

			session.sendToUser({
				type: 'question',
				text: question,
				blocking: true,
				uiPayload: options
					? {
							type: 'choice' as const,
							requestId,
							data: { options },
						}
					: undefined,
			});

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
	const runWallStartedAt = Date.now();
	const dbg = isSubagentDebugLogging();

	// Compose timeout signal with caller-provided abort signal
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const onCallerAbort = () => controller.abort();
	abortSignal?.addEventListener('abort', onCallerAbort);

	// Fire-and-forget dispose on abort (can't await inside event listener).
	// The finally block also awaits dispose, so cleanup completes either way.
	const onAbortDispose = () => {
		config.dispose?.();
	};
	controller.signal.addEventListener('abort', onAbortDispose);

	// Build tool set — inject ask_user when interactive
	const tools = { ...config.tools } as Record<string, unknown>;
	if (config.interactive && session) {
		const maxRetries = (config as InteractiveSubagentConfig).maxInputRetries ?? 3;
		(tools as Record<string, unknown>).ask_user = createAskUserTool(session, maxRetries);
	}

	let stepCount = 0;

	try {
		const systemPrompt = buildSystemPrompt(context);
		if (dbg) {
			const cap = 12_000;
			const body =
				systemPrompt.length > cap
					? `${systemPrompt.slice(0, cap)}\n…[truncated ${systemPrompt.length - cap} chars]`
					: systemPrompt;
			console.log(
				`[Subagent:${config.name}] system prompt (${systemPrompt.length} chars):\n${body}`,
			);
			console.log(`[Subagent:${config.name}] available tools: [${Object.keys(tools).join(', ')}]`);
			console.log(
				`[Subagent:run:generateText:start] name=${config.name} modelId=${reasoningModelLabelForLog(model)} maxSteps=${maxSteps} timeoutMs=${timeoutMs}`,
			);
		}

		const generateTextStartedAt = Date.now();
		const result = await generateText({
			model,
			system: systemPrompt,
			prompt:
				Object.keys(context.task.args).length > 0
					? `Execute the task: ${context.task.description}\nArguments: ${JSON.stringify(context.task.args)}`
					: `Execute the task: ${context.task.description}`,
			tools: tools as Parameters<typeof generateText>[0]['tools'],
			maxSteps,
			abortSignal: controller.signal,
			onStepFinish: (step) => {
				stepCount++;
				// Debug logging: tool calls with args and results
				if (dbg) {
					if (step.toolCalls?.length) {
						for (const tc of step.toolCalls) {
							console.log(
								`[Subagent:${config.name}] step#${stepCount} tool=${tc.toolName} args=${JSON.stringify(tc.args)}`,
							);
						}
					}
					if (step.toolResults?.length) {
						for (const tr of step.toolResults as Array<{ toolName: string; result: unknown }>) {
							const resultStr = JSON.stringify(tr.result);
							const truncated =
								resultStr.length > 500 ? `${resultStr.slice(0, 500)}...` : resultStr;
							console.log(
								`[Subagent:${config.name}] step#${stepCount} result(${tr.toolName})=${truncated}`,
							);
						}
					}
					if (step.text) {
						const truncated = step.text.length > 300 ? `${step.text.slice(0, 300)}...` : step.text;
						console.log(`[Subagent:${config.name}] step#${stepCount} text=${truncated}`);
					}
				}
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
		if (dbg) {
			const usage = result.usage ?? {};
			const finishReason = (result as { finishReason?: string }).finishReason;
			console.log(
				`[Subagent:run:generateText:ok] name=${config.name} generateTextMs=${Date.now() - generateTextStartedAt} wallMs=${Date.now() - runWallStartedAt} steps=${stepCount} finishReason=${finishReason ?? 'n/a'} usage=${JSON.stringify(usage)}`,
			);
		}

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
		if (dbg) {
			console.warn(
				`[Subagent:run:generateText:error] name=${config.name} wallMs=${Date.now() - runWallStartedAt} message=${err instanceof Error ? err.message : String(err)}`,
			);
		}
		// Terminal transition: cancel on error
		if (session) {
			session.cancel();
		}
		throw err;
	} finally {
		clearTimeout(timer);
		abortSignal?.removeEventListener('abort', onCallerAbort);
		controller.signal.removeEventListener('abort', onAbortDispose);
		await config.dispose?.();
	}
}

export { buildSystemPrompt as _buildSystemPromptForTest };
