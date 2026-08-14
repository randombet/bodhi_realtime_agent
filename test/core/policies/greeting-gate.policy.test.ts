import { describe, expect, it } from 'vitest';
import { GreetingGatePolicy } from '../../../src/core/policies/greeting-gate.policy.js';

describe('GreetingGatePolicy (H1 token state machine)', () => {
	it("UNBOUND fallback: any finalization releases (today's semantics)", () => {
		const g = new GreetingGatePolicy();
		g.registerToken();
		expect(g.shouldReleaseOnTurnFinalized('turn_x')).toBe(true);
		expect(g.shouldReleaseOnTurnFinalized(undefined)).toBe(true);
	});

	it('BOUND: only the bound turn releases — for any completion reason', () => {
		const g = new GreetingGatePolicy();
		g.registerToken();
		g.onModelTurnStarted('turn_greeting');
		expect(g.isBound).toBe(true);
		expect(g.shouldReleaseOnTurnFinalized('turn_other')).toBe(false);
		expect(g.shouldReleaseOnTurnFinalized('turn_greeting')).toBe(true);
	});

	it('a competing trigger invalidates the token synchronously — later starts bind nothing', () => {
		const g = new GreetingGatePolicy();
		g.registerToken();
		g.invalidateToken();
		g.onModelTurnStarted('turn_after_invalidate');
		expect(g.isBound).toBe(false);
		expect(g.shouldReleaseOnTurnFinalized('anything')).toBe(true); // fallback
	});

	it('a routed user turn since registration makes model starts unbindable (ambiguity rule b)', () => {
		const g = new GreetingGatePolicy();
		g.registerToken();
		g.noteRoutedUserTurn();
		g.onModelTurnStarted('turn_maybe_answer');
		expect(g.isBound).toBe(false); // ambiguous — never hold on the wrong turn
	});

	it('binds at most once; re-registration starts a new generation unbound', () => {
		const g = new GreetingGatePolicy();
		g.registerToken();
		const gen1 = g.generation;
		g.onModelTurnStarted('turn_1');
		g.onModelTurnStarted('turn_2'); // ignored — already bound
		expect(g.shouldReleaseOnTurnFinalized('turn_2')).toBe(false);
		g.registerToken(); // transfer greeting re-registers
		expect(g.generation).toBe(gen1 + 1);
		expect(g.isBound).toBe(false);
	});
});
