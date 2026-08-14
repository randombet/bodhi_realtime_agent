/**
 * Greeting-gate token policy (appendix E1-E3 + hazard H1) — the pure state
 * machine for turn-bound suppression release
 * (design-speech-evidence-architecture.md §2). Content assembly stays in
 * `GreetingController`; timers stay in the controller shell (this module is
 * clock-free and side-effect-free).
 *
 * Binding is BEST-EFFORT, not causal (§2 scope honesty): a model start is
 * bindable only while the token is live, no competing trigger intervened,
 * and no routed user turn completed since the token registered (the start
 * may be the provider answering the user). Ambiguous starts bind nothing and
 * fallback release semantics apply — the failure mode is "release slightly
 * early" (today's behavior), never "hold the gate on the wrong turn".
 *
 * Internal — not exported from the package index.
 */

export type GreetingGateReleaseReason =
	| 'turn-finalized'
	| 'fallback-finalized'
	| 'invalidated'
	| 'no-start-timeout'
	| 'reset'
	| 'teardown';

export class GreetingGatePolicy {
	private tokenLive = false;
	private bindable = false;
	private boundTurnId: string | null = null;
	/** Generation tag: consumers must treat a release from an older
	 *  generation as stale (recovery re-arm safety, H4). */
	private _generation = 0;

	get generation(): number {
		return this._generation;
	}
	get isTokenLive(): boolean {
		return this.tokenLive;
	}
	get isBound(): boolean {
		return this.boundTurnId !== null;
	}

	/** A greeting was sent with suppression armed. */
	registerToken(): void {
		this._generation++;
		this.tokenLive = true;
		this.bindable = true;
		this.boundTurnId = null;
	}

	/** A routed user turn completed since registration — a later model start
	 *  may be the provider answering the user, so it must not bind (§2
	 *  ambiguity rule b). The token stays live; fallback release applies. */
	noteRoutedUserTurn(): void {
		this.bindable = false;
	}

	/** A competing framework trigger (direct input, notification, recovery)
	 *  is about to dispatch — invalidate SYNCHRONOUSLY before it does. */
	invalidateToken(): void {
		this.tokenLive = false;
		this.bindable = false;
		this.boundTurnId = null;
	}

	/** Model turn started. Binds only when the token is live and unambiguous;
	 *  an ambiguous start binds nothing (fallback semantics stay active). */
	onModelTurnStarted(turnId: string | undefined): void {
		if (!this.tokenLive || !this.bindable || this.boundTurnId !== null) return;
		if (turnId === undefined) return;
		this.boundTurnId = turnId;
	}

	/** Should this finalization release suppression?
	 *  BOUND: only the bound turn's finalization releases — for ANY completion
	 *  reason including `interrupted` (a truncated greeting is over; holding
	 *  would leave the session deaf). UNBOUND: any finalization releases
	 *  (today's semantics — the fallback). */
	shouldReleaseOnTurnFinalized(turnId: string | undefined): boolean {
		if (this.boundTurnId !== null) return turnId !== undefined && turnId === this.boundTurnId;
		return true;
	}

	/** Terminal transition — clears all token state (release accounting is the
	 *  caller's job; every active→inactive path emits ONE generation-tagged
	 *  release). */
	clear(): void {
		this.tokenLive = false;
		this.bindable = false;
		this.boundTurnId = null;
	}
}
