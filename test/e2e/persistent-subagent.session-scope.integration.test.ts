// SPDX-License-Identifier: MIT

/**
 * Persistent Subagent — Session-Scope Integration Tests
 *
 * Validates the full lifecycle of persistent subagents within a session:
 * - Same-key repeated invocations reuse the persistent instance (context preserved)
 * - Different keys create isolated instances
 * - Session close disposes all persistent instances
 * - Re-acquire after release creates a fresh instance
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistentSubagentManager } from '../../src/agent/persistent-subagent-manager.js';
import type {
	PersistentSubagentFactory,
	PersistentSubagentInstance,
} from '../../src/agent/persistent-subagent-types.js';
import type { SubagentConfig } from '../../src/types/agent.js';

// ---------------------------------------------------------------------------
// Helpers: Stateful mock that accumulates context across invocations
// ---------------------------------------------------------------------------

function createStatefulInstance(key: string): PersistentSubagentInstance {
	const history: string[] = [];
	let disposed = false;
	return {
		key,
		invoke: vi.fn(async (taskDescription: string) => {
			if (disposed) throw new Error(`${key} is disposed`);
			history.push(taskDescription);
			return `[${key}] invocation #${history.length}: ${taskDescription}`;
		}),
		dispose: vi.fn(async () => {
			disposed = true;
		}),
		// Expose history for assertions
		get _history() {
			return history;
		},
	} as PersistentSubagentInstance & { _history: string[] };
}

function createStatefulFactory(): PersistentSubagentFactory & {
	instances: Map<string, PersistentSubagentInstance>;
} {
	const instances = new Map<string, PersistentSubagentInstance>();
	const factory = vi.fn(async (key: string) => {
		const instance = createStatefulInstance(key);
		instances.set(key, instance);
		return instance;
	}) as PersistentSubagentFactory & { instances: Map<string, PersistentSubagentInstance> };
	factory.instances = instances;
	return factory;
}

function config(name: string): SubagentConfig {
	return { name, instructions: '', tools: {}, lifetime: 'persistent_session' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Persistent Subagent — Session Scope Integration', () => {
	let manager: PersistentSubagentManager;
	let factory: ReturnType<typeof createStatefulFactory>;

	beforeEach(() => {
		manager = new PersistentSubagentManager();
		factory = createStatefulFactory();
	});

	// -- Same-key reuse across invocations ------------------------------------

	it('repeated invocations on the same key reuse the same persistent instance', async () => {
		await manager.acquirePersistent('coder', config('coder'), factory);

		const r1 = await manager.invoke('coder', 'Write a function', { task: 'Write a function' });
		const r2 = await manager.invoke('coder', 'Add tests', { task: 'Add tests' });
		const r3 = await manager.invoke('coder', 'Refactor it', { task: 'Refactor it' });

		expect(r1).toContain('invocation #1');
		expect(r2).toContain('invocation #2');
		expect(r3).toContain('invocation #3');

		// Factory was called only once — instance was reused
		expect(factory).toHaveBeenCalledOnce();

		// The instance accumulated history
		const instance = factory.instances.get('coder') as PersistentSubagentInstance & {
			_history: string[];
		};
		expect(instance._history).toEqual(['Write a function', 'Add tests', 'Refactor it']);
	});

	// -- Key isolation --------------------------------------------------------

	it('different keys create isolated instances with independent context', async () => {
		await manager.acquirePersistent('coder', config('coder'), factory);
		await manager.acquirePersistent('researcher', config('researcher'), factory);

		await manager.invoke('coder', 'Write code', {});
		await manager.invoke('researcher', 'Search docs', {});
		await manager.invoke('coder', 'Fix bug', {});

		const coderInstance = factory.instances.get('coder') as PersistentSubagentInstance & {
			_history: string[];
		};
		const researcherInstance = factory.instances.get('researcher') as PersistentSubagentInstance & {
			_history: string[];
		};

		expect(coderInstance._history).toEqual(['Write code', 'Fix bug']);
		expect(researcherInstance._history).toEqual(['Search docs']);
	});

	// -- Session close disposes all ------------------------------------------

	it('session close (disposeAll) disposes all persistent instances', async () => {
		await manager.acquirePersistent('coder', config('coder'), factory);
		await manager.acquirePersistent('researcher', config('researcher'), factory);

		// Simulate some work
		await manager.invoke('coder', 'Task 1', {});
		await manager.invoke('researcher', 'Task 2', {});

		// Simulate session close
		await manager.disposeAllPersistent();

		const coder = factory.instances.get('coder');
		const researcher = factory.instances.get('researcher');
		expect(coder).toBeDefined();
		expect(researcher).toBeDefined();

		expect(coder.dispose).toHaveBeenCalledOnce();
		expect(researcher.dispose).toHaveBeenCalledOnce();
		expect(manager.activeKeys).toEqual([]);
	});

	// -- Post-dispose invocation fails ---------------------------------------

	it('invoke after session close throws', async () => {
		await manager.acquirePersistent('coder', config('coder'), factory);
		await manager.disposeAllPersistent();

		await expect(manager.invoke('coder', 'Task', {})).rejects.toThrow();
	});

	// -- Re-acquire after release creates fresh instance ---------------------

	it('re-acquire after release creates a new instance with fresh context', async () => {
		await manager.acquirePersistent('coder', config('coder'), factory);
		await manager.invoke('coder', 'Task A', {});

		// Release explicitly
		await manager.releasePersistent('coder');

		// Re-acquire
		await manager.acquirePersistent('coder', config('coder'), factory);
		const r = await manager.invoke('coder', 'Task B', {});

		// This is invocation #1 on a fresh instance (not #2)
		expect(r).toContain('invocation #1');
		expect(factory).toHaveBeenCalledTimes(2);
	});

	// -- Concurrent acquire + invoke from multiple "tool calls" ---------------

	it('concurrent tool calls both get the same persistent instance', async () => {
		const cfg = config('coder');

		// Simulate two background tool calls arriving at the same time,
		// both needing the 'coder' persistent instance
		const [r1, r2] = await Promise.all([
			manager
				.acquirePersistent('coder', cfg, factory)
				.then(() => manager.invoke('coder', 'Task 1', {})),
			manager
				.acquirePersistent('coder', cfg, factory)
				.then(() => manager.invoke('coder', 'Task 2', {})),
		]);

		expect(r1).toContain('[coder]');
		expect(r2).toContain('[coder]');
		expect(factory).toHaveBeenCalledOnce();
	});

	// -- Abort signal cancellation -------------------------------------------

	it('abort signal is forwarded through to persistent instance invoke', async () => {
		const instance = createStatefulInstance('coder');
		const capturedSignals: (AbortSignal | undefined)[] = [];
		(instance.invoke as ReturnType<typeof vi.fn>).mockImplementation(
			async (_desc: string, _args: unknown, signal?: AbortSignal) => {
				capturedSignals.push(signal);
				return 'ok';
			},
		);
		const customFactory: PersistentSubagentFactory = vi.fn(async () => instance);

		await manager.acquirePersistent('coder', config('coder'), customFactory);
		const controller = new AbortController();
		await manager.invoke('coder', 'Task', {}, controller.signal);

		expect(capturedSignals[0]).toBe(controller.signal);
	});

	// -- Full lifecycle: acquire → invoke N times → close --------------------

	it('full lifecycle: acquire → multi-invoke → session close', async () => {
		// Acquire two persistent subagents
		await manager.acquirePersistent('coder', config('coder'), factory);
		await manager.acquirePersistent('researcher', config('researcher'), factory);

		// Round 1
		await manager.invoke('coder', 'Write code', {});
		await manager.invoke('researcher', 'Find docs', {});

		// Round 2 (same session, reuses instances)
		await manager.invoke('coder', 'Add tests', {});
		await manager.invoke('researcher', 'Summarize findings', {});

		// Verify both are still active
		expect(manager.activeKeys.sort()).toEqual(['coder', 'researcher']);

		// Session close
		await manager.disposeAllPersistent();
		expect(manager.activeKeys).toEqual([]);
		expect(manager.has('coder')).toBe(false);
		expect(manager.has('researcher')).toBe(false);
	});
});
