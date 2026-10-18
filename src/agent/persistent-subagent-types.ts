import type { SubagentConfig } from '../types/agent.js';

/**
 * Subagent lifetime mode.
 *
 * - `ephemeral`: one instance per tool call, disposed after completion (current default behavior).
 * - `persistent_session`: instance persists across multiple tool calls within the same VoiceSession.
 *   Disposed only on explicit release or session close.
 */
export type SubagentLifetimeMode = 'ephemeral' | 'persistent_session';

/**
 * A persistent subagent instance that can be reused across multiple tool calls.
 *
 * Implementors wrap a provider-specific client/session (e.g., Claude Code session,
 * OpenClaw gateway session) and expose a simple invoke/dispose contract.
 */
/**
 * A background result together with how it is delivered. A plain string is delivered `'when_idle'`.
 * `'silent'` adds the result to the model's context without prompting a response: for a call that
 * must be closed but has nothing new to say, e.g. a NON_BLOCKING call the model re-issued after its
 * result was already returned. Honoured where the transport supports it (Gemini NON_BLOCKING tools).
 */
export interface PersistentSubagentResult {
	text: string;
	scheduling?: 'when_idle' | 'silent';
}

export interface PersistentSubagentInstance {
	/** Unique key identifying this persistent instance (matches the subagentKey used to acquire it). */
	readonly key: string;

	/**
	 * Execute a task using this persistent instance.
	 * The instance retains context from prior invocations.
	 *
	 * @param taskDescription - Description of the task to execute.
	 * @param args - Tool call arguments.
	 * @param signal - Abort signal for cancellation.
	 * @returns Result text from the subagent, or a {@link PersistentSubagentResult} that also sets
	 *   how the result is delivered.
	 */
	invoke(
		taskDescription: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string | PersistentSubagentResult>;

	/**
	 * Release provider resources held by this instance.
	 * Must be idempotent — safe to call multiple times.
	 */
	dispose(): Promise<void>;
}

/**
 * Factory function that creates a new PersistentSubagentInstance.
 * Called once per subagentKey when the first `acquirePersistent()` is made.
 */
export type PersistentSubagentFactory = (
	key: string,
	config: SubagentConfig,
) => Promise<PersistentSubagentInstance>;
