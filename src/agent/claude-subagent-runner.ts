// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process';
import { AgentError } from '../core/errors.js';
import type { HooksManager } from '../core/hooks.js';
import type { ClaudeCodeSubagentConfig } from '../types/agent.js';
import type { SubagentContextSnapshot, SubagentResult } from '../types/conversation.js';
import type { SubagentSession } from './subagent-session.js';

export interface RunClaudeCodeSubagentOptions {
	config: ClaudeCodeSubagentConfig;
	context: SubagentContextSnapshot;
	hooks: HooksManager;
	abortSignal?: AbortSignal;
	session?: SubagentSession;
}

interface ClaudeSubagentContract {
	status: 'completed' | 'needs_input';
	message: string;
	question?: string | null;
}

function buildClaudePrompt(context: SubagentContextSnapshot): string {
	const parts: string[] = [
		`Task: ${context.task.description}`,
		`Task arguments: ${JSON.stringify(context.task.args, null, 2)}`,
		`Subagent instructions: ${context.agentInstructions}`,
		'You are running as a coding subagent. Return ONLY strict JSON that matches this schema:',
		'{"status":"completed|needs_input","message":"string","question":"string|null"}',
		'Use needs_input only when a user clarification is required before you can continue.',
	];

	if (context.conversationSummary) {
		parts.push(`Conversation summary: ${context.conversationSummary}`);
	}
	if (context.recentTurns.length > 0) {
		parts.push(
			`Recent turns:\n${context.recentTurns.map((turn) => `[${turn.role}] ${turn.content}`).join('\n')}`,
		);
	}

	return parts.join('\n\n');
}

function parseStructuredFromText(text: string): ClaudeSubagentContract {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		throw new AgentError('Claude CLI returned empty output');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		const maybeJson = trimmed
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
			.find((line) => line.startsWith('{') && line.endsWith('}'));
		if (!maybeJson) {
			throw new AgentError('Claude CLI output is not valid JSON for subagent contract');
		}
		parsed = JSON.parse(maybeJson);
	}

	const obj = parsed as Record<string, unknown>;
	const status = obj.status;
	const message = obj.message;
	const question = obj.question;
	if ((status !== 'completed' && status !== 'needs_input') || typeof message !== 'string') {
		throw new AgentError('Claude CLI JSON does not match expected subagent contract');
	}
	if (question !== undefined && question !== null && typeof question !== 'string') {
		throw new AgentError('Claude CLI JSON question must be string|null when present');
	}

	return {
		status,
		message,
		question: question === undefined ? null : question,
	};
}

async function runClaudeCliTurn(
	config: ClaudeCodeSubagentConfig,
	prompt: string,
	abortSignal?: AbortSignal,
): Promise<ClaudeSubagentContract> {
	const command = config.claude?.command ?? 'claude';
	const args: string[] = ['-p', prompt, '--output-format', 'json'];

	if (config.claude?.model) {
		args.push('--model', config.claude.model);
	}
	if (config.claude?.permissionMode) {
		args.push('--permission-mode', config.claude.permissionMode);
	}
	if (config.claude?.allowedTools && config.claude.allowedTools.length > 0) {
		args.push('--allowedTools', config.claude.allowedTools.join(','));
	}
	if (config.claude?.maxTurns) {
		args.push('--max-turns', String(config.claude.maxTurns));
	}
	if (config.claude?.extraArgs && config.claude.extraArgs.length > 0) {
		args.push(...config.claude.extraArgs);
	}

	const output = await new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: config.claude?.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';

		const onAbort = () => child.kill('SIGTERM');
		abortSignal?.addEventListener('abort', onAbort);

		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		child.on('error', (err) => {
			abortSignal?.removeEventListener('abort', onAbort);
			reject(new AgentError(`Failed to launch Claude CLI: ${err.message}`));
		});

		child.on('close', (code) => {
			abortSignal?.removeEventListener('abort', onAbort);
			if (code !== 0) {
				reject(new AgentError(`Claude CLI failed (code ${code}): ${stderr || stdout}`));
				return;
			}
			resolve(stdout);
		});
	});

	return parseStructuredFromText(output);
}

export async function runClaudeCodeSubagent(
	options: RunClaudeCodeSubagentOptions,
): Promise<SubagentResult> {
	const { config, context, hooks, abortSignal, session } = options;
	const maxSteps = config.maxSteps ?? 6;
	let prompt = buildClaudePrompt(context);

	for (let step = 1; step <= maxSteps; step++) {
		const turn = await runClaudeCliTurn(config, prompt, abortSignal);

		hooks.onSubagentStep?.({
			subagentName: config.name,
			stepNumber: step,
			toolCalls: ['claude_cli_turn'],
			tokensUsed: 0,
		});

		if (turn.status === 'needs_input') {
			if (!session) {
				throw new AgentError(
					'Claude subagent requested input but no interactive session is available',
				);
			}

			const question = turn.question ?? turn.message;
			session.sendToUser({ type: 'question', text: question, blocking: true });
			const userReply = await session.waitForInput();
			prompt = [
				'Continue the same task based on the user clarification below.',
				`User clarification: ${userReply}`,
				'Return strict JSON matching the same schema.',
			].join('\n\n');
			continue;
		}

		const result: SubagentResult = { text: turn.message, stepCount: step };
		session?.complete(result);
		return result;
	}

	session?.cancel();
	throw new AgentError(`Claude subagent exceeded maxSteps (${maxSteps}) without completion`);
}

export { buildClaudePrompt as _buildClaudePromptForTest };
