// SPDX-License-Identifier: MIT

/** Collaborators read at runtime; thunks so the gate is decoupled from VoiceSession. */
export interface OutboundAudioGateDeps {
	/** Echo-skip window (ms) from the first assistant audio chunk of a turn before a
	 *  client-VAD barge-in may fire — keeps the agent's own opening audio from
	 *  self-interrupting via mic echo. */
	echoSkipMs: number;
	/** The transport's live server-turn id, if it tracks one (Gemini does). */
	getActiveServerTurnId(): number | undefined;
	/** Wall-clock source (ms) — only elapsed deltas are used, so monotonicity is
	 *  not required. Injected for testability (wired to `Date.now`). */
	now(): number;
}

/**
 * Reconciles the *outbound* assistant-audio stream with framework-initiated barge-in on
 * transports that cannot be cancelled server-side (Gemini Live). Owns:
 *  - barge-in eligibility: an "assistant is speaking" window that opens `echoSkipMs` after
 *    the first audio chunk of a turn and closes at turn finalization;
 *  - trailing-audio suppression: after a framework interrupt, drops the interrupted server
 *    turn's continued audio until a new server turn begins.
 *
 * Only consulted on the native no-`liveGate` path (a session with a `PlaybackGate` uses that
 * instead) and only mutes for transports the framework cannot cancel (framework-owned
 * transports cancel generation directly — no trailing audio). In practice: Gemini Live.
 *
 * The peer of `NativeAudioPlaybackGate` for the *playback-gated, non-cancellable* transport
 * shape. See dev_docs/framework/design-outbound-audio-gate.md.
 */
export class OutboundAudioGate {
	/** Time of the current turn's first audio chunk; `null` between/before turns.
	 *  (Nullable rather than a `0` sentinel so a clock reading of exactly 0 works.) */
	private firstAudioAtMs: number | null = null;
	private mutedServerTurnId: number | null = null;

	constructor(private readonly deps: OutboundAudioGateDeps) {}

	/**
	 * Per outbound audio chunk. Records first-audio time; returns `false` to DROP the chunk
	 * (trailing audio of an interrupted server turn). Self-clears the mute when a new server
	 * turn produces audio.
	 */
	noteAudioChunk(): boolean {
		if (this.mutedServerTurnId !== null) {
			const active = this.deps.getActiveServerTurnId() ?? null;
			if (active === this.mutedServerTurnId) return false;
			this.mutedServerTurnId = null;
		}
		if (this.firstAudioAtMs === null) this.firstAudioAtMs = this.deps.now();
		return true;
	}

	/** True once the active turn has been emitting audio past the echo-skip window. */
	isInterruptible(): boolean {
		return (
			this.firstAudioAtMs !== null && this.deps.now() - this.firstAudioAtMs >= this.deps.echoSkipMs
		);
	}

	/**
	 * A framework-initiated interrupt the transport can't cancel: drop the rest of the current
	 * server turn's audio until the next one starts.
	 */
	muteCurrentServerTurn(): void {
		this.mutedServerTurnId = this.deps.getActiveServerTurnId() ?? null;
	}

	/** A new model response begins — reset the window and stop muting. */
	onTurnStart(): void {
		this.firstAudioAtMs = null;
		this.mutedServerTurnId = null;
	}

	/** The current turn finalized — close the interruptible window. */
	onTurnFinalized(): void {
		this.firstAudioAtMs = null;
	}
}
