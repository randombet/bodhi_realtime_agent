// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistentSubagentManager } from '../../src/agent/persistent-subagent-manager.js';
import type {
	PersistentSubagentFactory,
	PersistentSubagentInstance,
} from '../../src/agent/persistent-subagent-types.js';
import type { SubagentConfig } from '../../src/types/agent.js';

function createMockInstance(key: string): PersistentSubagentInstance {
	return {
		key,
		invoke: vi.fn().mockResolvedValue(`result from ${key}`),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

function createMockFactory(): PersistentSubagentFactory {
	return vi.fn(async (key: string) => createMockInstance(key));
}

function createConfig(name: string): SubagentConfig {
	return {
		name,
		instructions: `instructions for ${name}`,
		tools: {},
	};
}

describe('PersistentSubagentManager', () => {
	let manager: PersistentSubagentManager;
	let factory: PersistentSubagentFactory;

	beforeEach(() => {
		factory = createMockFactory();
		manager = new PersistentSubagentManager();
	});

	// -- acquirePersistent ---------------------------------------------------

	describe('acquirePersistent', () => {
		it('creates a new instance on first acquire', async () => {
			const instance = await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			expect(instance).toBeDefined();
			expect(instance.key).toBe('agent-a');
			expect(factory).toHaveBeenCalledOnce();
		});

		it('returns the same instance for the same key', async () => {
			const config = createConfig('a');
			const first = await manager.acquirePersistent('agent-a', config, factory);
			const second = await manager.acquirePersistent('agent-a', config, factory);
			expect(first).toBe(second);
			expect(factory).toHaveBeenCalledOnce();
		});

		it('returns different instances for different keys', async () => {
			const a = await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			const b = await manager.acquirePersistent('agent-b', createConfig('b'), factory);
			expect(a).not.toBe(b);
			expect(a.key).toBe('agent-a');
			expect(b.key).toBe('agent-b');
			expect(factory).toHaveBeenCalledTimes(2);
		});

		it('concurrent acquires for the same key do not double-create', async () => {
			const config = createConfig('a');
			const [first, second] = await Promise.all([
				manager.acquirePersistent('agent-a', config, factory),
				manager.acquirePersistent('agent-a', config, factory),
			]);
			expect(first).toBe(second);
			expect(factory).toHaveBeenCalledOnce();
		});
	});

	// -- invoke --------------------------------------------------------------

	describe('invoke', () => {
		it('invokes an acquired persistent instance', async () => {
			const instance = await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			const result = await manager.invoke('agent-a', 'do a thing', { x: 1 });
			expect(result).toBe('result from agent-a');
			expect(instance.invoke).toHaveBeenCalledWith('do a thing', { x: 1 }, undefined);
		});

		it('passes abort signal through to instance', async () => {
			await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			const controller = new AbortController();
			await manager.invoke('agent-a', 'task', {}, controller.signal);
			const instance = await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			expect(instance.invoke).toHaveBeenCalledWith('task', {}, controller.signal);
		});

		it('throws when invoking a key that was never acquired', async () => {
			await expect(manager.invoke('nonexistent', 'task', {})).rejects.toThrow(
				'No persistent subagent instance for key "nonexistent"',
			);
		});

		it('throws when invoking a key that was released', async () => {
			await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			await manager.releasePersistent('agent-a');
			await expect(manager.invoke('agent-a', 'task', {})).rejects.toThrow(
				'No persistent subagent instance for key "agent-a"',
			);
		});
	});

	// -- releasePersistent ---------------------------------------------------

	describe('releasePersistent', () => {
		it('disposes and removes a persistent instance', async () => {
			const instance = await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			await manager.releasePersistent('agent-a');
			expect(instance.dispose).toHaveBeenCalledOnce();
			expect(manager.has('agent-a')).toBe(false);
		});

		it('is a no-op for unknown keys', async () => {
			await expect(manager.releasePersistent('nonexistent')).resolves.toBeUndefined();
		});

		it('allows re-acquiring after release', async () => {
			const config = createConfig('a');
			const first = await manager.acquirePersistent('agent-a', config, factory);
			await manager.releasePersistent('agent-a');
			const second = await manager.acquirePersistent('agent-a', config, factory);
			expect(second).not.toBe(first);
			expect(factory).toHaveBeenCalledTimes(2);
		});
	});

	// -- disposeAllPersistent ------------------------------------------------

	describe('disposeAllPersistent', () => {
		it('disposes all persistent instances', async () => {
			const a = await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			const b = await manager.acquirePersistent('agent-b', createConfig('b'), factory);
			await manager.disposeAllPersistent();
			expect(a.dispose).toHaveBeenCalledOnce();
			expect(b.dispose).toHaveBeenCalledOnce();
			expect(manager.has('agent-a')).toBe(false);
			expect(manager.has('agent-b')).toBe(false);
		});

		it('is idempotent — second call is a no-op', async () => {
			const a = await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			await manager.disposeAllPersistent();
			await manager.disposeAllPersistent();
			expect(a.dispose).toHaveBeenCalledOnce();
		});

		it('works when no instances exist', async () => {
			await expect(manager.disposeAllPersistent()).resolves.toBeUndefined();
		});

		it('continues disposing remaining instances even if one dispose throws', async () => {
			const throwingInstance = createMockInstance('agent-a');
			(throwingInstance.dispose as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('dispose failed'),
			);
			const throwingFactory: PersistentSubagentFactory = vi.fn(async () => throwingInstance);

			await manager.acquirePersistent('agent-a', createConfig('a'), throwingFactory);
			const b = await manager.acquirePersistent('agent-b', createConfig('b'), factory);

			// Should not throw — errors are caught internally
			await manager.disposeAllPersistent();
			expect(b.dispose).toHaveBeenCalledOnce();
		});
	});

	// -- has -----------------------------------------------------------------

	describe('has', () => {
		it('returns false for unknown key', () => {
			expect(manager.has('nonexistent')).toBe(false);
		});

		it('returns true after acquire', async () => {
			await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			expect(manager.has('agent-a')).toBe(true);
		});

		it('returns false after release', async () => {
			await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			await manager.releasePersistent('agent-a');
			expect(manager.has('agent-a')).toBe(false);
		});
	});

	// -- activeKeys ----------------------------------------------------------

	describe('activeKeys', () => {
		it('returns empty array when no instances', () => {
			expect(manager.activeKeys).toEqual([]);
		});

		it('returns all active keys', async () => {
			await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			await manager.acquirePersistent('agent-b', createConfig('b'), factory);
			expect(manager.activeKeys.sort()).toEqual(['agent-a', 'agent-b']);
		});
	});

	// -- Concurrent safety ---------------------------------------------------

	describe('concurrent safety', () => {
		it('handles concurrent acquires + invoke without corruption', async () => {
			const config = createConfig('a');
			const results = await Promise.all([
				manager
					.acquirePersistent('agent-a', config, factory)
					.then(() => manager.invoke('agent-a', 'task1', {})),
				manager
					.acquirePersistent('agent-a', config, factory)
					.then(() => manager.invoke('agent-a', 'task2', {})),
			]);
			expect(results).toEqual(['result from agent-a', 'result from agent-a']);
			expect(factory).toHaveBeenCalledOnce();
		});

		it('handles concurrent disposeAll + acquire gracefully', async () => {
			await manager.acquirePersistent('agent-a', createConfig('a'), factory);
			const [, instance] = await Promise.all([
				manager.disposeAllPersistent(),
				// acquire after dispose starts — should create a new instance
				manager.acquirePersistent('agent-a', createConfig('a'), factory),
			]);
			// The instance should exist (either reused before dispose or freshly created)
			expect(instance).toBeDefined();
		});
	});
});
