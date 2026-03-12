// SPDX-License-Identifier: MIT

/**
 * Persistent Subagent — Long-Lived Interactive Session Tests
 *
 * Validates that persistent interactive subagents work correctly with the
 * SubagentSession state machine and InteractionModeManager across multiple turns:
 * - Interactive persistent subagent waits/resumes across turns
 * - InteractionModeManager routes input to the correct subagent
 * - Cancellation cleans up both SubagentSession and persistent instance
 * - Multiple interactive persistent subagents queue correctly
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistentSubagentManager } from '../../src/agent/persistent-subagent-manager.js';
import type {
	PersistentSubagentFactory,
	PersistentSubagentInstance,
} from '../../src/agent/persistent-subagent-types.js';
import { SubagentSessionImpl } from '../../src/agent/subagent-session.js';
import { InteractionModeManager } from '../../src/core/interaction-mode.js';
import type { SubagentConfig } from '../../src/types/agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createInteractiveInstance(key: string): PersistentSubagentInstance {
	return {
		key,
		invoke: vi.fn().mockResolvedValue(`response from ${key}`),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

function config(name: string): SubagentConfig {
	return {
		name,
		instructions: '',
		tools: {},
		interactive: true,
		lifetime: 'persistent_session',
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Persistent Subagent — Long-Lived Interactive Sessions', () => {
	let persistentMgr: PersistentSubagentManager;
	let interactionMgr: InteractionModeManager;
	let factory: PersistentSubagentFactory;

	beforeEach(() => {
		persistentMgr = new PersistentSubagentManager();
		interactionMgr = new InteractionModeManager();
		factory = vi.fn(async (key: string) => createInteractiveInstance(key));
	});

	// -- Interactive wait/resume across turns ---------------------------------

	it('interactive persistent subagent waits for input and resumes', async () => {
		// Simulate: tool call creates persistent instance + interactive session
		const instance = await persistentMgr.acquirePersistent('coder', config('coder'), factory);
		const session = new SubagentSessionImpl('tool-1', config('coder'));

		expect(session.state).toBe('running');

		// Subagent asks a question (blocks)
		session.sendToUser({ type: 'question', text: 'Which approach?', blocking: true });
		expect(session.state).toBe('waiting_for_input');

		// Activate interaction mode for this tool call
		await interactionMgr.activate('tool-1');
		expect(interactionMgr.getMode().type).toBe('subagent_interaction');
		expect(interactionMgr.getActiveToolCallId()).toBe('tool-1');

		// User responds (e.g., via voice transcript routed by InteractionModeManager)
		session.sendToSubagent('Use option A');
		expect(session.state).toBe('running');

		// Subagent asks another question (second turn of interaction)
		session.sendToUser({ type: 'question', text: 'Confirm?', blocking: true });
		expect(session.state).toBe('waiting_for_input');

		// User confirms
		session.sendToSubagent('Yes');
		expect(session.state).toBe('running');

		// Subagent completes
		session.complete({ text: 'done' });
		expect(session.state).toBe('completed');

		// Deactivate interaction mode
		interactionMgr.deactivate('tool-1');
		expect(interactionMgr.getMode().type).toBe('main_agent');

		// Instance is still alive in persistent manager (not disposed)
		expect(persistentMgr.has('coder')).toBe(true);

		// Can invoke again for a new task
		const result = await persistentMgr.invoke('coder', 'Next task', {});
		expect(result).toContain('coder');
		expect(instance.invoke).toHaveBeenCalledWith('Next task', {}, undefined);
	});

	// -- InteractionModeManager routes correctly to active subagent ----------

	it('InteractionModeManager correctly identifies active subagent for input routing', async () => {
		await persistentMgr.acquirePersistent('coder', config('coder'), factory);
		const session = new SubagentSessionImpl('tool-1', config('coder'));

		session.sendToUser({ type: 'question', text: 'Q1?', blocking: true });
		await interactionMgr.activate('tool-1');

		// Verify routing: interaction mode tells us tool-1 is active
		expect(interactionMgr.isSubagentActive()).toBe(true);
		expect(interactionMgr.getActiveToolCallId()).toBe('tool-1');

		// Route user input to session
		const sent = session.trySendToSubagent('Answer');
		expect(sent).toBe(true);
		expect(session.state).toBe('running');

		session.complete({});
		interactionMgr.deactivate('tool-1');
	});

	// -- Cancellation cleans up both session and interaction mode -------------

	it('cancellation cleans up SubagentSession and interaction mode', async () => {
		await persistentMgr.acquirePersistent('coder', config('coder'), factory);
		const session = new SubagentSessionImpl('tool-1', config('coder'));

		session.sendToUser({ type: 'question', text: 'Q?', blocking: true });
		await interactionMgr.activate('tool-1');

		// Cancel the session (e.g., LLM sends tool cancellation)
		session.cancel();
		expect(session.state).toBe('cancelled');

		// Deactivate interaction mode
		interactionMgr.deactivate('tool-1');
		expect(interactionMgr.getMode().type).toBe('main_agent');

		// Persistent instance is still alive (cancelled session ≠ disposed instance)
		expect(persistentMgr.has('coder')).toBe(true);
	});

	// -- Multiple interactive persistent subagents queue correctly -----------

	it('multiple interactive subagents queue in InteractionModeManager', async () => {
		await persistentMgr.acquirePersistent('coder', config('coder'), factory);
		await persistentMgr.acquirePersistent('reviewer', config('reviewer'), factory);

		const session1 = new SubagentSessionImpl('tool-1', config('coder'));
		const session2 = new SubagentSessionImpl('tool-2', config('reviewer'));

		// First subagent asks question → activates
		session1.sendToUser({ type: 'question', text: 'Q1?', blocking: true });
		await interactionMgr.activate('tool-1');
		expect(interactionMgr.getActiveToolCallId()).toBe('tool-1');

		// Second subagent asks question → queued
		session2.sendToUser({ type: 'question', text: 'Q2?', blocking: true });
		const secondReady = interactionMgr.activate('tool-2');
		expect(interactionMgr.queueLength).toBe(1);

		// Resolve first → second promoted
		session1.sendToSubagent('A1');
		session1.complete({});
		interactionMgr.deactivate('tool-1');
		await secondReady;
		expect(interactionMgr.getActiveToolCallId()).toBe('tool-2');

		// Resolve second
		session2.sendToSubagent('A2');
		session2.complete({});
		interactionMgr.deactivate('tool-2');
		expect(interactionMgr.getMode().type).toBe('main_agent');

		// Both persistent instances still alive
		expect(persistentMgr.has('coder')).toBe(true);
		expect(persistentMgr.has('reviewer')).toBe(true);
	});

	// -- Session close disposes persistent instances -------------------------

	it('session close disposes all persistent instances after interactive sessions end', async () => {
		const coderInstance = await persistentMgr.acquirePersistent('coder', config('coder'), factory);
		const reviewerInstance = await persistentMgr.acquirePersistent(
			'reviewer',
			config('reviewer'),
			factory,
		);

		// Simulate some interactive work
		const session = new SubagentSessionImpl('tool-1', config('coder'));
		session.sendToUser({ type: 'question', text: 'Q?', blocking: true });
		await interactionMgr.activate('tool-1');
		session.sendToSubagent('A');
		session.complete({});
		interactionMgr.deactivate('tool-1');

		// Session close
		await persistentMgr.disposeAllPersistent();

		expect(coderInstance.dispose).toHaveBeenCalledOnce();
		expect(reviewerInstance.dispose).toHaveBeenCalledOnce();
		expect(persistentMgr.activeKeys).toEqual([]);
	});

	// -- Terminal state immutability with persistent instance -----------------

	it('completed session cannot be re-interacted but persistent instance can be re-invoked', async () => {
		const instance = await persistentMgr.acquirePersistent('coder', config('coder'), factory);
		const session = new SubagentSessionImpl('tool-1', config('coder'));

		session.complete({});
		expect(session.state).toBe('completed');

		// Cannot interact with completed session
		expect(session.trySendToSubagent('input')).toBe(false);

		// But the persistent instance is still invocable (new tool call, new session)
		const result = await persistentMgr.invoke('coder', 'New task', {});
		expect(result).toBeDefined();
		expect(instance.invoke).toHaveBeenCalled();
	});
});
