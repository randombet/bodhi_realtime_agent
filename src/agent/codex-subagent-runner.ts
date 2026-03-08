// SPDX-License-Identifier: MIT

import { Codex } from '@openai/codex-sdk';
import type { HooksManager } from '../core/hooks.js';
import type { SubagentConfig } from '../types/agent.js';
import type { SubagentContextSnapshot, SubagentResult } from '../types/conversation.js';
import type { InteractiveSubagentConfig, SubagentSession } from './subagent-session.js';

interface RunCodexSubagentOptions {
	config: SubagentConfig;
	context: SubagentContextSnapshot;
	hooks: HooksManager;
	abortSignal?: AbortSignal;
	session?: SubagentSession;
}

function buildCodexPrompt(context: SubagentContextSnapshot): string {
	const parts: string[] = [];
	parts.push(`# Instructions\n${context.agentInstructions}`);
	parts.push(`\n# Task\n${context.task.description}`);

	if (Object.keys(context.task.args).length > 0) {
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

	parts.push('\nUse available coding tools to inspect, edit, and validate changes.');
	return parts.join('\n');
}

async function runSingleCodexTurn(
	thread: ReturnType<Codex['startThread']>,
	input: string,
	options: RunCodexSubagentOptions,
): Promise<{ finalResponse: string; stepCount: number }> {
	const streamed = await thread.runStreamed(input, { signal: options.abortSignal });
	let finalResponse = '';
	let stepCount = 0;

	for await (const event of streamed.events) {
		if (event.type !== 'item.completed') {
			continue;
		}

		stepCount++;
		if (options.hooks.onSubagentStep) {
			options.hooks.onSubagentStep({
				subagentName: options.config.name,
				stepNumber: stepCount,
				toolCalls: [event.item.type],
				tokensUsed: 0,
			});
		}

		if (event.item.type === 'agent_message') {
			finalResponse = event.item.text;
		}
		if (options.session && event.item.type === 'command_execution') {
			options.session.sendToUser({
				type: 'progress',
				text: `Codex ran: ${event.item.command}`,
			});
		}
	}

	return { finalResponse, stepCount };
}

export async function runCodexSubagent(options: RunCodexSubagentOptions): Promise<SubagentResult> {
	const codex = new Codex({
		apiKey: options.config.codex?.apiKey,
		baseUrl: options.config.codex?.baseUrl,
		config: options.config.codex?.config as never,
	});

	const thread = codex.startThread({
		model: options.config.codex?.model,
		approvalPolicy: options.config.codex?.approvalPolicy,
		sandboxMode: options.config.codex?.sandboxMode,
		workingDirectory: options.config.codex?.workingDirectory,
		networkAccessEnabled: options.config.codex?.networkAccessEnabled,
		skipGitRepoCheck: options.config.codex?.skipGitRepoCheck,
	});

	let totalStepCount = 0;
	let prompt = buildCodexPrompt(options.context);
	let finalResponse = '';

	while (true) {
		const turn = await runSingleCodexTurn(thread, prompt, options);
		totalStepCount += turn.stepCount;
		finalResponse = turn.finalResponse;

		if (!options.session || !options.config.interactive) {
			break;
		}

		options.session.sendToUser({
			type: 'question',
			text: `${finalResponse}\n\nProvide follow-up coding instructions, or reply "done" to finish.`,
			blocking: true,
		});
		const followUp = await options.session.waitForInput(
			(options.config as InteractiveSubagentConfig).inputTimeout,
		);
		if (/^\s*(done|stop|no)\s*$/i.test(followUp)) {
			break;
		}
		prompt = followUp;
	}

	const result: SubagentResult = {
		text: finalResponse,
		stepCount: totalStepCount,
	};

	if (options.session) {
		options.session.complete(result);
	}

	return result;
}

export const _buildCodexPromptForTest = buildCodexPrompt;
