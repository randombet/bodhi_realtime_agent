// SPDX-License-Identifier: MIT

import type { BackgroundNotificationQueue } from './background-notification-queue.js';

/** Delivery priority for a published notification. */
export type NotificationPriority = 'normal' | 'high';

/**
 * Single seam over the framework's two notification back-ends — the legacy
 * in-process `BackgroundNotificationQueue` and the actor `NotificationActor`
 * (reached via `runtime.tell`). It funnels every `_isActorMode ? … : …`
 * notification branch in `VoiceSession` so later extractions depend only on this
 * interface, not the mode flag.
 *
 * See dev_docs/framework/investigation-voice-session-modularity.md (Step 1).
 */
export interface NotificationSink {
	/** The model began producing audio this turn. Debounced once-per-turn in
	 *  actor mode (audio chunks must stay off the actor mailbox per the audio
	 *  fast-path contract); a direct passthrough in legacy mode. */
	audioStarted(): void;
	/** Reset the audio gate at an interrupt, a turn boundary, or pre-greeting. */
	resetAudio(): void;
	/** A user interrupt occurred (suppresses the next flush). */
	interrupted(): void;
	/** A turn completed (clean or post-interrupt completion block). */
	turnComplete(): void;
	/** Publish a labelled background / subagent / system notification. */
	publish(label: string, text: string, priority: NotificationPriority): void;
}

/** Legacy in-process back-end: wraps `BackgroundNotificationQueue`. */
export class LegacyNotificationSink implements NotificationSink {
	constructor(private readonly queue: BackgroundNotificationQueue) {}

	audioStarted(): void {
		this.queue.markAudioReceived();
	}

	resetAudio(): void {
		this.queue.resetAudio();
	}

	interrupted(): void {
		this.queue.markInterrupted();
	}

	turnComplete(): void {
		this.queue.onTurnComplete();
	}

	publish(label: string, text: string, priority: NotificationPriority): void {
		this.queue.sendOrQueue([{ role: 'user', parts: [{ text: `[${label}]: ${text}` }] }], true, {
			priority,
		});
	}
}

/** Shape of `runtime.tell(type, payload, to)` used by the actor sink. */
export type NotificationTell = (type: string, payload: unknown, to: string) => void;

/**
 * Actor back-end: forwards to `NotificationActor` via `runtime.tell`. It also
 * owns the once-per-turn `audio_started` debounce that previously lived on
 * `VoiceSession._audioStartedThisTurn`; `resetAudio` and `turnComplete` clear the
 * debounce (the turn-boundary reset points), exactly as the prior inline code
 * did before each `notification.reset_audio` / `notification.turn_complete`.
 */
export class ActorNotificationSink implements NotificationSink {
	private audioStartedThisTurn = false;

	constructor(private readonly tell: NotificationTell) {}

	audioStarted(): void {
		if (this.audioStartedThisTurn) return;
		this.audioStartedThisTurn = true;
		this.tell('notification.audio_started', {}, 'notification');
	}

	resetAudio(): void {
		this.audioStartedThisTurn = false;
		this.tell('notification.reset_audio', {}, 'notification');
	}

	interrupted(): void {
		this.tell('notification.interrupted', {}, 'notification');
	}

	turnComplete(): void {
		this.audioStartedThisTurn = false;
		this.tell('notification.turn_complete', {}, 'notification');
	}

	publish(label: string, text: string, priority: NotificationPriority): void {
		this.tell('notification.publish', { label, text, priority }, 'notification');
	}
}
