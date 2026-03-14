// SPDX-License-Identifier: MIT

import { tool } from 'ai';
import { z } from 'zod';
import type { SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import { ClaudeCodeSession } from './claude-code-client.js';
import type {
	ClaudeCodeResult,
	ClaudePermissionMode,
} from './claude-code-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const CONTINUITY_MODES = ['resume_if_available', 'force_resume', 'force_fresh'] as const;

export type ContinuityMode = (typeof CONTINUITY_MODES)[number];

type ClaudeTerminalStatus = 'completed' | 'error';

export interface ClaudeExecutionRecord {
	runId: string;
	threadKey: string;
	task: string;
	summary: string;
	status: ClaudeTerminalStatus;
	sdkSessionId?: string;
	source: 'claude_code_start' | 'claude_code_respond';
	completedAt: number;
	dedupeKey: string;
}

export interface ClaudeThreadState {
	threadKey: string;
	lastCompletedSdkSessionId?: string;
	lastTerminalStatus?: ClaudeTerminalStatus;
	lastUpdatedAt: number;
	history: ClaudeExecutionRecord[];
}

export interface ClaudeCodeSessionState {
	threads: Record<string, ClaudeThreadState>;
	sessionToThread: Record<string, string>;
	maxHistoryPerThread: number;
	maxTotalHistory: number;
	nextThreadOrdinal: number;
}

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
	/** Override per-thread history cap (default: 5). */
	maxHistoryPerThread?: number;
	/** Override total history cap across all threads (default: 100). */
	maxTotalHistory?: number;
	/** Internal shared metadata state that survives createInstance() calls. */
	_state?: ClaudeCodeSessionState;
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
		threadKey: z
			.string()
			.optional()
			.describe('Optional continuity thread key. Reuse the same key for follow-up coding requests.'),
		continuityMode: z
			.enum(CONTINUITY_MODES)
			.optional()
			.describe('Optional continuity policy: resume_if_available (default), force_resume, or force_fresh.'),
	}),
	execution: 'background',
	pendingMessage: 'Starting a coding session with Claude...',
	async execute(args) {
		// Background tools return a description; actual execution is handled
		// by the SubagentConfig returned from createClaudeCodeSubagentConfig().
		return {
			task: args.task,
			threadKey: args.threadKey,
			continuityMode: args.continuityMode,
		};
	},
};

// ---------------------------------------------------------------------------
// SubagentConfig factory
// ---------------------------------------------------------------------------

const RELAY_INSTRUCTIONS = `You are a relay agent that bridges between a voice assistant and Claude Code (an AI coding agent).

Your workflow:
1. Call claude_code_start with the user's coding task.
2. Examine the result:
   - If status is "completed": summarize the result for the user. Include the sdkSessionId and threadKey in your final answer so the system can continue later.
   - If status is "error": report the error briefly to the user.
   - If status is "needs_input":
     a. If questionOptions are present: call ask_user with the question text and pass questionOptions as options (add stable id fields: "opt_0", "opt_1", etc.).
     b. If no questionOptions: call ask_user with just the question text.
3. After the user answers, call claude_code_respond with the sessionId and the user's response.
4. Repeat from step 2 until the task completes or errors.

Important rules:
- Always pass the exact sessionId from claude_code_start to claude_code_respond.
- Read threadKey and continuityMode from Task Arguments and pass them through to claude_code_start.
- Do NOT invent your own continuity policy.
- Keep summaries concise — the user is listening via voice.

Claude Code capabilities:
- Claude Code can read, edit, create, and delete files, run commands, and search the codebase.
- Claude Code has an email tool (mcp__email__send_email) that can send emails via Apple Mail.
  When the task involves sending an email, include the COMPLETE sending instruction in the task
  passed to claude_code_start — include the recipient address, subject, and what to include in
  the body. If the recipient email address is not in the conversation context, use ask_user to
  get it BEFORE calling claude_code_start.`;

const CONTINUITY_MODE_SCHEMA = z.enum(CONTINUITY_MODES);
const DEFAULT_MAX_HISTORY_PER_THREAD = 5;
const DEFAULT_MAX_TOTAL_HISTORY = 100;
const MAX_SUMMARY_CHARS = 200;
const UNKNOWN_SESSION_THREAD_MAPPING = 'unknown_session_thread_mapping';

function makeDefaultState(options: ClaudeCodeSubagentOptions): ClaudeCodeSessionState {
	return {
		threads: {},
		sessionToThread: {},
		maxHistoryPerThread: options.maxHistoryPerThread ?? DEFAULT_MAX_HISTORY_PER_THREAD,
		maxTotalHistory: options.maxTotalHistory ?? DEFAULT_MAX_TOTAL_HISTORY,
		nextThreadOrdinal: 1,
	};
}

function normalizeThreadKey(input: string | undefined): string | undefined {
	if (typeof input !== 'string') return undefined;
	const normalized = input.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function toErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function truncateSummary(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_SUMMARY_CHARS) {
		return trimmed;
	}
	return `${trimmed.slice(0, MAX_SUMMARY_CHARS)}...`;
}

function toTerminalStatus(result: { status: string }): ClaudeTerminalStatus {
	if (result.status === 'completed') return 'completed';
	return 'error';
}

function isResumeInvalidErrorMessage(message: string | undefined): boolean {
	if (!message) return false;
	const text = message.toLowerCase();
	const hasResumeOrSession = text.includes('resume') || text.includes('session');
	if (!hasResumeOrSession) return false;
	return (
		text.includes('invalid') ||
		text.includes('not found') ||
		text.includes('expired') ||
		text.includes('unknown') ||
		text.includes('does not exist')
	);
}

/**
 * Create a SubagentConfig for the Claude coding relay subagent.
 *
 * Uses an isolated Map<string, ClaudeCodeSession> per handoff for runtime safety,
 * while sharing thread continuity metadata across createInstance() calls.
 */
export function createClaudeCodeSubagentConfig(
	options: ClaudeCodeSubagentOptions,
): SubagentConfig {
	const state: ClaudeCodeSessionState = options._state ?? makeDefaultState(options);
	const sessions = new Map<string, ClaudeCodeSession>();
	const sessionTasks = new Map<string, string>();

	function createSession(): ClaudeCodeSession {
		return new ClaudeCodeSession({
			cwd: options.projectDir,
			model: options.model,
			permissionMode: options.permissionMode,
			maxTurns: options.maxTurns,
			mcpServers: options.mcpServerFactory?.(),
			extraAllowedTools: options.extraAllowedTools,
		});
	}

	function resolveThreadKey(args: { threadKey?: string; sessionId?: string }): string {
		const explicit = normalizeThreadKey(args.threadKey);
		if (explicit) {
			return explicit;
		}
		if (args.sessionId) {
			const mapped = state.sessionToThread[args.sessionId];
			if (mapped) {
				return mapped;
			}
		}
		const allocated = `claude_thread_${state.nextThreadOrdinal}`;
		state.nextThreadOrdinal += 1;
		return allocated;
	}

	function peekThreadKey(args: { threadKey?: string; sessionId?: string }): string | undefined {
		const explicit = normalizeThreadKey(args.threadKey);
		if (explicit) return explicit;
		if (args.sessionId) {
			const mapped = state.sessionToThread[args.sessionId];
			if (mapped) return mapped;
		}
		return undefined;
	}

	function getThreadState(threadKey: string): ClaudeThreadState {
		const existing = state.threads[threadKey];
		if (existing) {
			return existing;
		}
		const created: ClaudeThreadState = {
			threadKey,
			lastUpdatedAt: Date.now(),
			history: [],
		};
		state.threads[threadKey] = created;
		return created;
	}

	function totalHistoryCount(): number {
		let count = 0;
		for (const thread of Object.values(state.threads)) {
			count += thread.history.length;
		}
		return count;
	}

	function hasDedupeKey(dedupeKey: string): boolean {
		for (const thread of Object.values(state.threads)) {
			if (thread.history.some((entry) => entry.dedupeKey === dedupeKey)) {
				return true;
			}
		}
		return false;
	}

	function enforceTotalHistoryCap(): void {
		while (totalHistoryCount() > state.maxTotalHistory) {
			let oldestThread: ClaudeThreadState | null = null;
			let oldestIndex = -1;
			let oldestTs = Number.POSITIVE_INFINITY;
			for (const thread of Object.values(state.threads)) {
				for (let i = 0; i < thread.history.length; i++) {
					const candidate = thread.history[i];
					if (candidate.completedAt < oldestTs) {
						oldestTs = candidate.completedAt;
						oldestThread = thread;
						oldestIndex = i;
					}
				}
			}
			if (!oldestThread || oldestIndex < 0) {
				break;
			}
			oldestThread.history.splice(oldestIndex, 1);
		}
	}

	function recordTerminalResult(args: {
		threadKey: string;
		source: 'claude_code_start' | 'claude_code_respond';
		runId: string;
		task: string;
		result: {
			status: ClaudeTerminalStatus;
			text: string;
			error?: string;
			sdkSessionId?: string;
		};
		dedupeKey: string;
	}): void {
		if (hasDedupeKey(args.dedupeKey)) {
			return;
		}

		const thread = getThreadState(args.threadKey);
		const summarySource = args.result.error ? `${args.result.error}. ${args.result.text}` : args.result.text;
		const record: ClaudeExecutionRecord = {
			runId: args.runId,
			threadKey: args.threadKey,
			task: args.task,
			summary: truncateSummary(summarySource),
			status: args.result.status,
			sdkSessionId: args.result.sdkSessionId,
			source: args.source,
			completedAt: Date.now(),
			dedupeKey: args.dedupeKey,
		};
		thread.history.push(record);
		thread.lastTerminalStatus = args.result.status;
		thread.lastUpdatedAt = record.completedAt;
		if (args.result.status === 'completed' && args.result.sdkSessionId) {
			thread.lastCompletedSdkSessionId = args.result.sdkSessionId;
		}

		if (thread.history.length > state.maxHistoryPerThread) {
			thread.history.splice(0, thread.history.length - state.maxHistoryPerThread);
		}
		enforceTotalHistoryCap();
	}

	function buildErrorResult(args: {
		sessionId: string;
		threadKey: string;
		continuityMode: ContinuityMode;
		error: string;
		resumeSessionIdUsed?: string;
		resumeFallbackUsed?: boolean;
	}) {
		return {
			sessionId: args.sessionId,
			threadKey: args.threadKey,
			continuityMode: args.continuityMode,
			resumeSessionIdUsed: args.resumeSessionIdUsed,
			resumeFallbackUsed: args.resumeFallbackUsed ?? false,
			sdkSessionId: undefined,
			status: 'error' as const,
			text: '',
			error: args.error,
		};
	}

	const claudeCodeStart = tool({
		description:
			'Start a new Claude Code session to execute a coding task. Returns a sessionId for follow-up calls.',
		parameters: z.object({
			task: z.string().describe('The coding task for Claude to perform'),
			threadKey: z
				.string()
				.optional()
				.describe('Optional continuity thread key. If omitted, runtime allocates deterministically.'),
			continuityMode: CONTINUITY_MODE_SCHEMA.optional().describe(
				'Optional continuity policy: resume_if_available (default), force_resume, or force_fresh.',
			),
			resumeSessionId: z
				.string()
				.optional()
				.describe('SDK session ID from a prior result to resume that session'),
		}),
		execute: async ({ task, threadKey, continuityMode, resumeSessionId }) => {
			const sessionId = crypto.randomUUID();
			const resolvedContinuity = continuityMode ?? 'resume_if_available';
			const primaryRunId = `${sessionId}:start`;

			// Bug 3 fix: For force_resume without explicit resumeSessionId,
			// verify a resume target exists BEFORE allocating a thread ordinal.
			if (resolvedContinuity === 'force_resume' && !resumeSessionId) {
				const existingKey = peekThreadKey({ threadKey });
				const existingThread = existingKey ? state.threads[existingKey] : undefined;
				if (!existingThread?.lastCompletedSdkSessionId) {
					const errorThreadKey = existingKey ?? threadKey ?? 'unknown_thread';
					const error = 'force_resume_requested_but_no_resume_target';
					recordTerminalResult({
						threadKey: errorThreadKey,
						source: 'claude_code_start',
						runId: primaryRunId,
						task,
						result: { status: 'error', text: '', error },
						dedupeKey: `${primaryRunId}:no-target`,
					});
					return buildErrorResult({
						sessionId,
						threadKey: errorThreadKey,
						continuityMode: resolvedContinuity,
						error,
					});
				}
			}

			const resolvedThreadKey = resolveThreadKey({ threadKey });
			const threadState = getThreadState(resolvedThreadKey);

			let resumeTarget: string | undefined;
			switch (resolvedContinuity) {
				case 'force_fresh':
					resumeTarget = undefined;
					break;
				case 'force_resume':
					// Early check above guarantees a target exists here.
					resumeTarget = resumeSessionId ?? threadState.lastCompletedSdkSessionId;
					break;
				case 'resume_if_available':
				default:
					resumeTarget = resumeSessionId ?? threadState.lastCompletedSdkSessionId;
					break;
			}

			sessionTasks.set(sessionId, task);
			state.sessionToThread[sessionId] = resolvedThreadKey;

			let session = createSession();
			sessions.set(sessionId, session);
			let result: ClaudeCodeResult;
			let resumeFallbackUsed = false;
			let resumeSessionIdUsed = resumeTarget;

			if (resumeTarget) {
				try {
					result = await session.resume(task, resumeTarget);
					if (result.status === 'error' && isResumeInvalidErrorMessage(result.error ?? result.text)) {
						recordTerminalResult({
							threadKey: resolvedThreadKey,
							source: 'claude_code_start',
							runId: primaryRunId,
							task,
							result: {
								status: 'error',
								text: result.text,
								error: result.error,
								sdkSessionId: result.sdkSessionId,
							},
							dedupeKey: `${primaryRunId}:resume-error-result`,
						});
						// Bug 1 fix: force_resume must not fall back to fresh.
						if (resolvedContinuity === 'force_resume') {
							sessions.delete(sessionId);
							sessionTasks.delete(sessionId);
							delete state.sessionToThread[sessionId];
							return buildErrorResult({
								sessionId,
								threadKey: resolvedThreadKey,
								continuityMode: resolvedContinuity,
								error: result.error ?? result.text,
								resumeSessionIdUsed,
							});
						}
						// Bug 2 fix: wrap fallback in its own try/catch so a throw
						// here is not conflated with the resume throw in the outer catch.
						try {
							await session.abort().catch(() => {});
							session = createSession();
							sessions.set(sessionId, session);
							result = await session.start(task);
							resumeFallbackUsed = true;
							resumeSessionIdUsed = undefined;
						} catch (fallbackErr) {
							const fallbackMessage = toErrorMessage(fallbackErr);
							sessions.delete(sessionId);
							sessionTasks.delete(sessionId);
							delete state.sessionToThread[sessionId];
							recordTerminalResult({
								threadKey: resolvedThreadKey,
								source: 'claude_code_start',
								runId: primaryRunId,
								task,
								result: { status: 'error', text: '', error: fallbackMessage },
								dedupeKey: `${primaryRunId}:fallback-start-error-result`,
							});
							return buildErrorResult({
								sessionId,
								threadKey: resolvedThreadKey,
								continuityMode: resolvedContinuity,
								error: fallbackMessage,
								resumeFallbackUsed: true,
							});
						}
					}
				} catch (err) {
					const message = toErrorMessage(err);
					if (!isResumeInvalidErrorMessage(message)) {
						sessions.delete(sessionId);
						sessionTasks.delete(sessionId);
						delete state.sessionToThread[sessionId];
						recordTerminalResult({
							threadKey: resolvedThreadKey,
							source: 'claude_code_start',
							runId: primaryRunId,
							task,
							result: { status: 'error', text: '', error: message },
							dedupeKey: `${primaryRunId}:resume-throw`,
						});
						return buildErrorResult({
							sessionId,
							threadKey: resolvedThreadKey,
							continuityMode: resolvedContinuity,
							error: message,
							resumeSessionIdUsed,
						});
					}
					recordTerminalResult({
						threadKey: resolvedThreadKey,
						source: 'claude_code_start',
						runId: primaryRunId,
						task,
						result: { status: 'error', text: '', error: message },
						dedupeKey: `${primaryRunId}:resume-invalid-throw`,
					});
					// Bug 1 fix: force_resume must not fall back to fresh.
					if (resolvedContinuity === 'force_resume') {
						sessions.delete(sessionId);
						sessionTasks.delete(sessionId);
						delete state.sessionToThread[sessionId];
						return buildErrorResult({
							sessionId,
							threadKey: resolvedThreadKey,
							continuityMode: resolvedContinuity,
							error: message,
							resumeSessionIdUsed,
						});
					}
					await session.abort().catch(() => {});
					session = createSession();
					sessions.set(sessionId, session);
					try {
						result = await session.start(task);
						resumeFallbackUsed = true;
						resumeSessionIdUsed = undefined;
					} catch (fallbackErr) {
						const fallbackMessage = toErrorMessage(fallbackErr);
						sessions.delete(sessionId);
						sessionTasks.delete(sessionId);
						delete state.sessionToThread[sessionId];
						recordTerminalResult({
							threadKey: resolvedThreadKey,
							source: 'claude_code_start',
							runId: primaryRunId,
							task,
							result: { status: 'error', text: '', error: fallbackMessage },
							dedupeKey: `${primaryRunId}:fallback-start-error`,
						});
						return buildErrorResult({
							sessionId,
							threadKey: resolvedThreadKey,
							continuityMode: resolvedContinuity,
							error: fallbackMessage,
							resumeFallbackUsed: true,
						});
					}
				}
			} else {
				try {
					result = await session.start(task);
				} catch (err) {
					const message = toErrorMessage(err);
					sessions.delete(sessionId);
					sessionTasks.delete(sessionId);
					delete state.sessionToThread[sessionId];
					recordTerminalResult({
						threadKey: resolvedThreadKey,
						source: 'claude_code_start',
						runId: primaryRunId,
						task,
						result: { status: 'error', text: '', error: message },
						dedupeKey: `${primaryRunId}:start-throw`,
					});
					return buildErrorResult({
						sessionId,
						threadKey: resolvedThreadKey,
						continuityMode: resolvedContinuity,
						error: message,
					});
				}
			}

			if (result.status !== 'needs_input') {
				sessions.delete(sessionId);
				sessionTasks.delete(sessionId);
				delete state.sessionToThread[sessionId];
				recordTerminalResult({
					threadKey: resolvedThreadKey,
					source: 'claude_code_start',
					runId: primaryRunId,
					task,
					result: {
						status: toTerminalStatus(result),
						text: result.text,
						error: result.error,
						sdkSessionId: result.sdkSessionId,
					},
					dedupeKey: `${primaryRunId}:final:${result.status}:${result.sdkSessionId ?? 'none'}`,
				});
			}

			return {
				sessionId,
				threadKey: resolvedThreadKey,
				continuityMode: resolvedContinuity,
				resumeSessionIdUsed,
				resumeFallbackUsed,
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

	const claudeCodeRespond = tool({
		description:
			"Send the user's response to a Claude Code session that is waiting for input.",
		parameters: z.object({
			sessionId: z.string().describe('The sessionId returned by claude_code_start'),
			response: z.string().describe("The user's response to Claude's question"),
			threadKey: z
				.string()
				.optional()
				.describe('Optional fallback thread key. Used only when session mapping is missing.'),
		}),
		execute: async ({ sessionId, response, threadKey }) => {
			const mappedThreadKey = state.sessionToThread[sessionId];
			const explicitThreadKey = normalizeThreadKey(threadKey);
			const resolvedThreadKey = mappedThreadKey ?? explicitThreadKey;
			if (!resolvedThreadKey) {
				return {
					sessionId,
					threadKey: undefined,
					sdkSessionId: undefined,
					status: 'error' as const,
					text: '',
					error: UNKNOWN_SESSION_THREAD_MAPPING,
				};
			}
			if (!mappedThreadKey && explicitThreadKey) {
				state.sessionToThread[sessionId] = explicitThreadKey;
			}

			const session = sessions.get(sessionId);
			if (!session) {
				const error = `No active Claude Code session with id "${sessionId}"`;
				recordTerminalResult({
					threadKey: resolvedThreadKey,
					source: 'claude_code_respond',
					runId: `${sessionId}:respond`,
					task: sessionTasks.get(sessionId) ?? '[respond]',
					result: { status: 'error', text: '', error },
					dedupeKey: `${sessionId}:respond:no-active-session`,
				});
				delete state.sessionToThread[sessionId];
				sessionTasks.delete(sessionId);
				return {
					sessionId,
					threadKey: resolvedThreadKey,
					sdkSessionId: undefined,
					status: 'error' as const,
					text: '',
					error,
				};
			}

			let result: ClaudeCodeResult;
			try {
				result = await session.respond(response);
			} catch (err) {
				const message = toErrorMessage(err);
				recordTerminalResult({
					threadKey: resolvedThreadKey,
					source: 'claude_code_respond',
					runId: `${sessionId}:respond`,
					task: sessionTasks.get(sessionId) ?? '[respond]',
					result: { status: 'error', text: '', error: message },
					dedupeKey: `${sessionId}:respond:throw`,
				});
				sessions.delete(sessionId);
				sessionTasks.delete(sessionId);
				delete state.sessionToThread[sessionId];
				return {
					sessionId,
					threadKey: resolvedThreadKey,
					sdkSessionId: undefined,
					status: 'error' as const,
					text: '',
					error: message,
				};
			}

			if (result.status !== 'needs_input') {
				recordTerminalResult({
					threadKey: resolvedThreadKey,
					source: 'claude_code_respond',
					runId: `${sessionId}:respond`,
					task: sessionTasks.get(sessionId) ?? '[respond]',
					result: {
						status: toTerminalStatus(result),
						text: result.text,
						error: result.error,
						sdkSessionId: result.sdkSessionId,
					},
					dedupeKey: `${sessionId}:respond:final:${result.status}:${result.sdkSessionId ?? 'none'}`,
				});
				sessions.delete(sessionId);
				sessionTasks.delete(sessionId);
				delete state.sessionToThread[sessionId];
			}

			return {
				sessionId,
				threadKey: resolvedThreadKey,
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
		// Each handoff gets isolated runtime sessions, but shares continuity metadata.
		createInstance: () => createClaudeCodeSubagentConfig({ ...options, _state: state }),
		async dispose() {
			const abortPromises = [...sessions.values()].map((s) => s.abort());
			await Promise.allSettled(abortPromises);
			sessions.clear();
			sessionTasks.clear();
		},
	};
}

// Expose for testing
export { ClaudeCodeSession as _ClaudeCodeSessionClass };
