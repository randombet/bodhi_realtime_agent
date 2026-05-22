// SPDX-License-Identifier: MIT

/**
 * Turn — the lifecycle entity for one conversational turn.
 *
 * A `Turn` owns the framework turn identity and an explicit, idempotent
 * lifecycle: two states (`active` → `finalized`) and one terminal transition.
 * `finalize()` performs the state change once and reports whether the caller
 * was the first; `VoiceSession` runs side effects only for that first caller,
 * so dedup is structural rather than reconstructed from flags.
 *
 * A framework `Turn` is the unit of conversation and may legitimately span more
 * than one transport server turn (e.g. a blocking subagent question sent
 * mid-turn opens a fresh generation underneath it), so it owns a *set* of
 * server-turn ids rather than one.
 */

export type TurnState = 'active' | 'finalized';

export class Turn {
	/** Framework turn identity, "turn_N", assigned at birth. */
	readonly id: string;
	/** Active agent pinned at birth — for usage / event attribution. */
	readonly agentName: string;

	private _state: TurnState = 'active';
	/** Every transport server-turn id this framework turn has absorbed. */
	private readonly _serverTurnIds = new Set<number>();

	constructor(id: string, agentName: string) {
		this.id = id;
		this.agentName = agentName;
	}

	get isFinalized(): boolean {
		return this._state === 'finalized';
	}

	get hasServerTurnId(): boolean {
		return this._serverTurnIds.size > 0;
	}

	/** Highest server-turn id owned — for the new-vs-stale comparison in resolveTurn. */
	get latestServerTurnId(): number | null {
		return this._serverTurnIds.size > 0 ? Math.max(...this._serverTurnIds) : null;
	}

	/** Record a server-turn id this turn owns. Accumulates (a turn may own >1). */
	bindServerTurnId(id: number): void {
		this._serverTurnIds.add(id);
	}

	ownsServerTurn(id: number): boolean {
		return this._serverTurnIds.has(id);
	}

	/**
	 * Terminal transition. Returns `true` only for the first caller — the
	 * caller that may run side effects. All later calls return `false`.
	 */
	finalize(): boolean {
		if (this._state === 'finalized') return false;
		this._state = 'finalized';
		return true;
	}
}

/**
 * What a transport completion/interrupt/usage signal resolves to.
 * See `VoiceSession.resolveTurn()`.
 */
export type TurnMatch = { kind: 'match'; turn: Turn } | { kind: 'new' } | { kind: 'stale' };

/** Why `resolveTurn()` was called — disambiguates id-less signal handling. */
export type TurnSignalPurpose = 'completion' | 'interrupt' | 'usage';
