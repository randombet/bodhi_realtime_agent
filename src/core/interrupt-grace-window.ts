/**
 * Time-bounded suppression window armed on the session's first assistant
 * audio chunk. While active, `VoiceSession`:
 *   1. Drops user-driven interrupt actuation via `requestInterrupt(source)`.
 *   2. Drops outbound mic frames at `transport.sendAudio` (and the STT
 *      provider) inside `routeAudioToAgent`.
 *
 * The goal is to give browser AEC (WebRTC AEC3) enough time to converge on
 * its speaker-to-mic transfer function before the framework treats
 * echo-driven `speech_started` events as a real barge-in. AEC convergence
 * is one-shot per audio context (a fresh tab / direct_rtc reconnect), so
 * the window is per-session and re-armable on client reconnect.
 *
 * The class is logging-agnostic: `VoiceSession.requestInterrupt(source)`
 * wraps `isActive()` and emits the suppression log through the session's
 * own log channel.
 *
 * See dev_docs/framework/design-greeting-interrupt-grace.md §4, §6.
 */
export class InterruptGraceWindow {
	private _until = 0;
	private _firstAudioConsumed = false;

	constructor(
		/** Effective grace window length (ms). `0` disables the window
		 *  entirely — `onAudioStart()` is a no-op and `isActive()` is always
		 *  `false`. */
		private readonly windowMs: number,
		/** Wall-clock provider. Injectable for tests so the window's
		 *  expiry can be advanced deterministically without `vi.useFakeTimers`. */
		private readonly clock: () => number = Date.now,
	) {}

	/** Call on every assistant-audio chunk (native or external TTS). Arms
	 *  the window on the FIRST chunk (per `reset()` cycle); subsequent calls
	 *  are no-ops. Idempotent — safe to call once per chunk without a
	 *  separate "first chunk" tracker on the caller. */
	onAudioStart(): void {
		if (this._firstAudioConsumed || this.windowMs <= 0) return;
		this._until = this.clock() + this.windowMs;
		this._firstAudioConsumed = true;
	}

	/** True while the grace is suppressing interrupts AND outbound mic
	 *  frames. Falls back to `false` once the configured `windowMs` has
	 *  elapsed past the arming clock. */
	isActive(): boolean {
		return this._until > 0 && this.clock() < this._until;
	}

	/** Remaining ms before the window expires (0 once expired or never
	 *  armed). Caller-facing only — used by `requestInterrupt` to include
	 *  the remainder in its suppression log. */
	remainingMs(): number {
		return Math.max(0, this._until - this.clock());
	}

	/** Reset on client reconnect: drops both the deadline and the
	 *  first-audio-consumed flag in one shot. The next `onAudioStart()`
	 *  call re-arms the window. */
	reset(): void {
		this._until = 0;
		this._firstAudioConsumed = false;
	}
}
