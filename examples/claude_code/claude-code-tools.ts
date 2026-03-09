// SPDX-License-Identifier: MIT

import { tool } from 'ai';
import { z } from 'zod';
import type { SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import { ClaudeCodeSession } from './claude-code-client.js';
import type { ClaudePermissionMode } from './claude-code-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeCodeSubagentOptions {
	/** Working directory for all Claude sessions. */
	projectDir: string;
	/** Claude model to use (default: "claude-sonnet-4-5-20250929"). */
	model?: string;
	/** Permission mode (default: "bypassPermissions"). */
	permissionMode?: ClaudePermissionMode;
	/** Maximum agentic turns per session (default: 20). */
	maxTurns?: number;
	/** Factory that creates fresh MCP servers per session (each query() needs its own Protocol). */
	mcpServerFactory?: () => Record<string, unknown>;
	/** Additional tool patterns to auto-allow (e.g. "mcp__email__*"). */
	extraAllowedTools?: string[];
}

// ---------------------------------------------------------------------------
// Gemini ToolDefinition — declares "ask_claude" as a background tool
// ---------------------------------------------------------------------------

/**
 * ToolDefinition for the Gemini voice agent.
 * Declares `ask_claude` as a background tool that routes to the Claude
 * coding subagent via AgentRouter.handoff().
 */
export const askClaudeTool: ToolDefinition = {
	name: 'ask_claude',
	description:
		'Ask Claude to help with a coding task. Claude can read, edit, and create files in the project. ' +
		'Use this for any coding, debugging, refactoring, or file manipulation request.',
	parameters: z.object({
		task: z.string().describe('Description of the coding task for Claude to perform'),
	}),
	execution: 'background',
	pendingMessage: 'Starting a coding session with Claude...',
	async execute(args) {
		// Background tools return a description; actual execution is handled
		// by the SubagentConfig returned from createClaudeCodeSubagentConfig().
		return { task: args.task };
	},
};

// ---------------------------------------------------------------------------
// SubagentConfig factory
// ---------------------------------------------------------------------------

const RELAY_INSTRUCTIONS = `You are a relay agent that bridges between a voice assistant and Claude Code (an AI coding agent).

Your workflow:
1. If the task is ONLY a status/progress check for a previously started Claude task
   (for example "check progress", "how's it going"), do NOT call claude_code_start.
   Explain briefly that this relay cannot inspect other running Claude sessions and
   that the main assistant should wait for the background completion notification.
2. Otherwise, call claude_code_start with the user's coding task.
3. Examine the result:
   - If status is "completed": summarize the result for the user. Include the sdkSessionId in your final answer so the system can resume later.
   - If status is "error": report the error briefly to the user.
   - If status is "needs_input":
     a. If questionOptions are present: call ask_user with the question text and pass questionOptions as options (add stable id fields: "opt_0", "opt_1", etc.).
     b. If no questionOptions: call ask_user with just the question text.
4. After the user answers, call claude_code_respond with the sessionId and the user's response.
5. Repeat from step 3 until the task completes or errors.

Important rules:
- Always pass the exact sessionId from claude_code_start to claude_code_respond.
- When relaying options, map each option to a stable id: first option gets "opt_0", second gets "opt_1", etc.
- Keep summaries concise — the user is listening via voice.
- If resuming a prior session, pass the resumeSessionId to claude_code_start.

Claude Code capabilities:
- Claude Code can read, edit, create, and delete files, run commands, and search the codebase.
- Claude Code has an email tool (mcp__email__send_email) that can send emails via Apple Mail.
  When the task involves sending an email, include the COMPLETE sending instruction in the task
  passed to claude_code_start — include the recipient address, subject, and what to include in
  the body. If the recipient email address is not in the conversation context, use ask_user to
  get it BEFORE calling claude_code_start.`;

/**
 * Create a SubagentConfig for the Claude coding relay subagent.
 *
 * Uses a Map<string, ClaudeCodeSession> keyed by UUID for concurrent-safe
 * session isolation across multiple handoffs.
 */
export function createClaudeCodeSubagentConfig(
	options: ClaudeCodeSubagentOptions,
): SubagentConfig {
	const sessions = new Map<string, ClaudeCodeSession>();

	const claudeCodeStart = tool({
		description:
			'Start a new Claude Code session to execute a coding task. Returns a sessionId for follow-up calls.',
		parameters: z.object({
			task: z.string().describe('The coding task for Claude to perform'),
			resumeSessionId: z
				.string()
				.optional()
				.describe('SDK session ID from a prior result to resume that session'),
		}),
		execute: async ({ task, resumeSessionId }) => {
			const sessionId = crypto.randomUUID();
			const session = new ClaudeCodeSession({
				cwd: options.projectDir,
				model: options.model,
				permissionMode: options.permissionMode,
				maxTurns: options.maxTurns,
				mcpServers: options.mcpServerFactory?.(),
				extraAllowedTools: options.extraAllowedTools,
			});
			sessions.set(sessionId, session);

			try {
				const result = resumeSessionId
					? await session.resume(task, resumeSessionId)
					: await session.start(task);

				// Clean up completed/errored sessions
				if (result.status !== 'needs_input') {
					sessions.delete(sessionId);
				}

				return {
					sessionId,
					sdkSessionId: result.sdkSessionId,
					status: result.status,
					text: result.text,
					question: result.question,
					questionOptions: result.questionOptions,
					cost: result.cost,
					turns: result.turns,
					error: result.error,
				};
			} catch (err) {
				sessions.delete(sessionId);
				throw err;
			}
		},
	});

	const claudeCodeRespond = tool({
		description:
			"Send the user's response to a Claude Code session that is waiting for input.",
		parameters: z.object({
			sessionId: z.string().describe('The sessionId returned by claude_code_start'),
			response: z.string().describe("The user's response to Claude's question"),
		}),
		execute: async ({ sessionId, response }) => {
			const session = sessions.get(sessionId);
			if (!session) {
				throw new Error(`No active Claude Code session with id "${sessionId}"`);
			}

			const result = await session.respond(response);

			// Clean up completed/errored sessions
			if (result.status !== 'needs_input') {
				sessions.delete(sessionId);
			}

			return {
				sessionId,
				sdkSessionId: result.sdkSessionId,
				status: result.status,
				text: result.text,
				question: result.question,
				questionOptions: result.questionOptions,
				cost: result.cost,
				turns: result.turns,
				error: result.error,
			};
		},
	});

	return {
		name: 'claude-code-relay',
		instructions: RELAY_INSTRUCTIONS,
		tools: {
			claude_code_start: claudeCodeStart,
			claude_code_respond: claudeCodeRespond,
		},
		maxSteps: 20,
		timeout: 600_000,
		interactive: true,
		// Each handoff should get an isolated session map to prevent cross-talk.
		createInstance: () => createClaudeCodeSubagentConfig(options),
		async dispose() {
			const abortPromises = [...sessions.values()].map((s) => s.abort());
			await Promise.allSettled(abortPromises);
			sessions.clear();
		},
	};
}

// Expose for testing
export { ClaudeCodeSession as _ClaudeCodeSessionClass };
