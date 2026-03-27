// SPDX-License-Identifier: MIT

import { FrameworkError } from '../core/errors.js';
import type { SubagentConfig } from '../types/agent.js';
import type {
	PersistentSubagentFactory,
	PersistentSubagentInstance,
} from './persistent-subagent-types.js';

/**
 * Manages persistent subagent instances scoped to a VoiceSession lifetime.
 *
 * Persistent instances are keyed by a `subagentKey` string and reused across
 * multiple tool calls within the same session. This enables stateful subagents
 * (e.g., a Claude Code session that retains conversation history).
 *
 * Concurrency safety: concurrent `acquirePersistent()` calls for the same key
 * coalesce on a single factory invocation — no double-creates.
 */
export class PersistentSubagentManager {
	/** Active persistent instances keyed by subagentKey. */
	private readonly instances = new Map<string, PersistentSubagentInstance>();

	/** In-flight factory promises for dedup during concurrent acquires. */
	private readonly pending = new Map<string, Promise<PersistentSubagentInstance>>();

	/**
	 * Acquire (or reuse) a persistent subagent instance for the given key.
	 *
	 * If an instance already exists for `key`, it is returned immediately.
	 * Otherwise, `factory` is called to create one. Concurrent calls for the
	 * same key share the same factory promise — no double-creates.
	 */
	async acquirePersistent(
		key: string,
		config: SubagentConfig,
		factory: PersistentSubagentFactory,
	): Promise<PersistentSubagentInstance> {
		// Fast path: already created
		const existing = this.instances.get(key);
		if (existing) return existing;

		// Dedup path: another caller is already creating this key
		const inflight = this.pending.get(key);
		if (inflight) return inflight;

		// Create path: start factory and register the promise for dedup
		const promise = factory(key, config).then((instance) => {
			this.instances.set(key, instance);
			this.pending.delete(key);
			return instance;
		});
		this.pending.set(key, promise);

		try {
			return await promise;
		} catch (err) {
			this.pending.delete(key);
			throw err;
		}
	}

	/**
	 * Invoke a previously acquired persistent instance.
	 *
	 * @throws FrameworkError if no instance exists for `key`.
	 */
	async invoke(
		key: string,
		taskDescription: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		const instance = this.instances.get(key);
		if (!instance) {
			throw new FrameworkError(`No persistent subagent instance for key "${key}"`, {
				component: 'persistent-subagent-manager',
			});
		}
		return instance.invoke(taskDescription, args, signal);
	}

	/**
	 * Release a single persistent instance by key.
	 * Calls dispose() and removes it from the registry.
	 * No-op if the key does not exist.
	 */
	async releasePersistent(key: string): Promise<void> {
		const instance = this.instances.get(key);
		if (!instance) return;

		this.instances.delete(key);
		await instance.dispose();
	}

	/**
	 * Dispose all persistent instances. Called on VoiceSession close.
	 *
	 * Idempotent — safe to call multiple times. Individual dispose errors
	 * are caught so remaining instances are still cleaned up.
	 */
	async disposeAllPersistent(): Promise<void> {
		const entries = [...this.instances.entries()];
		this.instances.clear();
		this.pending.clear();

		await Promise.all(
			entries.map(async ([key, instance]) => {
				try {
					await instance.dispose();
				} catch (err) {
					// Log but don't throw — ensure all instances get a dispose attempt
					console.error(`[PersistentSubagentManager] dispose failed for key="${key}":`, err);
				}
			}),
		);
	}

	/** Check if a persistent instance exists for the given key. */
	has(key: string): boolean {
		return this.instances.has(key);
	}

	/** Return all active persistent instance keys. */
	get activeKeys(): string[] {
		return [...this.instances.keys()];
	}
}
