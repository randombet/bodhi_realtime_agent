// SPDX-License-Identifier: MIT

type Turn = { role: string; parts: Array<{ text: string }> };

/**
 * Queues background tool completion notifications when Gemini is actively
 * generating audio, and flushes them one-at-a-time at turn boundaries.
 *
 * Extracted from VoiceSession to isolate the queuing/delivery concern.
 * Gemini silently absorbs client content while it is generating, so
 * notifications must be held until the model finishes its current turn.
 */
export class BackgroundNotificationQueue {
	private queue: Array<{ turns: Turn[]; turnComplete: boolean }> = [];
	private audioReceived = false;
	private interrupted = false;

	constructor(
		private sendContent: (turns: Turn[], turnComplete: boolean) => void,
		private log: (msg: string) => void,
	) {}

	/**
	 * Send a notification immediately if Gemini is idle, or queue it if
	 * the model is currently generating audio.
	 */
	sendOrQueue(turns: Turn[], turnComplete: boolean): void {
		if (this.audioReceived) {
			this.log('Gemini is generating — queuing background notification');
			this.queue.push({ turns, turnComplete });
		} else {
			this.sendContent(turns, turnComplete);
		}
	}

	/** Mark that the first audio chunk has been received this turn. */
	markAudioReceived(): void {
		this.audioReceived = true;
	}

	/** Mark that the current turn was interrupted by the user. */
	markInterrupted(): void {
		this.interrupted = true;
	}

	/**
	 * Handle turn completion: reset audio/interruption flags and flush one
	 * queued notification (unless the turn was interrupted).
	 */
	onTurnComplete(): void {
		this.audioReceived = false;
		const wasInterrupted = this.interrupted;
		this.interrupted = false;

		if (!wasInterrupted) {
			this.flushOne();
		}
	}

	/** Reset audio flag without flushing (used when starting a new greeting). */
	resetAudio(): void {
		this.audioReceived = false;
	}

	/** Drop all queued notifications (used on session close). */
	clear(): void {
		this.queue = [];
	}

	private flushOne(): void {
		const notification = this.queue.shift();
		if (notification) {
			this.log(`Flushing queued background notification (${this.queue.length} remaining)`);
			this.sendContent(notification.turns, notification.turnComplete);
		}
	}
}
