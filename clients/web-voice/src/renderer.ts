/**
 * Playback-renderer strategy (plan step B4).
 *
 * Where assistant audio renders decides the playback-state protocol: the
 * plain PCM path schedules `playback.ended` after graph-drain + settle; an
 * avatar sink may render audio out-of-band and either acknowledge
 * immediately or not participate at all (the web client's real cases).
 * Getting this wrong sends premature or missing `playback.ended` and breaks
 * turn completion — so the decision is a capability object, not an if-chain.
 */

export interface PlaybackRenderer {
	/** True when binary assistant PCM should be fed to {@link playChunk}. */
	readonly rendersAssistantPcm: boolean;
	/** True when this renderer can participate in the audio.done →
	 *  playback.ended handshake. False ⇒ `audio.done` is ignored and the
	 *  server completes turns via its internal fallback timer. */
	readonly canSignalPlaybackEnded: boolean;
	/** Render one PCM chunk (only called when {@link rendersAssistantPcm}). */
	playChunk?(data: ArrayBuffer): void;
	/**
	 * Playback-state decision for a turn's `audio.done`:
	 * - `'defer'`  — acknowledge after local playback drains (+ settle delay);
	 * - `'ack-now'` — acknowledge immediately (renderer plays audio out-of-band
	 *   and cannot observe drain — the avatar immediate-ack case);
	 * - `'ignore'` — never acknowledge (server falls back to its timer).
	 */
	audioDoneDecision(): 'defer' | 'ack-now' | 'ignore';
	/** True while assistant audio is still audible (defer path only). */
	readonly playing: boolean;
	/** Register the drained callback (defer path only). */
	setOnAllPlaybackDrained(cb: (() => void) | null): void;
	/** Settle delay between drain and the acknowledgment. */
	settleDelayMs(): number;
	/** Hard-stop current playback (barge-in). */
	interrupt(): void;
	/** Turn boundary hook (optional bookkeeping). */
	onTurnEnd?(): void;
}

import type { PcmAudio } from './pcm-audio.js';

/** Default renderer: the WebSocket-PCM path backed by {@link PcmAudio}. */
export class PcmPlaybackRenderer implements PlaybackRenderer {
	readonly rendersAssistantPcm = true;
	readonly canSignalPlaybackEnded = true;

	constructor(private readonly audio: PcmAudio) {}

	playChunk(data: ArrayBuffer): void {
		this.audio.playChunk(data);
	}
	audioDoneDecision(): 'defer' {
		return 'defer';
	}
	get playing(): boolean {
		return this.audio.playing;
	}
	setOnAllPlaybackDrained(cb: (() => void) | null): void {
		this.audio.onAllSourcesEnded = cb;
	}
	settleDelayMs(): number {
		return this.audio.settleDelayMs();
	}
	interrupt(): void {
		this.audio.muteAndFlush();
		this.audio.unmute();
	}
}
