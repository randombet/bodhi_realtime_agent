// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { TurnManager } from '../../src/core/turn-manager.js';

/**
 * Unit characterization for the TurnManager extraction (Step 6b of the
 * VoiceSession modularization plan). Pins the turn-birth, signal-correlation,
 * counter-advance, and usage-sequence behavior the former VoiceSession-private
 * `ensureCurrentTurn` / `resolveTurn` / `turnId` bookkeeping had.
 */

function makeManager(over: { agent?: string; serverId?: () => number | undefined } = {}) {
	let agentName = over.agent ?? 'main';
	const turns = new TurnManager({
		getActiveAgentName: () => agentName,
		getActiveServerTurnId: over.serverId ?? (() => undefined),
	});
	return {
		turns,
		setAgent: (n: string) => {
			agentName = n;
		},
	};
}

describe('TurnManager — turn birth', () => {
	it('ensureCurrent births a turn labelled turn_1 stamped with the active agent', () => {
		const { turns } = makeManager({ agent: 'greeter' });
		const turn = turns.ensureCurrent();
		expect(turn?.id).toBe('turn_1');
		expect(turn?.agentName).toBe('greeter');
		expect(turns.current).toBe(turn);
		expect(turns.active()).toBe(turn);
	});

	it('returns the same active turn on repeated calls (births once)', () => {
		const { turns } = makeManager();
		const a = turns.ensureCurrent();
		const b = turns.ensureCurrent();
		expect(a).toBe(b);
	});

	it('binds the explicit server id over the live accessor', () => {
		const { turns } = makeManager({ serverId: () => 9 });
		const turn = turns.ensureCurrent(3);
		expect(turn?.ownsServerTurn(3)).toBe(true);
		expect(turn?.ownsServerTurn(9)).toBe(false);
	});

	it('drops trailing content of a just-finalized turn that owns the id', () => {
		const { turns } = makeManager();
		const t = turns.ensureCurrent(5);
		t?.finalize();
		// Same server id after finalize → trailing content, no new birth.
		expect(turns.ensureCurrent(5)).toBeNull();
		expect(turns.current).toBe(t);
	});

	it('births a new turn (and demotes the old to previous) after finalize with a fresh id', () => {
		const { turns, setAgent } = makeManager({ agent: 'a' });
		const first = turns.ensureCurrent(1);
		first?.finalize();
		setAgent('b');
		const second = turns.ensureCurrent(2);
		expect(second).not.toBe(first);
		expect(second?.id).toBe('turn_1'); // counter not advanced yet
		expect(second?.agentName).toBe('b');
		expect(turns.previous).toBe(first);
	});

	it('active() is null between turns (after finalize)', () => {
		const { turns } = makeManager();
		const t = turns.ensureCurrent();
		expect(turns.active()).toBe(t);
		t?.finalize();
		expect(turns.active()).toBeNull();
		expect(turns.current).toBe(t); // current still points at the finalized turn
	});
});

describe('TurnManager — resolve', () => {
	it('returns new when no turn exists yet', () => {
		const { turns } = makeManager();
		expect(turns.resolve(undefined, 'completion')).toEqual({ kind: 'new' });
	});

	it('id-less usage signal matches the current turn even after finalize', () => {
		const { turns } = makeManager();
		const t = turns.ensureCurrent();
		t?.finalize();
		expect(turns.resolve(undefined, 'usage')).toEqual({ kind: 'match', turn: t });
	});

	it('id-less lifecycle signal after finalize is a new turn', () => {
		const { turns } = makeManager();
		const t = turns.ensureCurrent();
		t?.finalize();
		expect(turns.resolve(undefined, 'completion')).toEqual({ kind: 'new' });
	});

	it('matches a late id-bearing signal to the just-finalized previous turn', () => {
		const { turns } = makeManager();
		const first = turns.ensureCurrent(1);
		first?.finalize();
		turns.ensureCurrent(2); // births a second turn, first → previous
		expect(turns.resolve(1, 'interrupt')).toEqual({ kind: 'match', turn: first });
	});

	it('binds and claims an active turn that owns no id yet', () => {
		const { turns } = makeManager();
		const t = turns.ensureCurrent(); // no server id
		const r = turns.resolve(7, 'completion');
		expect(r).toEqual({ kind: 'match', turn: t });
		expect(t?.ownsServerTurn(7)).toBe(true);
	});

	it('classifies a strictly newer id as new and an older one as stale', () => {
		const { turns } = makeManager();
		const t = turns.ensureCurrent(5);
		t?.finalize();
		expect(turns.resolve(6, 'completion')).toEqual({ kind: 'new' });
		expect(turns.resolve(4, 'completion')).toEqual({ kind: 'stale' });
	});
});

describe('TurnManager — counter and input-turn bookkeeping', () => {
	it('numericId / nextLabel / staleInputCutoff track advance()', () => {
		const { turns } = makeManager();
		expect(turns.numericId).toBe(0);
		expect(turns.nextLabel).toBe('turn_1');
		expect(turns.staleInputCutoff).toBe(-1);
		turns.advance();
		expect(turns.numericId).toBe(1);
		expect(turns.nextLabel).toBe('turn_2');
		expect(turns.staleInputCutoff).toBe(0);
	});

	it('markInputFinalized / isInputFinalized, with advance() pruning old ids', () => {
		const { turns } = makeManager();
		turns.markInputFinalized(); // marks id 0
		expect(turns.isInputFinalized(0)).toBe(true);
		turns.advance(); // counter → 1; 0 is (counter-1), kept
		expect(turns.isInputFinalized(0)).toBe(true);
		turns.advance(); // counter → 2; 0 < 1 now, pruned
		expect(turns.isInputFinalized(0)).toBe(false);
	});
});

describe('TurnManager — usage sequence', () => {
	it('nextUsageSequence increments per key independently', () => {
		const { turns } = makeManager();
		expect(turns.nextUsageSequence('turn_1:llm')).toBe(1);
		expect(turns.nextUsageSequence('turn_1:llm')).toBe(2);
		expect(turns.nextUsageSequence('turn_1:tts')).toBe(1);
	});

	it('resetTurnScopedUsage clears turn-bound keys but keeps no_turn:* counters', () => {
		const { turns } = makeManager();
		turns.nextUsageSequence('turn_1:llm'); // → 1
		turns.nextUsageSequence('no_turn:openai.transcription'); // → 1
		turns.resetTurnScopedUsage();
		// Turn-bound key reset to 0-base.
		expect(turns.nextUsageSequence('turn_1:llm')).toBe(1);
		// Session-scoped key keeps its counter.
		expect(turns.nextUsageSequence('no_turn:openai.transcription')).toBe(2);
	});
});
