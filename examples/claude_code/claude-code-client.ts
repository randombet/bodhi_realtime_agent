// SPDX-License-Identifier: MIT

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Permission modes supported by the Claude Agent SDK. */
export type ClaudePermissionMode = PermissionMode;

export interface ClaudeCodeSessionOptions {
	/** Working directory for the Claude session. */
	cwd: string;
	/** Built-in tools to allow (e.g. "Read", "Edit", "Bash", "Glob", "Grep"). */
	allowedTools?: string[];
	/** Claude model to use (default: "claude-sonnet-4-5-20250929"). */
	model?: string;
	/** Maximum agentic turns before stopping (default: 20). */
	maxTurns?: number;
	/** Custom system prompt. */
	systemPrompt?: string;
	/** Permission mode (default: "bypassPermissions"). */
	permissionMode?: ClaudePermissionMode;
	/** MCP servers to attach to the Claude session (in-process or external). */
	mcpServers?: Record<string, unknown>;
	/** Additional tool patterns to auto-allow (e.g. "mcp__email__*"). */
	extraAllowedTools?: string[];
}

export interface ClaudeCodeResult {
	/** Whether the session completed, needs user input, or errored. */
	status: 'completed' | 'needs_input' | 'error';
	/** Accumulated text from all assistant messages. */
	text: string;
	/** SDK session ID — capture from init message for resume support. */
	sdkSessionId?: string;
	/** Question text (present when status === "needs_input"). */
	question?: string;
	/** Structured options for the question (present when AskUserQuestion had options). */
	questionOptions?: Array<{ label: string; description: string }>;
	/** Total cost in USD. */
	cost?: number;
	/** Number of LLM turns. */
	turns?: number;
	/** Error message (present when status === "error"). */
	error?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Pending canUseTool Promise resolver for AskUserQuestion interception. */
interface PendingQuestion {
	resolve: (result: { behavior: 'allow'; updatedInput: Record<string, unknown> }) => void;
	questions: Array<{
		question: string;
		header: string;
		options: Array<{ label: string; description: string }>;
		multiSelect: boolean;
	}>;
}

/** The Query object returned by the SDK's query() function. */
type SDKQuery = ReturnType<typeof query>;

/** SDK message types we handle. */
interface SDKAssistantMessage {
	type: 'assistant';
	session_id: string;
	message: {
		content: Array<{ type: string; text?: string }>;
	};
}

interface SDKSystemInitMessage {
	type: 'system';
	subtype: 'init';
	session_id: string;
}

interface SDKResultSuccessMessage {
	type: 'result';
	subtype: 'success';
	session_id: string;
	total_cost_usd: number;
	num_turns: number;
}

interface SDKResultErrorMessage {
	type: 'result';
	subtype: string;
	session_id: string;
	total_cost_usd: number;
	num_turns: number;
	errors?: string[];
}

function resolveClaudeExecutablePath(): string {
	const explicitPath = process.env.CLAUDE_PATH?.trim();
	if (explicitPath) {
		return explicitPath;
	}

	const pathEnv = process.env.PATH;
	if (!pathEnv) {
		return 'claude';
	}

	const binaryNames =
		process.platform === 'win32'
			? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude']
			: ['claude'];

	for (const rawDir of pathEnv.split(path.delimiter)) {
		const dir = rawDir.trim();
		if (!dir) continue;
		for (const binaryName of binaryNames) {
			const candidate = path.join(dir, binaryName);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return 'claude';
}

// ---------------------------------------------------------------------------
// ClaudeCodeSession
// ---------------------------------------------------------------------------

/**
 * Wraps the Claude Agent SDK's `query()` function to provide a stateful
 * session that can pause on AskUserQuestion and resume with user input.
 *
 * Usage:
 * ```ts
 * const session = new ClaudeCodeSession({ cwd: '/path/to/project' });
 * const result = await session.start('Fix the bug in auth.py');
 * if (result.status === 'needs_input') {
 *   const next = await session.respond('Use option A');
 * }
 * ```
 */
export class ClaudeCodeSession {
	private activeQuery: SDKQuery | null = null;
	private iterator: AsyncIterator<unknown> | null = null;
	private sdkSessionId: string | undefined;
	private accumulatedText = '';
	private aborted = false;
	private started = false;

	/** Pending AskUserQuestion — set by canUseTool, cleared by respond(). */
	private pendingQuestion: PendingQuestion | null = null;

	/**
	 * Signal that fires when canUseTool sets pendingQuestion.
	 * Used by collectUntilPauseOrDone() to race against the generator's next yield,
	 * since the generator blocks when canUseTool returns a pending Promise.
	 */
	private questionReadyResolve: (() => void) | null = null;

	/**
	 * Saved iterator.next() promise from when the question signal won the race.
	 * Reused on the next collectUntilPauseOrDone() call so we don't lose messages.
	 */
	private pendingNext: Promise<{ kind: 'msg'; done: boolean; value: unknown }> | null = null;

	constructor(private readonly options: ClaudeCodeSessionOptions) {}

	/**
	 * Start a new coding task. Returns when the task completes or when
	 * AskUserQuestion is intercepted (status === "needs_input").
	 */
	async start(task: string): Promise<ClaudeCodeResult> {
		if (this.started) {
			throw new Error('ClaudeCodeSession already started — create a new instance for each task');
		}
		if (this.aborted) {
			throw new Error('ClaudeCodeSession was aborted');
		}
		this.started = true;

		this.activeQuery = query({
			prompt: task,
			options: this.buildOptions(),
		});

		return this.collectUntilPauseOrDone();
	}

	/**
	 * Resume a prior session with a new prompt using the SDK's resume option.
	 */
	async resume(task: string, sdkSessionId: string): Promise<ClaudeCodeResult> {
		if (this.started) {
			throw new Error('ClaudeCodeSession already started — create a new instance for each task');
		}
		if (this.aborted) {
			throw new Error('ClaudeCodeSession was aborted');
		}
		this.started = true;

		this.activeQuery = query({
			prompt: task,
			options: {
				...this.buildOptions(),
				resume: sdkSessionId,
			},
		});

		return this.collectUntilPauseOrDone();
	}

	/**
	 * Send the user's answer and continue the session.
	 * Returns when the task completes or when the next AskUserQuestion is hit.
	 */
	async respond(answer: string): Promise<ClaudeCodeResult> {
		if (this.aborted) {
			throw new Error('ClaudeCodeSession was aborted');
		}
		if (!this.pendingQuestion) {
			throw new Error('No pending question to respond to');
		}

		const { resolve, questions } = this.pendingQuestion;
		this.pendingQuestion = null;

		// Resolve the canUseTool Promise with the user's answer
		const answers: Record<string, string> = {};
		answers[questions[0].question] = answer;
		resolve({
			behavior: 'allow',
			updatedInput: { questions, answers },
		});

		return this.collectUntilPauseOrDone();
	}

	/**
	 * Abort the running session. Idempotent — safe to call multiple times.
	 */
	async abort(): Promise<void> {
		if (this.aborted) return;
		this.aborted = true;

		// Reject any pending canUseTool promise so the SDK can unblock
		if (this.pendingQuestion) {
			// Deny the pending tool call to unblock the generator
			this.pendingQuestion.resolve({
				behavior: 'allow',
				updatedInput: { questions: this.pendingQuestion.questions, answers: {} },
			});
			this.pendingQuestion = null;
		}

		if (this.activeQuery) {
			try {
				this.activeQuery.close();
			} catch {
				// close() may throw if already closed
			}
			this.activeQuery = null;
			this.iterator = null;
		}
	}

	/** Whether this session has been aborted. */
	get isAborted(): boolean {
		return this.aborted;
	}

	// -- Private ---------------------------------------------------------------

	private buildOptions() {
		const allowedTools = [
			...(this.options.allowedTools ?? ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']),
			...(this.options.extraAllowedTools ?? []),
		];

		const opts: Record<string, unknown> = {
			pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
			allowedTools,
			permissionMode: (this.options.permissionMode ?? 'bypassPermissions') as PermissionMode,
			allowDangerouslySkipPermissions:
				(this.options.permissionMode ?? 'bypassPermissions') === 'bypassPermissions',
			model: this.options.model ?? 'claude-sonnet-4-5-20250929',
			maxTurns: this.options.maxTurns ?? 20,
			cwd: this.options.cwd,
			// NOTE: Do NOT pass canUseTool with bypassPermissions.
			// The SDK adds --permission-prompt-tool stdio when canUseTool is present,
			// which conflicts with single-turn query mode (stdin closes after first result).
			// This prevents ALL tool calls from executing.
		};

		console.log('[ClaudeCode] buildOptions:', { allowedTools, mcpServers: this.options.mcpServers ? Object.keys(this.options.mcpServers) : 'none', permissionMode: opts.permissionMode, model: opts.model });

		if (this.options.systemPrompt) {
			opts.systemPrompt = this.options.systemPrompt;
		}

		if (this.options.mcpServers) {
			opts.mcpServers = this.options.mcpServers;
		}

		return opts;
	}

	/**
	 * Iterate the SDK async generator until:
	 * - A result message arrives (task complete or error)
	 * - canUseTool blocks on AskUserQuestion (pendingQuestion is set)
	 * - The generator ends
	 *
	 * When canUseTool blocks on AskUserQuestion, the async generator stops
	 * yielding messages. We use Promise.race to detect when the question
	 * signal fires before the next message arrives.
	 */
	private async collectUntilPauseOrDone(): Promise<ClaudeCodeResult> {
		if (!this.activeQuery) {
			return { status: 'error', text: this.accumulatedText, error: 'No active query' };
		}

		if (!this.iterator) {
			this.iterator = this.activeQuery[Symbol.asyncIterator]();
		}
		const iterator = this.iterator;

		try {
			while (true) {
				if (this.aborted) {
					return this.makeErrorResult('Session aborted');
				}

				// Race: next message from generator vs. question ready signal
				const questionReady = new Promise<'question'>((resolve) => {
					this.questionReadyResolve = () => resolve('question');
				});

				// Reuse saved next promise if available (from a prior question-won race)
				const nextMsg =
					this.pendingNext ??
					iterator.next().then((r) => ({ kind: 'msg' as const, ...r }));
				this.pendingNext = null;

				const winner = await Promise.race([
					nextMsg,
					questionReady.then((q) => ({ kind: q, done: false as const, value: undefined })),
				]);

				// Question signal won — canUseTool blocked.
				// Save the still-pending nextMsg so the next call picks it up.
				if (winner.kind === 'question' || this.pendingQuestion) {
					this.pendingNext = nextMsg;
					this.questionReadyResolve = null;
					return this.makeNeedsInputResult();
				}

				this.questionReadyResolve = null;

				// Generator done
				if (winner.done) break;

				const msg = winner.value;
				if (!msg) continue;

				// Process the message
				const result = this.processMessage(msg);
				if (result) return result;
			}
		} catch (err) {
			if (this.aborted) {
				return this.makeErrorResult('Session aborted');
			}
			return this.makeErrorResult(err instanceof Error ? err.message : String(err));
		}

		// Generator ended without a terminal result message.
		// Treat this as an error so callers don't assume side effects (e.g. email send) completed.
		return this.makeErrorResult('Claude session ended before a terminal result message was received');
	}

	/** Process a single SDK message. Returns a result if terminal, null to continue. */
	private processMessage(msg: unknown): ClaudeCodeResult | null {
		const m = msg as { type: string; subtype?: string; session_id?: string };

		// Capture session ID from init message
		if (m.type === 'system' && m.subtype === 'init') {
			this.sdkSessionId = (m as SDKSystemInitMessage).session_id;
			console.log('[ClaudeCode] SDK init message:', JSON.stringify(m, null, 2));
		}

		// Accumulate text from assistant messages
		if (m.type === 'assistant') {
			const assistantMsg = m as unknown as SDKAssistantMessage;
			if (assistantMsg.message?.content) {
				for (const block of assistantMsg.message.content) {
					if (block.text) {
						this.accumulatedText += block.text;
					}
				}
			}
		}

		// Handle result (terminal)
		if (m.type === 'result') {
			const resultMsg = m as unknown as SDKResultSuccessMessage & SDKResultErrorMessage;

			if (resultMsg.subtype === 'success') {
				return {
					status: 'completed',
					text: this.accumulatedText,
					sdkSessionId: this.sdkSessionId,
					cost: resultMsg.total_cost_usd,
					turns: resultMsg.num_turns,
				};
			}

			return {
				status: 'error',
				text: this.accumulatedText,
				sdkSessionId: this.sdkSessionId,
				cost: resultMsg.total_cost_usd,
				turns: resultMsg.num_turns,
				error: resultMsg.errors?.join('; ') ?? `Error: ${resultMsg.subtype}`,
			};
		}

		// Check if canUseTool blocked on AskUserQuestion during message processing
		if (this.pendingQuestion) {
			return this.makeNeedsInputResult();
		}

		return null;
	}

	private makeNeedsInputResult(): ClaudeCodeResult {
		const q = this.pendingQuestion?.questions[0];
		return {
			status: 'needs_input',
			text: this.accumulatedText,
			sdkSessionId: this.sdkSessionId,
			question: q?.question,
			questionOptions: q?.options?.map((opt) => ({
				label: opt.label,
				description: opt.description,
			})),
		};
	}

	private makeErrorResult(error: string): ClaudeCodeResult {
		return {
			status: 'error',
			text: this.accumulatedText,
			sdkSessionId: this.sdkSessionId,
			error,
		};
	}
}
