import { Turn } from './turn.js';
import type { TurnMatch, TurnSignalPurpose } from './turn.js';

/**
 * Narrow collaborators the {@link TurnManager} reads at turn-birth time. Both
 * are thunks so the manager can be constructed before the transport and agent
 * router are fully wired (it only dereferences them at runtime).
 */
export interface TurnManagerDeps {
	/** Name of the agent currently active — stamped onto newly born `Turn`s. */
	getActiveAgentName(): string;
	/** The transport's live server-turn id, if it tracks one (else undefined). */
	getActiveServerTurnId(): number | undefined;
}

/**
 * Owns the framework turn lifecycle that was previously spread across
 * `VoiceSession`: the numeric `turnId` counter, the `current`/`previous` `Turn`
 * pointers, the per-turn usage-sequence map, and the finalized-input-turn set
 * used for stale-STT-result rejection.
 *
 * `finalizeTurn` itself stays in `VoiceSession` (its completion effects are
 * session-wide); it drives the counter through this unit via {@link advance}
 * and {@link resetTurnScopedUsage}.
 *
 * See dev_docs/framework/design-turn-lifecycle-refactor.md and
 * dev_docs/framework/investigation-voice-session-modularity.md (Step 6b).
 */
export class TurnManager {
	private turnId = 0;
	/** The most recent framework turn (active or finalized). */
	private _current: Turn | null = null;
	/** The turn before `_current` — kept so late id-bearing signals for a
	 *  just-finalized turn can still correlate after the next turn is born. */
	private _previous: Turn | null = null;
	/** Per-source monotonic sequence within the current model turn. */
	private usageSequence = new Map<string, number>();
	/** Input turns whose user transcript was already relayed to a waiting
	 *  subagent — later STT results for them are dropped. */
	private finalizedInputTurnIds = new Set<number>();

	constructor(private readonly deps: TurnManagerDeps) {}

	// --- Turn pointers ---------------------------------------------------------

	get current(): Turn | null {
		return this._current;
	}

	get previous(): Turn | null {
		return this._previous;
	}

	/**
	 * The current framework `Turn` only while it is *active* — `null` between
	 * turns (`current` itself keeps pointing at the finalized turn for
	 * late-signal correlation, so it must not be used for active-turn readers).
	 */
	active(): Turn | null {
		return this._current && !this._current.isFinalized ? this._current : null;
	}

	/**
	 * Birth or return the current framework `Turn`. Called from every
	 * model-output path; the first one to fire births and binds the turn, the
	 * rest get the existing `current`. A `null` return means the signal is
	 * trailing content of an already-finalized turn — the caller drops it.
	 *
	 * `explicitServerId` (a transport callback's own id) wins over the live
	 * `getActiveServerTurnId()` accessor, which may have moved on.
	 *
	 * See dev_docs/framework/design-turn-lifecycle-refactor.md § Turn birth.
	 */
	ensureCurrent(explicitServerId?: number): Turn | null {
		const cur = this._current;
		const serverId = explicitServerId ?? this.deps.getActiveServerTurnId();

		if (cur && !cur.isFinalized) {
			if (serverId !== undefined) cur.bindServerTurnId(serverId);
			return cur;
		}

		// current is finalized (or null): trailing content of the
		// just-finalized turn, or a genuinely new server turn?
		if (cur?.isFinalized && serverId !== undefined && cur.ownsServerTurn(serverId)) {
			return null;
		}

		this._previous = cur;
		this._current = new Turn(`turn_${this.turnId + 1}`, this.deps.getActiveAgentName());
		if (serverId !== undefined) this._current.bindServerTurnId(serverId);
		return this._current;
	}

	/**
	 * Map a transport completion/interrupt/usage signal to the `Turn` it
	 * concerns — `match` (an existing turn), `new` (newer than any known, the
	 * caller may birth one), or `stale` (already gone, ignore).
	 *
	 * See dev_docs/framework/design-turn-lifecycle-refactor.md
	 * § Transport-signal correlation.
	 */
	resolve(serverTurnId: number | undefined, purpose: TurnSignalPurpose): TurnMatch {
		const cur = this._current;
		// Rule 1 — no turn yet.
		if (cur === null) return { kind: 'new' };
		// Rule 2 — id-less transports (OpenAI Realtime, mocks).
		if (serverTurnId === undefined) {
			if (purpose === 'usage') return { kind: 'match', turn: cur };
			if (!cur.isFinalized) return { kind: 'match', turn: cur };
			// A lifecycle signal that survives after the current turn finalized is
			// the first sign of a new no-model-output response (id-less adapters
			// must suppress stale cancelled callbacks).
			return { kind: 'new' };
		}
		// Rule 3 — the current turn owns this id.
		if (cur.ownsServerTurn(serverTurnId)) return { kind: 'match', turn: cur };
		// Rule 4 — a late signal for the just-finalized turn.
		if (this._previous?.ownsServerTurn(serverTurnId)) {
			return { kind: 'match', turn: this._previous };
		}
		// Rule 5 — active turn that owns no id yet: bind and claim it.
		if (!cur.isFinalized && !cur.hasServerTurnId) {
			cur.bindServerTurnId(serverTurnId);
			return { kind: 'match', turn: cur };
		}
		// Rule 6 — finalized turn that owns no id: a no-model-output turn, so an
		// incoming id-bearing signal is the first sign of a newer turn.
		if (cur.isFinalized && !cur.hasServerTurnId) return { kind: 'new' };
		// Rules 7/8 — newer than any known id → new; otherwise stale.
		const latest = cur.latestServerTurnId;
		return latest !== null && serverTurnId > latest ? { kind: 'new' } : { kind: 'stale' };
	}

	// --- Numeric id / input-turn bookkeeping -----------------------------------

	/** The current numeric turn id (the counter STT providers commit against). */
	get numericId(): number {
		return this.turnId;
	}

	/** The id label the next-born turn will carry (`turn_${nextId}`). */
	get nextLabel(): string {
		return `turn_${this.turnId + 1}`;
	}

	/** Stale-result cutoff: STT results with `turnId < this` are 2+ turns old. */
	get staleInputCutoff(): number {
		return this.turnId - 1;
	}

	/** Mark the current input turn's user transcript as already relayed. */
	markInputFinalized(): void {
		this.finalizedInputTurnIds.add(this.turnId);
	}

	isInputFinalized(id: number): boolean {
		return this.finalizedInputTurnIds.has(id);
	}

	/** Advance the turn counter and prune now-old finalized input-turn ids. */
	advance(): void {
		this.turnId++;
		for (const id of this.finalizedInputTurnIds) {
			if (id < this.turnId - 1) this.finalizedInputTurnIds.delete(id);
		}
	}

	// --- Per-turn usage sequence -----------------------------------------------

	/** Next monotonic sequence number for a usage source within this turn. */
	nextUsageSequence(seqKey: string): number {
		const sequence = (this.usageSequence.get(seqKey) ?? 0) + 1;
		this.usageSequence.set(seqKey, sequence);
		return sequence;
	}

	/**
	 * Reset turn-bound usage counters at turn completion; non-turn-bound
	 * (`no_turn:*`) keys keep their session-scoped counter.
	 */
	resetTurnScopedUsage(): void {
		for (const k of [...this.usageSequence.keys()]) {
			if (!k.startsWith('no_turn:')) this.usageSequence.delete(k);
		}
	}
}
