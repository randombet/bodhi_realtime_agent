// SPDX-License-Identifier: MIT

import { type FrameEnergy, analyzeFrameInto } from './audio-frame-analyzer.js';

/** Energy thresholds for the client-side VAD. Exported so the completion
 *  arbiter (still in `VoiceSession`) can reuse `CLIENT_VAD_SILENCE_MS`. */
export const CLIENT_VAD_SILENCE_MS = 500;
export const CLIENT_VAD_MIN_SPEECH_MS = 120;
export const CLIENT_VAD_PEAK_THRESHOLD = 1200;
export const CLIENT_VAD_AVG_ABS_THRESHOLD = 220;

/** Outcome of a completed speech segment. */
export type VadSegmentOutcome = 'completed' | 'ignored' | 'none';

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
	 *  segment-boundary events, and auto-completes on sustained silence. */
	process(data: Buffer): void {
		if (data.length < 2) return;
		analyzeFrameInto(data, this.energy);
		if (this.energy.samples === 0) return;

		const now = this.clock();
		const { maxAbs, avgAbs } = this.energy;
		const hasVoice = maxAbs >= CLIENT_VAD_PEAK_THRESHOLD || avgAbs >= CLIENT_VAD_AVG_ABS_THRESHOLD;

		if (hasVoice) {
			if (!this.speechActive) {
				this.speechActive = true;
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
			return;
		}

		if (
			this.speechActive &&
			this.lastVoiceMs > 0 &&
			now - this.lastVoiceMs >= CLIENT_VAD_SILENCE_MS
		) {
			this.complete('silence');
		}
	}

	/** End the in-progress segment (silence, or a provider-recognition signal).
	 *  Mirrors the former `completeClientAudioVad`: tears down the segment, emits
	 *  `onSegmentResolved` for any non-`'none'` outcome, and returns the outcome. */
	complete(reason: string, now = this.clock()): VadSegmentOutcome {
		if (!this.speechActive || this.lastVoiceMs <= 0) return 'none';
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
		if (speechDurationMs < CLIENT_VAD_MIN_SPEECH_MS) {
			this.log(
				`[Latency] User voice input ignored (client audio VAD; reason=${reason}; speechDuration=${speechDurationMs}ms; silenceObserved=${silenceObservedMs}ms; minSpeechDuration=${CLIENT_VAD_MIN_SPEECH_MS}ms)`,
			);
			return 'ignored';
		}
		this._lastSpeechCompletedMs = speechEndMs;
		this._lastSpeechDurationMs = speechDurationMs;
		this.log(
			`[Latency] User voice input completed (client audio VAD; reason=${reason}; speechDuration=${this._lastSpeechDurationMs}ms; silenceObserved=${silenceObservedMs}ms)`,
		);
		this.events.onUserTurnCompleted?.();
		return 'completed';
	}

	/** Drop a stale segment with no events (the forced VAD-defer cleanup path). */
	resetSegment(): void {
		this.speechActive = false;
		this.speechStartMs = 0;
		this.lastVoiceMs = 0;
		this.eligible = false;
	}
}
