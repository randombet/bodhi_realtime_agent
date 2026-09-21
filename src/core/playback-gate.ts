import type { AudioFormatSpec, LLMTransport } from '../types/transport.js';
import type { TTSAudioConfig } from '../types/tts.js';
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

/** Dependencies for {@link ExternalTtsPlaybackGate} — only turn finalization
 *  callbacks, never the session. The wiring (provider/transport callbacks, the
 *  audio I/O, hooks, grace) stays in `VoiceSession.wireTtsProvider`, which drives
 *  the gate through its methods and getters. */
export interface TtsGateDeps {
	/** Finalize a turn — wraps `VoiceSession.finalizeTurn`. */
	onComplete: (turn: Turn | null, opts: { interrupted: boolean }) => void;
	/** The session's current framework turn. */
	getCurrentTurn: () => Turn | null;
	log: (msg: string) => void;
	/** Injectable wall clock (tests). Defaults to `Date.now`. */
	clock?: () => number;
}

/**
 * External-TTS playback gate, extracted from `VoiceSession` (Step 4–5). Owns the
 * former `_tts*` state machine (request id, the LLM-text-done / audio-done /
 * speaking flags, the format, the hard-cap + playback timers, and the timing
 * counters) and the completion logic (`maybeComplete`, `completeAudio`, the hard
 * cap, interrupt teardown). It does NOT own the source-neutral playback-defer
 * flag (`_ttsPlaybackEndedPending`) — that stays in the session until Step 6.
 */
export class ExternalTtsPlaybackGate implements PlaybackGate {
	private requestId = 0;
	private turnHasText = false;
	private llmTextDone = false;
	private audioDone = false;
	private speaking = false;
	private _format?: TTSAudioConfig;
	private hardTimer?: ReturnType<typeof setTimeout>;
	private firstTextMs = 0;
	private firstAudioMs = 0;
	private _textLength = 0;
	private audioDurationMs = 0;
	private playbackTimer?: ReturnType<typeof setTimeout>;
	private estimatedEndMs: number | null = null;
	private readonly clock: () => number;

	constructor(private readonly d: TtsGateDeps) {
		this.clock = d.clock ?? Date.now;
	}

	// --- PlaybackGate ---
	get pending(): boolean {
		return this.speaking;
	}
	get timerArmed(): boolean {
		return this.playbackTimer !== undefined;
	}
	get id(): number {
		return this.requestId;
	}
	armTimer(delayMs: number, cb: () => void): void {
		this.playbackTimer = setTimeout(() => {
			this.playbackTimer = undefined;
			cb();
		}, delayMs);
	}
	/** liveGate's clearTimer clears BOTH TTS timers (hard cap + playback). */
	clearTimer(): void {
		this.clearTimers();
	}

	// --- Read surface for the wiring in VoiceSession.wireTtsProvider ---
	get isSpeaking(): boolean {
		return this.speaking;
	}
	get isLlmTextDone(): boolean {
		return this.llmTextDone;
	}
	get hasTurnText(): boolean {
		return this.turnHasText;
	}
	get format(): TTSAudioConfig | undefined {
		return this._format;
	}
	get currentRequestId(): number {
		return this.requestId;
	}
	get firstTextAtMs(): number {
		return this.firstTextMs;
	}
	get firstAudioAtMs(): number {
		return this.firstAudioMs;
	}
	get textLength(): number {
		return this._textLength;
	}
	get totalAudioDurationMs(): number {
		return this.audioDurationMs;
	}
	get estimatedPlaybackEndMs(): number | null {
		return this.estimatedEndMs;
	}

	setFormat(fmt: TTSAudioConfig): void {
		this._format = fmt;
	}

	/** First text chunk of a turn — bump the request id and reset per-turn
	 *  counters. (The session resets the shared playback-defer flag alongside.) */
	beginRequest(): void {
		this.requestId++;
		this.turnHasText = true;
		this.firstTextMs = this.clock();
		this.firstAudioMs = 0;
		this._textLength = 0;
		this.audioDurationMs = 0;
		this.estimatedEndMs = null;
	}

	addTextLength(n: number): void {
		this._textLength += n;
	}

	/** An audio chunk reached the client. */
	noteAudio(durationMs: number): void {
		this.speaking = true;
		this.audioDurationMs += durationMs;
		if (this.firstAudioMs === 0) this.firstAudioMs = this.clock();
	}

	setEstimatedEnd(ms: number): void {
		this.estimatedEndMs = ms;
	}

	clearTimers(): void {
		if (this.hardTimer) {
			clearTimeout(this.hardTimer);
			this.hardTimer = undefined;
		}
		if (this.playbackTimer) {
			clearTimeout(this.playbackTimer);
			this.playbackTimer = undefined;
		}
	}

	/** Turn gating: when both the LLM text stream and TTS audio are done, finalize. */
	maybeComplete(): void {
		if (this.llmTextDone && this.audioDone) {
			this.llmTextDone = false;
			this.audioDone = false;
			this.turnHasText = false;
			this.clearTimers();
			this.d.onComplete(this.d.getCurrentTurn(), { interrupted: false });
		}
	}

	/** `completePlayback`'s TTS arm — audio has drained; attempt completion. */
	completeAudio(): void {
		this.audioDone = true;
		this.speaking = false;
		this.maybeComplete();
	}

	/** handleTurnComplete: the LLM text stream ended. */
	markLlmTextDone(): void {
		this.llmTextDone = true;
	}

	/** A tool-call-only turn produced no synthesized text — TTS won't fire onDone. */
	markNoTextTurnAudioDone(): void {
		this.audioDone = true;
	}

	/** Arm the 60 s hard cap (idempotent) that force-completes a stuck turn.
	 *  `onClearDefer` resets the session's shared playback-defer flag — the one
	 *  field the gate does not own. */
	armHardCapIfNeeded(onClearDefer: () => void): void {
		if (this.hardTimer) return;
		this.hardTimer = setTimeout(() => {
			this.d.log('TTS hard cap timer fired — forcing turn completion');
			this.audioDone = true;
			this.speaking = false;
			this.estimatedEndMs = null;
			this.requestId++; // invalidate late-arriving chunks
			onClearDefer();
			this.maybeComplete();
		}, 60000);
	}

	/** finalizeTurn interrupted teardown — the gate's part (Hazard-2 order: bump
	 *  the request id BEFORE the caller runs `ttsProvider.cancel()`). */
	resetForInterrupt(): void {
		this.speaking = false;
		this.llmTextDone = false;
		this.audioDone = false;
		this.turnHasText = false;
		this.estimatedEndMs = null;
		this.requestId++;
		this.clearTimers();
	}
}
