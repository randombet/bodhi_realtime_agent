/**
 * Recovery policy (appendix B4/B5 + hazard H4) — the pure fire-time decision
 * for the response watchdog (design-speech-evidence-architecture.md §2).
 * The reconnector remains the actuation shell (timers, replay tiers,
 * reconnect budget); this module owns only the verdict at fire time and at
 * gate release.
 *
 * THE GREETING HOLD PREDICATE IS FULL-GREETING SUPPRESSION ONLY — callers
 * must pass the uninterruptible-greeting state, never the ≤5 s AEC grace or
 * the pre-first-audio window (recovery proceeds through short grace windows
 * today, harmlessly; holding there would be an unapproved divergence). The
 * only other hold input is the synthetic-output hold of a host recovery.
 *
 * Held-state override (H4): while a recovery is held, ambiguous model
 * activity must NOT cancel it or clear the retained candidate — the
 * greeting's own model start would otherwise erase exactly the recovery the
 * hold exists to preserve. Release-time re-evaluation with fresh facts
 * decides instead. Strict causal cancellation activates only with the
 * transport correlation-ID contract.
 *
 * Internal — not exported from the package index.
 */

export type WatchdogFireVerdict = 'defer-speech' | 'hold-gate' | 'recover';

/** Fire-time decision, evaluated in priority order: live user speech defers
 *  (R7a, unchanged); full-greeting suppression holds (H4 — recovery output
 *  must not land inside an open greeting turn), and so does an active
 *  synthetic-output hold after a host recovery (a replay or nudge is
 *  synthetic output the hold forbids until fresh user evidence); otherwise
 *  recover. Both holds share one verdict: the held recovery is re-evaluated
 *  when its hold releases. */
export function decideOnWatchdogFire(facts: {
	speechActive: boolean;
	greetingSuppressionArmed: boolean;
	syntheticHoldActive: boolean;
}): WatchdogFireVerdict {
	if (facts.speechActive) return 'defer-speech';
	if (facts.greetingSuppressionArmed) return 'hold-gate';
	if (facts.syntheticHoldActive) return 'hold-gate';
	return 'recover';
}

/** Release-time re-evaluation — NEVER a blind transition (the gate can be
 *  held for seconds; the world changes underneath it). */
export function decideOnGateReleased(facts: {
	speechActive: boolean;
	sessionActive: boolean;
}): 'defer-speech' | 'recover' | 'idle' {
	if (!facts.sessionActive) return 'idle';
	if (facts.speechActive) return 'defer-speech';
	return 'recover';
}
