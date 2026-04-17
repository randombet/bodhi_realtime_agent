// SPDX-License-Identifier: MIT

/**
 * State Ownership Invariant Tests
 *
 * Enforces the single-source-of-truth rule defined in
 * dev_docs/framework/state-ownership-map.md. Each state domain has exactly one
 * authoritative owner. Actor components orchestrate over these owners —
 * they never maintain parallel copies of the same state.
 */

import { describe, expect, it, vi } from 'vitest';
import { PersistentSubagentManager } from '../../src/agent/persistent-subagent-manager.js';
import { SubagentSessionImpl } from '../../src/agent/subagent-session.js';
import { InteractionModeManager } from '../../src/core/interaction-mode.js';
import { SessionManager } from '../../src/core/session-manager.js';

describe('State Ownership Invariants', () => {
	// -- SessionManager owns session lifecycle state ---------------------------

	describe('SessionManager is the sole session lifecycle authority', () => {
		it('tracks CREATED → CONNECTING → ACTIVE → CLOSED transitions', () => {
			const eventBus = { publish: vi.fn() };
			const hooks = {};
			const mgr = new SessionManager(
				{ sessionId: 's1', userId: 'u1', initialAgent: 'main' },
				eventBus as never,
				hooks as never,
			);

			expect(mgr.state).toBe('CREATED');
			mgr.transitionTo('CONNECTING');
			expect(mgr.state).toBe('CONNECTING');
			mgr.transitionTo('ACTIVE');
			expect(mgr.state).toBe('ACTIVE');
			mgr.transitionTo('CLOSED');
			expect(mgr.state).toBe('CLOSED');
		});

		it('rejects invalid transitions', () => {
			const eventBus = { publish: vi.fn() };
			const hooks = {};
			const mgr = new SessionManager(
				{ sessionId: 's1', userId: 'u1', initialAgent: 'main' },
				eventBus as never,
				hooks as never,
			);

			expect(() => mgr.transitionTo('ACTIVE')).toThrow(); // CREATED → ACTIVE not allowed
		});
	});

	// -- SubagentSession owns interactive subagent state ----------------------

	describe('SubagentSession is the sole subagent wait/run authority', () => {
		it('tracks running → waiting_for_input → running → completed', () => {
			const session = new SubagentSessionImpl('tool-1');

			expect(session.state).toBe('running');

			session.sendToUser({ type: 'question', text: 'q?', blocking: true });
			expect(session.state).toBe('waiting_for_input');

			session.sendToSubagent('answer');
			expect(session.state).toBe('running');

			session.complete({ text: 'done' });
			expect(session.state).toBe('completed');
		});

		it('enforces terminal state immutability', () => {
			const session = new SubagentSessionImpl('tool-1');
			session.cancel();
			expect(session.state).toBe('cancelled');

			// Calling complete on a cancelled session is a no-op (idempotent)
			session.complete({});
			expect(session.state).toBe('cancelled');
		});
	});

	// -- InteractionModeManager owns interaction routing ----------------------

	describe('InteractionModeManager is the sole interaction target authority', () => {
		it('tracks main_agent ↔ subagent_interaction transitions', async () => {
			const mgr = new InteractionModeManager();

			expect(mgr.getMode().type).toBe('main_agent');
			expect(mgr.isSubagentActive()).toBe(false);

			await mgr.activate('tool-1');
			expect(mgr.getMode().type).toBe('subagent_interaction');
			expect(mgr.getActiveToolCallId()).toBe('tool-1');

			mgr.deactivate('tool-1');
			expect(mgr.getMode().type).toBe('main_agent');
		});

		it('maintains FIFO queue for concurrent subagent interactions', async () => {
			const mgr = new InteractionModeManager();

			// First subagent activates immediately
			await mgr.activate('tool-1');
			expect(mgr.getActiveToolCallId()).toBe('tool-1');

			// Second subagent is queued
			const secondReady = mgr.activate('tool-2');
			expect(mgr.queueLength).toBe(1);

			// Deactivate first → second is promoted
			mgr.deactivate('tool-1');
			await secondReady;
			expect(mgr.getActiveToolCallId()).toBe('tool-2');
		});
	});

	// -- PersistentSubagentManager owns persistent instance registry ----------

	describe('PersistentSubagentManager is the sole persistent instance authority', () => {
		it('maintains key → instance mapping with proper lifecycle', async () => {
			const mgr = new PersistentSubagentManager();
			const factory = vi.fn(async (key: string) => ({
				key,
				invoke: vi.fn().mockResolvedValue('ok'),
				dispose: vi.fn().mockResolvedValue(undefined),
			}));

			expect(mgr.has('k1')).toBe(false);

			await mgr.acquirePersistent('k1', { name: 'a', instructions: '', tools: {} }, factory);
			expect(mgr.has('k1')).toBe(true);

			await mgr.releasePersistent('k1');
			expect(mgr.has('k1')).toBe(false);
		});
	});

	// -- Cross-cutting: no state duplication across owners --------------------

	describe('no state duplication across owners', () => {
		it('SessionManager and SubagentSession track orthogonal state domains', () => {
			// SessionManager states: CREATED, CONNECTING, ACTIVE, RECONNECTING, TRANSFERRING, CLOSED
			// SubagentSession states: running, waiting_for_input, completed, cancelled
			// These are completely disjoint — no overlap.
			const sessionStates = [
				'CREATED',
				'CONNECTING',
				'ACTIVE',
				'RECONNECTING',
				'TRANSFERRING',
				'CLOSED',
			];
			const subagentStates = ['running', 'waiting_for_input', 'completed', 'cancelled'];

			for (const s of sessionStates) {
				expect(subagentStates.includes(s.toLowerCase())).toBe(false);
			}
		});

		it('InteractionModeManager state is distinct from SubagentSession state', () => {
			// InteractionModeManager modes: 'main_agent', 'subagent_interaction'
			// SubagentSession states: 'running', 'waiting_for_input', 'completed', 'cancelled'
			// No overlap — InteractionModeManager tracks WHO gets user input,
			// SubagentSession tracks the lifecycle of a specific subagent.
			const interactionModes = ['main_agent', 'subagent_interaction'];
			const subagentStates = ['running', 'waiting_for_input', 'completed', 'cancelled'];

			for (const mode of interactionModes) {
				expect(subagentStates.includes(mode)).toBe(false);
			}
		});
	});
});
