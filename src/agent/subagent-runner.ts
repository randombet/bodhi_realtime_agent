import type { LanguageModelV1 } from 'ai';
import { generateText } from 'ai';
import type { HooksManager } from '../core/hooks.js';
import type { SubagentConfig } from '../types/agent.js';
import type { SubagentContextSnapshot, SubagentResult } from '../types/conversation.js';

export interface RunSubagentOptions {
	config: SubagentConfig;
	context: SubagentContextSnapshot;
	hooks: HooksManager;
	model: LanguageModelV1;
	abortSignal?: AbortSignal;
}

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
