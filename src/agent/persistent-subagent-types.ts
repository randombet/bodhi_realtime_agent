// SPDX-License-Identifier: MIT

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
	 * @returns Result text from the subagent.
	 */
	invoke(
		taskDescription: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string>;

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
