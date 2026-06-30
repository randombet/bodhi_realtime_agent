import { CLIENT_VAD_SILENCE_MS, type ClientVadDetector } from './client-vad-detector.js';
import type {
	ExternalTtsPlaybackGate,
	NativeAudioPlaybackGate,
	PlaybackGate,
} from './playback-gate.js';
import type { Turn } from './turn.js';

/** Margin (ms) added to the VAD-defer force-completion timeout. */
const VAD_DEFER_FORCE_MARGIN_MS = 50;

/** Collaborators for {@link PlaybackCompletionArbiter} — the active gate, the two
 *  concrete gates (for the completion finalize), the VAD detector, barge-in
 *  config, and the finalize callback. No `VoiceSession` reference. */
export interface PlaybackCompletionArbiterDeps {
	/** The session's active playback gate (TTS or native, else null). */
	getLiveGate: () => PlaybackGate | null;
	nativePlaybackGatingActive: boolean;
	getNativeGate: () => NativeAudioPlaybackGate | undefined;
	getTtsGate: () => ExternalTtsPlaybackGate | undefined;
	vad: ClientVadDetector;
	getBargeInConfig: () => { bargeInEnabled: boolean; bargeInConfirmMs: number };
	finalizeTurn: (turn: Turn | null, opts: { interrupted: boolean }) => void;
	log: (msg: string) => void;
}

/**
 * Playback-completion arbiter, extracted from `VoiceSession` (Step 6). The
 * meeting point of VAD policy, gate state, and turn finalization: it owns the
 * source-neutral playback-defer flag (the former `_ttsPlaybackEndedPending`) and
 * the `completePlayback` / `finishOrDeferForVad` / `forceCompleteAfterVadDefer`
 * routing. A post-synthesis turn completes unless a potential barge-in is in
 * progress, in which case completion is deferred until the VAD segment resolves
 * (a barge-in interrupts the turn; silence completes it via `resolveDeferredPlayback`).
 */
export class PlaybackCompletionArbiter {
	/** Non-null when a completion (the `playback.ended` signal or the fallback
	 *  timer) was deferred pending an in-progress potential barge-in. */
	private deferred: 'signal' | 'fallback' | null = null;

	constructor(private readonly d: PlaybackCompletionArbiterDeps) {}

	/** True while a completion is deferred (rejects a re-arming playback.ended). */
	get hasDeferred(): boolean {
		return this.deferred !== null;
	}

	/** Reset the defer flag (turn boundaries, interrupts, a new TTS request). */
	clearDefer(): void {
		this.deferred = null;
	}

	/** Finalize the post-synthesis turn — the native captured turn (clean), or
	 *  the external-TTS gate's audio-drained completion. */
	completePlayback(): void {
		const native = this.d.getNativeGate();
		if (this.d.nativePlaybackGatingActive && native?.pending) {
			// Finalize the turn captured when the gate armed, not whatever the
			// current turn is now.
			this.d.finalizeTurn(native.capturedTurn, { interrupted: false });
			return;
		}
		this.d.getTtsGate()?.completeAudio();
	}

	/**
	 * The single VAD-aware completion entry point — both the `playback.ended`
	 * signal and the fallback timer route through here. Completes unless a
	 * *potential barge-in* is in progress (active VAD segment, barge-in enabled,
	 * a frame past the in-TTS energy floor), in which case completion is deferred
	 * on the live gate's timer.
	 */
	finishOrDeferForVad(reason: 'signal' | 'fallback'): void {
		const cfg = this.d.getBargeInConfig();
		const potentialBargeIn =
			this.d.vad.isSpeechActive && cfg.bargeInEnabled && this.d.vad.isBargeInEligible;
		const gate = this.d.getLiveGate();
		gate?.clearTimer();
		if (potentialBargeIn) {
			this.deferred = reason;
			// Bounded defer — long enough for the barge-in to confirm even with a
			// high `bargeInConfirmMs`. The callback force-completes (no re-defer)
			// and resets the stale VAD segment.
			const deferMs =
				Math.max(CLIENT_VAD_SILENCE_MS, cfg.bargeInConfirmMs) + VAD_DEFER_FORCE_MARGIN_MS;
			gate?.armTimer(deferMs, () => this.forceCompleteAfterVadDefer());
			return;
		}
		this.d.log(`[Latency] turn complete via ${reason}`);
		this.completePlayback();
	}

	/** Force-complete a VAD-deferred turn whose segment never resolved (mic
	 *  frames stopped). Resets the stale VAD segment so it cannot leak forward. */
	private forceCompleteAfterVadDefer(): void {
		this.d.log(
			`[Latency] TTS turn complete via ${this.deferred ?? 'fallback'} (forced after VAD defer)`,
		);
		this.deferred = null;
		this.d.vad.resetSegment();
		this.completePlayback();
	}

	/**
	 * The detector's `onSegmentResolved` hook: a client speech segment ended
	 * without a barge-in tearing the gate down. If a completion was deferred for
	 * this potential barge-in, finish it now.
	 */
	resolveDeferredPlayback(): void {
		const gate = this.d.getLiveGate();
		if (this.deferred !== null && gate?.pending === true) {
			this.d.log(`[Latency] turn complete via ${this.deferred} (after VAD-resolution defer)`);
			this.deferred = null;
			gate.clearTimer();
			this.completePlayback();
		}
	}
}
