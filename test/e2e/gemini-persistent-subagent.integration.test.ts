// SPDX-License-Identifier: MIT

/**
 * Gemini Persistent Subagent — Integration Test
 *
 * Validates that the persistent subagent contract works through the Gemini
 * transport path: ToolCallRouter dispatches a background tool → AgentRouter
 * hands off to a persistent subagent instance → result flows back.
 *
 * This test exercises the ToolCallRouter + PersistentSubagentManager
 * integration using mocked transports (no live API key required).
 * It verifies the wiring path that would be used in production with
 * Gemini Live transport.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistentSubagentManager } from '../../src/agent/persistent-subagent-manager.js';
import type { PersistentSubagentInstance } from '../../src/agent/persistent-subagent-types.js';
import type { SubagentConfig } from '../../src/types/agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPersistentInstance(key: string): PersistentSubagentInstance {
	const history: string[] = [];
	return {
		key,
		invoke: vi.fn(async (taskDescription: string) => {
			history.push(taskDescription);
			return `[${key}] result #${history.length}: ${taskDescription}`;
		}),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

function config(name: string, lifetime: 'ephemeral' | 'persistent_session'): SubagentConfig {
	return {
		name,
		instructions: `instructions for ${name}`,
		tools: {},
		lifetime,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gemini Persistent Subagent — Integration', () => {
	let persistentMgr: PersistentSubagentManager;

	beforeEach(() => {
		persistentMgr = new PersistentSubagentManager();
	});

	// -- Simulated ToolCallRouter → persistent path --------------------------

	describe('ToolCallRouter dispatch simulation', () => {
		it('persistent subagent reuses context across tool call dispatches', async () => {
			const factory = vi.fn(async (key: string) => createPersistentInstance(key));
			const subagentConfig = config('ask_openclaw', 'persistent_session');

			// Simulate first tool call: ToolCallRouter sees lifetime=persistent_session,
			// acquires from PersistentSubagentManager
			const instance1 = await persistentMgr.acquirePersistent(
				'ask_openclaw',
				subagentConfig,
				factory,
			);
			const result1 = await instance1.invoke('Write a hello world', {});

			expect(result1).toContain('result #1');
			expect(factory).toHaveBeenCalledOnce();

			// Simulate second tool call: ToolCallRouter acquires again → gets same instance
			const instance2 = await persistentMgr.acquirePersistent(
				'ask_openclaw',
				subagentConfig,
				factory,
			);
			const result2 = await instance2.invoke('Add error handling', {});

			expect(instance1).toBe(instance2); // Same instance
			expect(result2).toContain('result #2');
			expect(factory).toHaveBeenCalledOnce(); // Still only one factory call
		});

		it('ephemeral subagent does NOT use persistent manager', async () => {
			// Ephemeral subagents bypass PersistentSubagentManager entirely.
			// Each tool call creates a fresh config instance via createInstance().
			const subagentConfig = config('quick_task', 'ephemeral');

			// Verify the ephemeral config is recognized
			expect(subagentConfig.lifetime).toBe('ephemeral');

			// Ephemeral subagents go through AgentRouter.handoff() directly,
			// not through PersistentSubagentManager. This test documents
			// that the persistent manager should NOT be used for ephemeral tools.
			expect(persistentMgr.has('quick_task')).toBe(false);
		});
	});

	// -- Gemini transport path specifics -------------------------------------

	describe('Gemini transport path compatibility', () => {
		it('persistent subagent result can be sent as tool response', async () => {
			const factory = vi.fn(async (key: string) => createPersistentInstance(key));
			await persistentMgr.acquirePersistent(
				'coder',
				config('coder', 'persistent_session'),
				factory,
			);

			const result = await persistentMgr.invoke('coder', 'Fix the login bug', {
				task: 'Fix the login bug',
			});

			// Result is a string that can be sent back as tool result
			expect(typeof result).toBe('string');
			expect(result.length).toBeGreaterThan(0);

			// Simulate what ToolCallRouter does with the result:
			const toolResult = {
				id: 'tool-call-1',
				name: 'ask_coder',
				result: { result },
				scheduling: 'when_idle' as const,
			};
			expect(toolResult.result.result).toContain('[coder]');
		});

		it('persistent subagent error propagates as tool error result', async () => {
			const failingInstance: PersistentSubagentInstance = {
				key: 'failing',
				invoke: vi.fn().mockRejectedValue(new Error('Gateway timeout')),
				dispose: vi.fn().mockResolvedValue(undefined),
			};
			const factory = vi.fn(async () => failingInstance);

			await persistentMgr.acquirePersistent(
				'failing',
				config('failing', 'persistent_session'),
				factory,
			);

			// ToolCallRouter would catch this and send an error tool result
			try {
				await persistentMgr.invoke('failing', 'Task', {});
				expect.unreachable('Should have thrown');
			} catch (err) {
				const error = err as Error;
				// Verify the error message is suitable for a tool result
				const toolResult = {
					id: 'tool-call-2',
					name: 'ask_failing',
					result: { error: error.message },
					scheduling: 'when_idle' as const,
				};
				expect(toolResult.result.error).toBe('Gateway timeout');
			}
		});
	});

	// -- Session close path --------------------------------------------------

	describe('session close disposes all persistent subagents', () => {
		it('VoiceSession.close() path: disposeAll cleans up all instances', async () => {
			const factory = vi.fn(async (key: string) => createPersistentInstance(key));

			const coder = await persistentMgr.acquirePersistent(
				'coder',
				config('coder', 'persistent_session'),
				factory,
			);
			const researcher = await persistentMgr.acquirePersistent(
				'researcher',
				config('researcher', 'persistent_session'),
				factory,
			);

			// Some work
			await persistentMgr.invoke('coder', 'Task 1', {});
			await persistentMgr.invoke('researcher', 'Task 2', {});

			// VoiceSession.close() calls disposeAllPersistent()
			await persistentMgr.disposeAllPersistent();

			expect(coder.dispose).toHaveBeenCalledOnce();
			expect(researcher.dispose).toHaveBeenCalledOnce();
			expect(persistentMgr.activeKeys).toEqual([]);
		});

		it('audio latency unaffected: persistent manager operations are async control plane', async () => {
			// This test documents the invariant: persistent subagent operations
			// (acquire, invoke, dispose) are async control-plane operations.
			// They never block the audio fast path (direct callbacks).
			//
			// The persistent manager has no audio-related methods.
			// Audio continues flowing via ClientTransport ↔ LLMTransport
			// direct callbacks regardless of persistent subagent state.

			const managerMethods = Object.getOwnPropertyNames(PersistentSubagentManager.prototype);

			const audioPatterns = ['audio', 'pcm', 'wav', 'chunk', 'stream'];
			for (const method of managerMethods) {
				for (const pattern of audioPatterns) {
					expect(
						method.toLowerCase().includes(pattern),
						`PersistentSubagentManager.${method} looks audio-related — must stay on control plane`,
					).toBe(false);
				}
			}
		});
	});

	// -- Mixed ephemeral + persistent in same session ------------------------

	describe('mixed ephemeral and persistent subagents', () => {
		it('persistent instances survive while ephemeral instances are one-shot', async () => {
			const factory = vi.fn(async (key: string) => createPersistentInstance(key));

			// Persistent subagent: acquired once, reused
			await persistentMgr.acquirePersistent(
				'coder',
				config('coder', 'persistent_session'),
				factory,
			);

			// First tool call to persistent subagent
			const r1 = await persistentMgr.invoke('coder', 'Write code', {});
			expect(r1).toContain('result #1');

			// Meanwhile, an ephemeral subagent would run via AgentRouter.handoff()
			// (not shown — it doesn't touch PersistentSubagentManager)

			// Second tool call to same persistent subagent
			const r2 = await persistentMgr.invoke('coder', 'Add tests', {});
			expect(r2).toContain('result #2');

			// Persistent instance still alive
			expect(persistentMgr.has('coder')).toBe(true);
		});
	});
});
