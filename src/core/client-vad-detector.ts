import { type FrameEnergy, analyzeFrameInto } from './audio-frame-analyzer.js';
import type { VadTerminalDescriptor } from './client-vad-semantics.js';

/** Energy thresholds for the client-side VAD. Exported so the completion
 *  arbiter (still in `VoiceSession`) can reuse `CLIENT_VAD_SILENCE_MS`. */
export const CLIENT_VAD_SILENCE_MS = 500;
export const CLIENT_VAD_MIN_SPEECH_MS = 120;
export const CLIENT_VAD_PEAK_THRESHOLD = 1200;
export const CLIENT_VAD_AVG_ABS_THRESHOLD = 220;

/** Outcome of a completed speech segment. */
export type VadSegmentOutcome = 'completed' | 'ignored' | 'none';

/** Allocation-free per-frame classification returned by `process()` —
 *  numeric bitflags, OR-combined, so the audio fast path allocates nothing
 *  (see design-speech-evidence-architecture.md §1). `VOICED` = this frame
 *  cleared the energy thresholds; `SEGMENT_STARTED` = this frame opened a
 *  new speech segment (the router resets its per-segment route flag on this
 *  bit BEFORE routing the frame). Empty/invalid frames return `NONE`. */
export const VAD_FRAME = {
	NONE: 0,
	VOICED: 1,
	SEGMENT_STARTED: 2,
	/** This frame's processing performed a silence terminal — the router
	 *  finishes routing, then consumes `takeTerminal()` for the ledger track
	 *  (dual-track terminals; legacy callbacks already fired synchronously). */
	TERMINAL: 4,
} as const;

/** One-shot speech check over PCM16 chunks with the same energy thresholds as
 *  the live VAD. Used on the reconnect-buffer drain ("did the user speak during
 *  the reconnect window?") — clients stream continuously, so chunk *presence*
 *  is meaningless; only speech energy counts. */
export function pcmChunksContainSpeech(chunks: Buffer[]): boolean {
	const energy: FrameEnergy = { maxAbs: 0, avgAbs: 0, samples: 0 };
	for (const chunk of chunks) {
		if (chunk.length < 2) continue;
		analyzeFrameInto(chunk, energy);
		if (energy.samples === 0) continue;
		if (
			energy.maxAbs >= CLIENT_VAD_PEAK_THRESHOLD ||
			energy.avgAbs >= CLIENT_VAD_AVG_ABS_THRESHOLD
		) {
			return true;
		}
	}
	return false;
}

/**
 * Events emitted by `ClientVadDetector`. The detector owns the VAD *state*;
 * these hooks let `VoiceSession` keep the *policy* (barge-in actuation, the
 * playback-defer resolution, and log-dedup reset) without the detector
 * depending on the session.
 */
export interface VadEvents {
	/** A new speech segment began. (Session resets its transcription log-dedup.) */
	onSpeechStart(maxAbs: number, avgAbs: number): void;
	/** A voiced frame within a segment. (Session runs the barge-in policy:
	 *  gate-pending check, grace, and actuation.) */
	onVoicedFrame(now: number, maxAbs: number, avgAbs: number): void;
	/** A speech segment ended (outcome ≠ `'none'`), after its state was torn
	 *  down. (Session resolves any deferred playback completion.) */
	onSegmentResolved(): void;
	/** A speech segment completed with a real `'completed'` outcome (≥ min
	 *  speech) — the user finished a turn. Fires only on `'completed'`, never on
	 *  `'ignored'`. Optional. (Session arms the response watchdog.) */
	onUserTurnCompleted?(): void;
	/** A segment ended WITHOUT a completed user turn: resolved as `'ignored'`
	 *  (below min speech) or torn down via `resetSegment()` while active.
	 *  Optional. (Session aborts the retained in-progress segment and lets a
	 *  deferred watchdog replay re-evaluate — see
	 *  design-retained-user-content-recovery.md, R7a.) */
	onSegmentAborted?(): void;
}

/**
 * Client-side energy-VAD segment tracker, extracted from `VoiceSession`
 * (Step 2 of the modularization plan). It owns the `audioVad*` / `lastClientSpeech*`
 * state and the energy math; barge-in *policy* stays in the session via
 * `VadEvents.onVoicedFrame`. Construct with no `VoiceSession` reference — only
 * an events object, a logger, and an injectable clock (for deterministic tests).
 */
export class ClientVadDetector {
	private speechActive = false;
	private speechStartMs = 0;
	private lastVoiceMs = 0;
	private bargeInFired = false;
	private bargeInMissed = false;
	private eligible = false;
	private _lastSpeechCompletedMs = 0;
	private _lastSpeechDurationMs = 0;
	/** Reused per-frame energy result — keeps `process()` allocation-free. */
	private readonly energy: FrameEnergy = { maxAbs: 0, avgAbs: 0, samples: 0 };
	/** Monotonic per-session segment counter (structural contract, G4). */
	private _segmentId = 0;
	/** Reused terminal descriptor — one mutable record for ALL terminal
	 *  shapes; frame-driven (silence) terminals arm `takeTerminal()`, forced
	 *  paths return it directly and never arm (dual-track, §1). */
	private readonly _terminal: VadTerminalDescriptor = {
		segmentId: 0,
		outcome: 'completed',
		terminalCause: 'silence',
		startedAtMs: 0,
		firstVoicedAtMs: null,
		lastVoicedAtMs: null,
		resolvedAtMs: 0,
	};
	/** True between a silence terminal inside `process()` and `takeTerminal()`. */
	private _terminalPending = false;

	constructor(
		private readonly events: VadEvents,
		private readonly log: (msg: string) => void,
		private readonly clock: () => number = Date.now,
	) {}

	// --- Accessors used by the session's barge-in policy + completion arbiter ---
	get isSpeechActive(): boolean {
		return this.speechActive;
	}
	get isBargeInEligible(): boolean {
		return this.eligible;
	}
	get hasBargeInFired(): boolean {
		return this.bargeInFired;
	}
	/** True once a threshold-passing barge-in was detected but declined this segment. */
	get hasBargeInMissed(): boolean {
		return this.bargeInMissed;
	}
	get speechStartedAtMs(): number {
		return this.speechStartMs;
	}
	get lastSpeechCompletedMs(): number {
		return this._lastSpeechCompletedMs;
	}
	get lastSpeechDurationMs(): number {
		return this._lastSpeechDurationMs;
	}
	/** Monotonic segment identity — valid whenever a segment is open
	 *  (including trailing silence and up to a forced completion); null when
	 *  no segment is open. The ledger keys `SegmentEvidence` on it. */
	get activeSegmentId(): number | null {
		return this.speechActive ? this._segmentId : null;
	}

	/** Mark the current segment a *potential* barge-in (energy cleared the floor). */
	markBargeInEligible(): void {
		this.eligible = true;
	}
	/** Mark that the barge-in has fired for this segment (fires at most once). */
	markBargeInFired(): void {
		this.bargeInFired = true;
	}
	/** Mark that a threshold-passing barge-in was declined this segment (once). */
	markBargeInMissed(): void {
		this.bargeInMissed = true;
	}

	/** Process one inbound mic frame (PCM16). Mirrors the former
	 *  `updateClientAudioVad`: starts/maintains a segment, emits per-frame and
	 *  segment-boundary events, and auto-completes on sustained silence.
	 *  Returns the frame's `VAD_FRAME` bitflags (allocation-free) so the
	 *  router can track per-segment route admission. */
	process(data: Buffer): number {
		if (data.length < 2) return VAD_FRAME.NONE;
		analyzeFrameInto(data, this.energy);
		if (this.energy.samples === 0) return VAD_FRAME.NONE;

		const now = this.clock();
		const { maxAbs, avgAbs } = this.energy;
		const hasVoice = maxAbs >= CLIENT_VAD_PEAK_THRESHOLD || avgAbs >= CLIENT_VAD_AVG_ABS_THRESHOLD;

		if (hasVoice) {
			let flags: number = VAD_FRAME.VOICED;
			if (!this.speechActive) {
				flags |= VAD_FRAME.SEGMENT_STARTED;
				this.speechActive = true;
				this._segmentId++;
				this.speechStartMs = now;
				this.bargeInFired = false;
				this.bargeInMissed = false;
				this.eligible = false;
				this.log(
					`[Latency] User voice input started (client audio VAD; peak=${maxAbs}; avgAbs=${Math.round(avgAbs)})`,
				);
				this.events.onSpeechStart(maxAbs, avgAbs);
			}
			this.lastVoiceMs = now;
			this.events.onVoicedFrame(now, maxAbs, avgAbs);
			return flags;
		}

		if (
			this.speechActive &&
			this.lastVoiceMs > 0 &&
			now - this.lastVoiceMs >= CLIENT_VAD_SILENCE_MS
		) {
			// Frame-driven (silence) terminal: legacy callbacks fire synchronously
			// inside complete(); the ledger track is deferred behind the TERMINAL
			// flag so the router finishes routing this frame first (dual-track).
			if (this.complete('silence', now) !== null) {
				this._terminalPending = true;
				return VAD_FRAME.TERMINAL;
			}
		}
		return VAD_FRAME.NONE;
	}

	/** Consume the frame-driven terminal descriptor — valid exactly once after
	 *  a `TERMINAL`-flagged `process()` return. The record is reused; copy
	 *  what must outlive the next terminal. */
	takeTerminal(): VadTerminalDescriptor | null {
		if (!this._terminalPending) return null;
		this._terminalPending = false;
		return this._terminal;
	}

	/** End the in-progress segment (silence, or a provider-recognition signal).
	 *  Mirrors the former `completeClientAudioVad`: tears down the segment,
	 *  emits `onSegmentResolved` for any non-`'none'` outcome, and returns the
	 *  reused terminal descriptor (null when no segment was open). Forced
	 *  callers receive the descriptor directly and `takeTerminal()` stays
	 *  unarmed — only the frame-driven silence path arms it (dual-track). */
	complete(reason: string, now = this.clock()): VadTerminalDescriptor | null {
		if (!this.speechActive || this.lastVoiceMs <= 0) return null;
		const segmentId = this._segmentId;
		const startedAtMs = this.speechStartMs;
		const speechEndMs = this.lastVoiceMs;
		const speechDurationMs = Math.max(0, speechEndMs - this.speechStartMs);
		const silenceObservedMs = now - speechEndMs;
		this.speechActive = false;
		this.speechStartMs = 0;
		this.lastVoiceMs = 0;
		this.eligible = false;
		// The segment ended without a barge-in tearing the gate down — let the
		// session resolve a deferred completion (the former in-place VAD hook).
		this.events.onSegmentResolved();
		const ignored = speechDurationMs < CLIENT_VAD_MIN_SPEECH_MS;
		if (ignored) {
			this.log(
				`[Latency] User voice input ignored (client audio VAD; reason=${reason}; speechDuration=${speechDurationMs}ms; silenceObserved=${silenceObservedMs}ms; minSpeechDuration=${CLIENT_VAD_MIN_SPEECH_MS}ms)`,
			);
			this.events.onSegmentAborted?.();
		} else {
			this._lastSpeechCompletedMs = speechEndMs;
			this._lastSpeechDurationMs = speechDurationMs;
			this.log(
				`[Latency] User voice input completed (client audio VAD; reason=${reason}; speechDuration=${this._lastSpeechDurationMs}ms; silenceObserved=${silenceObservedMs}ms)`,
			);
			this.events.onUserTurnCompleted?.();
		}
		return this.fillTerminal(
			segmentId,
			ignored ? 'ignored' : 'completed',
			reason === 'silence' ? 'silence' : 'model-activity-forced',
			startedAtMs,
			startedAtMs,
			speechEndMs,
			now,
		);
	}

	/** Drop a stale segment (the forced VAD-defer cleanup path). Emits only
	 *  `onSegmentAborted` (when a segment was active) so retained-utterance
	 *  recovery can abort its in-progress segment; no other events fire.
	 *  Returns the aborted terminal descriptor (never arms `takeTerminal()`). */
	resetSegment(): VadTerminalDescriptor | null {
		const wasActive = this.speechActive;
		const segmentId = this._segmentId;
		const startedAtMs = this.speechStartMs;
		const lastVoiceMs = this.lastVoiceMs;
		this.speechActive = false;
		this.speechStartMs = 0;
		this.lastVoiceMs = 0;
		this.eligible = false;
		if (!wasActive) return null;
		this.events.onSegmentAborted?.();
		return this.fillTerminal(
			segmentId,
			'aborted',
			'forced-reset',
			startedAtMs,
			startedAtMs,
			lastVoiceMs > 0 ? lastVoiceMs : null,
			this.clock(),
		);
	}

	/** Write the reused terminal record (allocation-free). */
	private fillTerminal(
		segmentId: number,
		outcome: VadTerminalDescriptor['outcome'],
		terminalCause: VadTerminalDescriptor['terminalCause'],
		startedAtMs: number,
		firstVoicedAtMs: number | null,
		lastVoicedAtMs: number | null,
		resolvedAtMs: number,
	): VadTerminalDescriptor {
		const t = this._terminal;
		t.segmentId = segmentId;
		t.outcome = outcome;
		t.terminalCause = terminalCause;
		t.startedAtMs = startedAtMs;
		t.firstVoicedAtMs = firstVoicedAtMs;
		t.lastVoicedAtMs = lastVoicedAtMs;
		t.resolvedAtMs = resolvedAtMs;
		return t;
	}
}
