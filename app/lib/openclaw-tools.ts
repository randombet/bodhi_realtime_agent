// SPDX-License-Identifier: MIT

import { tool } from 'ai';
import { z } from 'zod';
import type { SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { OpenClawClient } from './openclaw-client.js';

/**
 * Framework ToolDefinition for the main voice agent (declared to Gemini/OpenAI).
 * execution: 'background' — routes to AgentRouter.handoff() when a matching SubagentConfig exists.
 * The execute body is NOT called by the framework; it's a placeholder for the tool router.
 */
export const askOpenClawTool: ToolDefinition = {
	name: 'ask_openclaw',
	description:
		'Delegate a task to the OpenClaw AI agent. ' +
		'The agent is general-purpose and can handle coding, research, web browsing, ' +
		'writing, sending emails, and much more. Route any user request here.',
	parameters: z.object({
		task: z.string().describe('The task to delegate to OpenClaw'),
	}),
	execution: 'background',
	pendingMessage:
		"I'm sending that to my agent now. I'll let you know what it finds.",
	execute: async () => {
		// Placeholder — ToolCallRouter routes to AgentRouter.handoff() when
		// matching SubagentConfig exists. This body is never reached.
		return { text: 'Routed to subagent', stepCount: 0 };
	},
};

/**
 * Create the OpenClaw SubagentConfig for interactive subagent delegation.
 *
 * The subagent is given an `openclaw_chat` AI SDK tool that sends messages to
 * the OpenClaw gateway and collects the streaming response. When OpenClaw
 * returns `needs_input`, the subagent LLM uses the injected `ask_user` tool
 * (provided by runSubagent when interactive=true) to relay the question to the
 * user via voice, then calls `openclaw_chat` again with the answer.
 */
export function createOpenClawSubagentConfig(
	client: OpenClawClient,
	sessionId: string,
): SubagentConfig {
	const sessionKey = client.sessionKey(sessionId);

	return {
		name: 'openclaw',
		interactive: true,
		instructions: [
			'You are a relay agent between the user and the OpenClaw AI agent.',
			'OpenClaw is a general-purpose agent — it can handle coding, research,',
			'web browsing, writing, emails, and much more.',
			'',
			'WORKFLOW:',
			'1. Call openclaw_chat with the task from the user.',
			'2. If the result has status "needs_input", OpenClaw is asking a clarifying question.',
			'   - The "text" field contains OpenClaw\'s response including the question.',
			'   - Use ask_user to relay the question to the user via voice.',
			'   - When phrasing the question for ask_user, be concise — extract the key question from OpenClaw\'s response.',
			'   - Call openclaw_chat with the user\'s answer to continue.',
			'3. If the result has status "completed", OpenClaw has finished the task.',
			'   - Return a brief voice-friendly summary of what was done.',
			'   - Do NOT read out code verbatim — summarize the outcome.',
			'4. If the result has an error, tell the user what went wrong briefly.',
			'',
			'IMPORTANT:',
			'- Always relay OpenClaw\'s questions to the user — never answer on their behalf.',
			'- Keep your voice summaries short (2-3 sentences max).',
			'- The user is listening via audio — no markdown, no code blocks in your final answer.',
		].join('\n'),
		tools: {
			openclaw_chat: createOpenClawChatTool(client, sessionKey),
		},
		maxSteps: 12, // Allow for multi-turn: chat → ask_user → chat → ask_user → ...
		timeout: 300_000, // 5 min for complex coding tasks
	};
}

/**
 * AI SDK tool that sends a message to the OpenClaw gateway and collects the
 * full streaming response. Returns the accumulated text and final disposition.
 */
function createOpenClawChatTool(client: OpenClawClient, sessionKey: string) {
	return tool({
		description:
			'Send a message to the OpenClaw AI agent and get the response. ' +
			'Returns { status, text } where status is "completed", "needs_input", or "error".',
		parameters: z.object({
			message: z.string().describe('The message to send to OpenClaw'),
		}),
		execute: async ({ message }) => {
			console.log(`[OpenClaw] Sending message (sessionKey=${sessionKey}): ${message.slice(0, 200)}`);
			try {
				const { runId } = await client.chatSend(sessionKey, message);
				console.log(`[OpenClaw] Run started: ${runId}`);
				let text = '';

				while (true) {
					const event = await client.nextChatEvent(runId);

					if (event.state === 'delta') {
						text = event.text ?? text;
					} else if (event.state === 'final') {
						text = event.text ?? text;
						console.log(`[OpenClaw] Run ${runId} completed (${event.finalDisposition}): ${text.slice(0, 200)}`);
						return {
							status: event.finalDisposition ?? 'completed',
							text,
						};
					} else if (event.state === 'error' || event.state === 'aborted') {
						console.log(`[OpenClaw] Run ${runId} ${event.state}: ${event.error}`);
						return {
							status: 'error',
							error: event.error ?? `OpenClaw run ${event.state}`,
						};
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[OpenClaw] Error sending message: ${msg}`);
				return { status: 'error', error: msg };
			}
		},
	});
}
