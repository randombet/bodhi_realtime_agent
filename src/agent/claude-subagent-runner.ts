// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process';
import { AgentError } from '../core/errors.js';
import type { HooksManager } from '../core/hooks.js';
import type { ClaudeCodingSubagentConfig } from '../types/agent.js';
import type { SubagentContextSnapshot, SubagentResult } from '../types/conversation.js';
import type { SubagentSession } from './subagent-session.js';

const BRIDGE_PYTHON_CODE = String.raw`
import asyncio
import json
import sys

from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import AssistantMessage, ResultMessage, TextBlock


async def run(payload: dict):
    cfg = payload.get("config", {})
    options = ClaudeAgentOptions(
        system_prompt=(
            payload.get("subagentInstructions", "")
            + "\n\nYou must return strict JSON matching this schema:"
            + '{"status":"completed|needs_input","message":"string","question":"string|null"}'
            + "\nUse status=needs_input only if user input is required before you can continue."
        ),
        model=cfg.get("model"),
        permission_mode=cfg.get("permissionMode"),
        allowed_tools=cfg.get("allowedTools", []),
        max_turns=cfg.get("maxTurns"),
        cwd=cfg.get("cwd"),
        continue_conversation=bool(payload.get("sessionId")),
        resume=payload.get("sessionId"),
        output_format={
            "type": "json_schema",
            "name": "subagent_response",
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "status": {"type": "string", "enum": ["completed", "needs_input"]},
                    "message": {"type": "string"},
                    "question": {"type": ["string", "null"]},
                },
                "required": ["status", "message", "question"],
            },
        },
    )

    assistant_text = ""
    session_id = payload.get("sessionId")
    structured_output = None

    async for message in query(prompt=payload["prompt"], options=options):
        if isinstance(message, AssistantMessage):
            text_parts = [block.text for block in message.content if isinstance(block, TextBlock)]
            if text_parts:
                assistant_text = "\n".join(text_parts)
        elif isinstance(message, ResultMessage):
            session_id = message.session_id
            if message.structured_output is not None:
                structured_output = message.structured_output
            elif message.result:
                try:
                    structured_output = json.loads(message.result)
                except Exception:
                    pass

    return {
        "sessionId": session_id,
        "assistantText": assistant_text,
        "structuredOutput": structured_output,
        "isError": False,
    }


payload = json.loads(sys.argv[1])
result = asyncio.run(run(payload))
print(json.dumps(result))
`;

export interface RunClaudeSubagentOptions {
	config: ClaudeCodingSubagentConfig;
	context: SubagentContextSnapshot;
	hooks: HooksManager;
	abortSignal?: AbortSignal;
	session?: SubagentSession;
}

interface ClaudeBridgeResponse {
	sessionId?: string;
	assistantText?: string;
	structuredOutput?: { status?: string; message?: string; question?: string | null };
	isError?: boolean;
	error?: string;
}

function buildClaudeTaskPrompt(context: SubagentContextSnapshot): string {
	const parts: string[] = [];
	parts.push(`Task: ${context.task.description}`);
	if (Object.keys(context.task.args).length > 0) {
		parts.push(`Task arguments: ${JSON.stringify(context.task.args, null, 2)}`);
	}
	if (context.conversationSummary) {
		parts.push(`Conversation summary: ${context.conversationSummary}`);
	}
	if (context.recentTurns.length > 0) {
		parts.push(
			`Recent turns:\n${context.recentTurns.map((t) => `[${t.role}] ${t.content}`).join('\n')}`,
		);
	}
	parts.push(
		'Solve the task. If you need clarification, set status="needs_input" and ask a concise question.',
	);
	return parts.join('\n\n');
}

async function runBridgeTurn(
	input: {
		prompt: string;
		sessionId?: string;
		config: ClaudeCodingSubagentConfig;
	},
	abortSignal?: AbortSignal,
): Promise<ClaudeBridgeResponse> {
	const pythonBin = input.config.claude?.pythonBin ?? 'python3';
	const payload = JSON.stringify({
		prompt: input.prompt,
		sessionId: input.sessionId,
		config: input.config.claude ?? {},
		subagentInstructions: input.config.instructions,
	});
	const bridgePath = input.config.claude?.bridgeScriptPath;
	const args = bridgePath ? [bridgePath, payload] : ['-c', BRIDGE_PYTHON_CODE, payload];

	return new Promise<ClaudeBridgeResponse>((resolve, reject) => {
		const child = spawn(pythonBin, args, {
			cwd: input.config.claude?.cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';

		const onAbort = () => child.kill('SIGTERM');
		abortSignal?.addEventListener('abort', onAbort);

		child.stdout.on('data', (d) => {
			stdout += d.toString();
		});
		child.stderr.on('data', (d) => {
			stderr += d.toString();
		});
		child.on('error', (err) => {
			abortSignal?.removeEventListener('abort', onAbort);
			reject(err);
		});
		child.on('close', (code) => {
			abortSignal?.removeEventListener('abort', onAbort);
			if (code !== 0) {
				reject(new AgentError(`Claude bridge failed (code ${code}): ${stderr || stdout}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout.trim()) as ClaudeBridgeResponse);
			} catch (err) {
				reject(new AgentError(`Failed to parse Claude bridge output: ${String(err)}`));
			}
		});
	});
}

export async function runClaudeCodingSubagent(
	options: RunClaudeSubagentOptions,
): Promise<SubagentResult> {
	const { config, context, hooks, abortSignal, session } = options;
	const maxSteps = config.maxSteps ?? 8;
	let stepCount = 0;
	let prompt = buildClaudeTaskPrompt(context);
	let sessionId: string | undefined;

	try {
		for (let i = 0; i < maxSteps; i++) {
			stepCount++;
			const turn = await runBridgeTurn({ prompt, sessionId, config }, abortSignal);
			sessionId = turn.sessionId ?? sessionId;

			hooks.onSubagentStep?.({
				subagentName: config.name,
				stepNumber: stepCount,
				toolCalls: ['claude_code_turn'],
				tokensUsed: 0,
			});

			if (turn.isError) {
				throw new AgentError(turn.error ?? 'Claude bridge returned error');
			}

			const status = turn.structuredOutput?.status;
			if (status === 'needs_input') {
				if (!session) {
					throw new AgentError(
						'Claude subagent requested user input but no interactive session exists',
					);
				}
				const question =
					turn.structuredOutput?.question ??
					turn.structuredOutput?.message ??
					'Can you clarify your request?';
				session.sendToUser({ type: 'question', text: question, blocking: true });
				prompt = await session.waitForInput();
				continue;
			}

			const message = turn.structuredOutput?.message ?? turn.assistantText ?? '';
			const result: SubagentResult = { text: message, stepCount };
			session?.complete(result);
			return result;
		}
	} catch (err) {
		session?.cancel();
		throw err;
	}

	session?.cancel();
	throw new AgentError(`Claude subagent exceeded maxSteps (${maxSteps}) without completion`);
}
