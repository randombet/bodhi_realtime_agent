// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { generateText } from 'ai';
import type { HooksManager } from '../core/hooks.js';
import type { SubagentConfig } from '../types/agent.js';
import type { SubagentContextSnapshot, SubagentResult } from '../types/conversation.js';

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
}

/**
 * Assemble a system prompt from the conversation snapshot.
 * Includes agent instructions, task description, summary, recent turns, and memory facts.
 */
function buildSystemPrompt(context: SubagentContextSnapshot): string {
	const parts: string[] = [];

	parts.push(`# Instructions\n${context.agentInstructions}`);
	parts.push(`\n# Task\n${context.task.description}`);

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
 * Execute a background subagent using the Vercel AI SDK's generateText.
 * Fires onSubagentStep hooks after each LLM step.
 * Returns the final text result and step count.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<SubagentResult> {
	const { config, context, hooks, model, abortSignal } = options;
	const maxSteps = config.maxSteps ?? 5;

	let stepCount = 0;

	const result = await generateText({
		model,
		system: buildSystemPrompt(context),
		prompt: `Execute the task: ${context.task.description}`,
		tools: config.tools as Parameters<typeof generateText>[0]['tools'],
		maxSteps,
		abortSignal,
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

	return {
		text: result.text,
		stepCount,
	};
}

export { buildSystemPrompt as _buildSystemPromptForTest };
