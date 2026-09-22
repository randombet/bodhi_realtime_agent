/**
 * NotificationHooksObserverActor — built-in observability subscriber.
 *
 * Subscribes to NotificationActor with no filter (every label, every
 * priority) and fires `FrameworkHooks.onBackgroundNotification` for each
 * delivered notification. Constructed by `RuntimeOrchestrator` only when
 * the user actually configured a callback — zero-overhead when unattached.
 */

import type { Actor } from '../actor-runtime.js';
import type { ActorSendFn } from '../actor-send-fn.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { NotificationDelivered, RuntimeMessage } from '../messages.js';

/** Shape of the callback this actor invokes — matches `FrameworkHooks.onBackgroundNotification`. */
export type OnBackgroundNotificationCallback = (event: {
	sessionId: string;
	id: string;
	label: string;
	priority: 'normal' | 'high';
	publishedAtMs: number;
	deliveredAtMs: number;
	deferredMs: number;
	correlationId?: string;
}) => void;

export class NotificationHooksObserverActor implements Actor {
	readonly id: ActorId;

	constructor(
		id: ActorId,
		private sendMessage: ActorSendFn,
		private notificationActorId: ActorId,
		private callback: OnBackgroundNotificationCallback,
		private sessionId: string,
	) {
		this.id = id;
	}

	async onStart(): Promise<void> {
		// Subscribe to all labels (no filter).
		this.sendMessage('notification.subscribe', { subscriberId: this.id }, this.notificationActorId);
	}

	async onMessage(envelope: Envelope): Promise<void> {
		const msg = envelope as Envelope<RuntimeMessage['type']>;
		if (msg.type !== 'notification.delivered') return;
		const p = msg.payload as Omit<NotificationDelivered, 'type'>;
		try {
			this.callback({
				sessionId: this.sessionId,
				id: p.id,
				label: p.label,
				priority: p.priority,
				publishedAtMs: p.publishedAtMs,
				deliveredAtMs: p.deliveredAtMs,
				deferredMs: p.deferredMs,
				correlationId: envelope.correlationId,
			});
		} catch {
			// Consumer hook threw. Per supervision policy ('resume'), swallow
			// the error so a misbehaving handler does not kill the session.
		}
	}

	async onStop(_reason: string): Promise<void> {
		// Best-effort unsubscribe; if NotificationActor already stopped this
		// envelope dead-letters silently.
		this.sendMessage(
			'notification.unsubscribe',
			{ subscriberId: this.id },
			this.notificationActorId,
		);
	}
}
