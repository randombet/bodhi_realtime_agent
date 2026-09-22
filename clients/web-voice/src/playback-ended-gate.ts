/**
 * The audio.done → drain → settle → playback.ended handshake, standalone
 * (plan step D3). `VoiceClient` uses it internally; apps that own their
 * socket drive it directly from their handlers so the
 * protocol's subtlest ordering lives in exactly one place:
 *
 * - acknowledge only after the server marked the turn's audio done AND the
 *   renderer drained AND one settle delay passed (OS output buffer + a mic
 *   capture quantum);
 * - a connection generation defuses stale settle timers across reconnects;
 * - `clear()` at turn/session boundaries forgets the outstanding id.
 */

import type { PlaybackRenderer } from './renderer.js';

export class PlaybackEndedGate {
	private audioDonePlaybackId: number | null = null;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
	private generation = 0;

	constructor(
		private readonly renderer: PlaybackRenderer,
		/** Send the acknowledgment; return false when the socket is gone (the
		 *  pending id is dropped either way). */
		private readonly sendPlaybackEnded: (playbackId: number) => void,
	) {
		this.renderer.setOnAllPlaybackDrained(() => this.maybeSchedule(this.generation));
	}

	/** New connection: stale settle timers from prior generations become no-ops. */
	newGeneration(): void {
		this.generation += 1;
		this.clear();
	}

	/** The server marked a turn's audio done. Applies the renderer's
	 *  capability decision (defer / ack-now / ignore). */
	audioDone(playbackId: number): void {
		if (!this.renderer.canSignalPlaybackEnded) return;
		const decision = this.renderer.audioDoneDecision();
		if (decision === 'ignore') return;
		if (decision === 'ack-now') {
			this.sendPlaybackEnded(playbackId);
			return;
		}
		this.audioDonePlaybackId = playbackId;
		this.maybeSchedule(this.generation);
	}

	/** Cancel any pending settle timer and forget the outstanding audio.done.
	 *  Call at turn boundaries (turn.end, turn.interrupted, session.config). */
	clear(): void {
		if (this.settleTimer !== null) {
			clearTimeout(this.settleTimer);
			this.settleTimer = null;
		}
		this.audioDonePlaybackId = null;
	}

	private maybeSchedule(gen: number): void {
		if (this.settleTimer !== null) return;
		if (this.audioDonePlaybackId === null) return;
		if (this.renderer.playing) return;
		const playbackId = this.audioDonePlaybackId;
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			if (gen !== this.generation) return; // stale timer from a prior connection
			// Audio resumed during the settle wait — a later drain reschedules.
			if (this.renderer.playing) return;
			if (this.audioDonePlaybackId !== playbackId) return;
			this.sendPlaybackEnded(playbackId);
			this.audioDonePlaybackId = null;
		}, this.renderer.settleDelayMs());
	}
}
