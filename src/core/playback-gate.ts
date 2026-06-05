// SPDX-License-Identifier: MIT

import type { AudioFormatSpec, LLMTransport } from '../types/transport.js';
import type { Turn } from './turn.js';

/**
 * Uniform shape over the framework's two playback-gating paths (native audio and
 * external TTS), formalizing the object `VoiceSession.liveGate()` used to return
 * inline. The completion arbiter and the VAD barge-in policy read a turn's
 * playback state through this interface without knowing which path is active.
 *
 * See dev_docs/framework/investigation-voice-session-modularity.md (Step 4).
 */
export interface PlaybackGate {
	/** A post-synthesis turn is awaiting playback-end (barge-in still possible). */
	readonly pending: boolean;
	/** The audio-done point has passed (rejects a premature playback.ended). */
	readonly timerArmed: boolean;
	/** Correlation id for the live turn's playback (requestId / nativePlaybackId). */
	readonly id: number;
	armTimer(delayMs: number, cb: () => void): void;
	clearTimer(): void;
}

/** Dependencies for {@link NativeAudioPlaybackGate} — a narrow slice of the
 *  transport (read-only format + one capability flag + the `cancelResponse`
 *  actuator) plus callbacks into turn finalization, never the session itself. */
export interface NativeGateDeps {
	/** Transport output format (stable) — used to estimate chunk playback duration. */
	audioFormat: AudioFormatSpec;
	/** `transport.capabilities.frameworkOwnsInterrupt === true`. */
	frameworkOwnsInterrupt: boolean;
	/** Fallback-completion margin (ms) added to the playback estimate. */
	fallbackMarginMs: number;
	/** Slowest client playback rate — the estimate is divided by this. */
	minPlaybackRate: number;
	cancelResponse: (opts?: { truncate?: 'generated' }) => void;
	/** Grace-gated interrupt request; `false` means the grace window denied it. */
	requestInterrupt: (source: string) => boolean;
	/** The session's current framework turn. */
	getCurrentTurn: () => Turn | null;
	/** Finalize a turn (clean or interrupted) — wraps `VoiceSession.finalizeTurn`. */
	onComplete: (turn: Turn | null, opts: { interrupted: boolean }) => void;
	log: (msg: string) => void;
	/** Injectable wall clock (tests). Defaults to `Date.now`. */
	clock?: () => number;
}

/**
 * Native-audio playback-end gate (the OpenAI native path), extracted from
 * `VoiceSession` (Step 4). Owns the `_native*` timer / pending / captured-turn /
 * cursor / correlation-id state and the post-`response.done` barge-in. The gate
 * exists for every native (non-TTS) session — its barge-in `installBargeIn`
 * runs regardless of gating — but only *arms* (defers turn completion) when the
 * session has `nativePlaybackGatingActive`.
 */
export class NativeAudioPlaybackGate implements PlaybackGate {
	private estimatedEndMs = 0;
	private _id = 0;
	private _pending = false;
	private _timer?: ReturnType<typeof setTimeout>;
	private _turn: Turn | null = null;
	private readonly clock: () => number;

	constructor(private readonly d: NativeGateDeps) {
		this.clock = d.clock ?? Date.now;
	}

	get pending(): boolean {
		return this._pending;
	}
	get timerArmed(): boolean {
		return this._timer !== undefined;
	}
	get id(): number {
		return this._id;
	}
	/** The turn captured when the gate armed (finalized on gate completion). */
	get capturedTurn(): Turn | null {
		return this._turn;
	}
	/** True once this turn's terminal response produced native audio (the gate
	 *  arms only then). */
	get hasAudio(): boolean {
		return this.estimatedEndMs !== 0;
	}

	armTimer(delayMs: number, cb: () => void): void {
		this._timer = setTimeout(() => {
			this._timer = undefined;
			cb();
		}, delayMs);
	}

	clearTimer(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	/** Account for a native audio chunk — advances the playback-end estimate and,
	 *  on the first chunk of a turn, bumps the correlation id. */
	noteAudioChunk(byteLength: number): void {
		const fmt = this.d.audioFormat;
		const bytesPerSample = (fmt.outputBitDepth ?? fmt.bitDepth) === 8 ? 1 : 2;
		const channels = fmt.channels ?? 1;
		const chunkMs = (byteLength / (fmt.outputSampleRate * channels * bytesPerSample)) * 1000;
		if (this.estimatedEndMs === 0) this._id++;
		this.estimatedEndMs =
			Math.max(this.estimatedEndMs, this.clock()) + chunkMs / this.d.minPlaybackRate;
	}

	/** Arm the gate for a terminal native turn that produced audio. Returns the
	 *  playbackId to echo in the `audio.done` frame. The fallback timer runs
	 *  `onFallback` (id-guarded so a callback queued before an interrupt no-ops). */
	arm(turn: Turn | null, onFallback: () => void): number {
		const armedId = this._id;
		this._pending = true;
		this._turn = turn;
		const delayMs = Math.max(this.estimatedEndMs - this.clock(), 0) + this.d.fallbackMarginMs;
		this._timer = setTimeout(() => {
			this._timer = undefined;
			if (this._pending && armedId === this._id) onFallback();
		}, delayMs);
		return armedId;
	}

	/** Full teardown — clears timer/pending/turn/cursor and bumps the id so a late
	 *  signal for the finalized turn cannot match a later one. (The session resets
	 *  the shared playback-defer flag separately.) */
	clear(): void {
		this.clearTimer();
		this._pending = false;
		this._turn = null;
		this.estimatedEndMs = 0;
		this._id++;
	}

	/**
	 * Install the chained `onSpeechStarted` barge-in on the transport — the
	 * `!ttsProvider` sibling of the TTS barge-in. Interrupts a playback-pending
	 * native turn (post-`response.done`) and, in framework-owned mode, also a
	 * still-generating turn. Runs for every native session regardless of gating.
	 */
	installBargeIn(transport: LLMTransport): void {
		const prev = transport.onSpeechStarted;
		transport.onSpeechStarted = () => {
			try {
				prev?.();
			} catch (e) {
				this.d.log(`pre-attached onSpeechStarted threw: ${(e as Error).message}`);
			}
			// Provider-owned mode: the transport's own speech_started handler
			// truncates + fires onInterrupted; only the native tail path remains.
			if (!this.d.frameworkOwnsInterrupt) {
				if (this._pending) this.d.onComplete(this._turn, { interrupted: true });
				return;
			}
			const cur = this.d.getCurrentTurn();
			if (!cur || cur.isFinalized) return;
			if (this._pending) {
				// Tail mode (post response.done) — grace-guarded.
				if (!this.d.requestInterrupt('native-onSpeechStarted-tail')) return;
				this.d.cancelResponse({});
				this.d.onComplete(this._turn ?? cur, { interrupted: true });
				return;
			}
			// Generation mode (before response.done) — truncate generated audio.
			if (!this.d.requestInterrupt('native-onSpeechStarted-generation')) return;
			this.d.cancelResponse({ truncate: 'generated' });
			this.d.onComplete(cur, { interrupted: true });
		};
	}
}
