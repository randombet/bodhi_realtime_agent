// SPDX-License-Identifier: MIT

type Turn = { role: string; parts: Array<{ text: string }> };

/** Priority for notification delivery. */
export type QueuePriority = 'normal' | 'high';

/** Options for sendOrQueue. */
export interface SendOrQueueOptions {
	/** Delivery priority. 'high' attempts immediate delivery or front-of-queue. Default: 'normal'. */
	priority?: QueuePriority;
	/** Tool call ID for deduplication. If provided, prevents duplicate notifications for the same tool call. */
	toolCallId?: string;
}

/**
 * Queues background tool completion notifications when the LLM is actively
 * generating audio, and flushes them one-at-a-time at turn boundaries.
 *
 * Extracted from VoiceSession to isolate the queuing/delivery concern.
 * On transports without messageTruncation (Gemini), the model silently absorbs
 * client content while generating — notifications must be held until the model
 * finishes its current turn. On transports with messageTruncation (OpenAI),
 * high-priority messages can be delivered immediately (the transport handles
 * response cancellation internally).
 */
export class BackgroundNotificationQueue {
	private queue: Array<{ turns: Turn[]; turnComplete: boolean; priority: QueuePriority }> = [];
	private audioReceived = false;
	private interrupted = false;
	/** Track tool calls that have already been notified to prevent duplicates. */
	private sentNotifications = new Set<string>();

	constructor(
		private sendContent: (turns: Turn[], turnComplete: boolean) => void,
		private log: (msg: string) => void,
		private messageTruncation = false,
	) {}

	/**
	 * Send a notification immediately if the model is idle, or queue it if
	 * the model is currently generating audio.
	 *
	 * High-priority messages attempt immediate delivery when the transport
	 * supports message truncation (OpenAI). On non-truncation transports (Gemini),
	 * high-priority messages are queued at the front of the queue.
	 *
	 * Deduplication: If a toolCallId is provided and has already been notified,
	 * the notification is silently skipped to prevent race conditions where a
	 * background task completes synchronously before audio generation begins.
	 */
	sendOrQueue(turns: Turn[], turnComplete: boolean, options?: SendOrQueueOptions): void {
		const priority = options?.priority ?? 'normal';
		const toolCallId = options?.toolCallId;

		// Prevent duplicate notifications for the same tool call
		if (toolCallId && this.sentNotifications.has(toolCallId)) {
			this.log(`Skipping duplicate notification for tool call ${toolCallId}`);
			return;
		}

		// Mark as sent/queued to prevent duplicates
		if (toolCallId) {
			this.sentNotifications.add(toolCallId);
		}

		if (priority === 'high') {
			if (this.audioReceived && !this.messageTruncation) {
				// Can't interrupt (Gemini) — queue at front with high priority
				this.log('High-priority notification queued at front (transport cannot truncate)');
				this.queue.unshift({ turns, turnComplete, priority });
			} else {
				// Can interrupt (OpenAI) or session is idle — deliver immediately
				this.sendContent(turns, turnComplete);
			}
			return;
		}

		// Normal priority
		if (this.audioReceived) {
			this.log('LLM is generating — queuing background notification');
			this.queue.push({ turns, turnComplete, priority });
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
		this.sentNotifications.clear();
	}

	private flushOne(): void {
		const notification = this.queue.shift();
		if (notification) {
			this.log(`Flushing queued background notification (${this.queue.length} remaining)`);
			this.sendContent(notification.turns, notification.turnComplete);
		}
	}
}
