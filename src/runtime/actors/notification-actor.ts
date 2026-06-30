/**
 * NotificationActor — actor-mode home of the background notification queue.
 *
 * Replaces the in-process `BackgroundNotificationQueue` (`src/core/`) for actor
 * mode. Producers send `notification.publish` to inject a synthetic user turn
 * into the live LLM; this actor handles priority, audio-received gating,
 * turn-complete flushing, dedup, label normalization, and label-filtered
 * fan-out to subscribers via `notification.delivered`.
 *
 * Audio bytes never enter this actor's mailbox. Only one once-per-turn
 * `notification.audio_started` control-plane message arrives from
 * `VoiceSession.handleAudioOutput` (debounced at the call site).
 *
 * See `dev_docs/framework/design-background-notification-actor.md` for the
 * full design — message contracts, lifecycle ownership matrix, decision
 * algorithm, label normalization, supervision policy.
 */

import { randomUUID } from 'node:crypto';
import type { Actor } from '../actor-runtime.js';
import type { ActorSendFn } from '../actor-send-fn.js';
import type { ActorId, Envelope } from '../envelope.js';
import type {
	NotificationClear,
	NotificationDelivered,
	NotificationFilter,
	NotificationPublish,
	NotificationSubscribe,
	NotificationUnsubscribe,
	RuntimeMessage,
} from '../messages.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Internal queue entry — raw label/text (wrapping into "[label]: text" happens at TransportActor). */
interface QueuedNotification {
	id: string;
	label: string;
	text: string;
	priority: 'normal' | 'high';
	turnComplete: boolean;
	dedupKey?: string;
	publishedAtMs: number;
	deliveredAtMs?: number;
	/** Carried from the publishing envelope; propagated unchanged onto the delivered envelope. */
	correlationId?: string;
}

/** Optional construction parameters. */
export interface NotificationActorOptions {
	/** Transport capability flag (`LLMTransport.capabilities.messageTruncation`). */
	messageTruncation: boolean;
	/** Optional debug logger. */
	log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Label normalization (security/safety)
// ---------------------------------------------------------------------------
//
// Two-step transform applied to every `notification.publish` label:
//   1. Uppercase + sanitize: locale-independent toUpperCase(), then keep only
//      [A-Z0-9 _-]. Drops `]`, `[`, newlines, non-ASCII (defense-in-depth
//      against prompt-injection through the bracketed wire form).
//   2. Truncate + fallback: cap at 32 chars; if empty after sanitize, fall
//      back to 'SYSTEM'.
//
// In-tree literal labels ('SYSTEM', 'SUBAGENT UPDATE', 'SUBAGENT QUESTION')
// pass through unchanged.

const LABEL_MAX = 32;
const LABEL_ALLOWED = /[A-Z0-9 _-]+/g;

export function normalizeLabel(input: string): string {
	const upper = input.toUpperCase();
	const matches = upper.match(LABEL_ALLOWED);
	const sanitized = matches ? matches.join('') : '';
	const truncated = sanitized.slice(0, LABEL_MAX);
	return truncated.length > 0 ? truncated : 'SYSTEM';
}

// ---------------------------------------------------------------------------
// Filter match
// ---------------------------------------------------------------------------

function matchesFilter(filter: NotificationFilter | undefined, n: QueuedNotification): boolean {
	if (!filter) return true;
	if (filter.labels !== undefined && !filter.labels.includes(n.label)) return false;
	if (filter.minPriority === 'high' && n.priority !== 'high') return false;
	return true;
}

// ---------------------------------------------------------------------------
// NotificationActor
// ---------------------------------------------------------------------------

export class NotificationActor implements Actor {
	readonly id: ActorId;

	// State (mailbox-serialized; only one onMessage runs at a time).
	private readonly messageTruncation: boolean;
	private audioReceived = false;
	private interrupted = false;
	private queue: QueuedNotification[] = [];
	private subscribers = new Map<ActorId, NotificationFilter | undefined>();

	private readonly log: (msg: string) => void;
	private readonly transportActorId: ActorId;

	constructor(
		id: ActorId,
		private sendMessage: ActorSendFn,
		options: NotificationActorOptions & { transportActorId?: ActorId },
	) {
		this.id = id;
		this.messageTruncation = options.messageTruncation;
		this.transportActorId = options.transportActorId ?? 'transport';
		this.log = options.log ?? (() => {});
	}

	async onMessage(envelope: Envelope): Promise<void> {
		const msg = envelope as Envelope<RuntimeMessage['type']>;

		switch (msg.type) {
			case 'notification.publish': {
				const payload = msg.payload as Omit<NotificationPublish, 'type'>;
				this.handlePublish(payload, envelope.correlationId);
				break;
			}
			case 'notification.subscribe': {
				const p = msg.payload as Omit<NotificationSubscribe, 'type'>;
				this.subscribers.set(p.subscriberId, p.filter);
				break;
			}
			case 'notification.unsubscribe': {
				const p = msg.payload as Omit<NotificationUnsubscribe, 'type'>;
				this.subscribers.delete(p.subscriberId);
				break;
			}
			case 'notification.audio_started': {
				this.audioReceived = true;
				break;
			}
			case 'notification.interrupted': {
				// Mirrors legacy markInterrupted: only sets `interrupted`. The paired
				// notification.reset_audio (sent first by TransportActor) clears
				// `audioReceived`. Together they match the legacy resetAudio() +
				// markInterrupted() call sequence in VoiceSession.handleInterrupted.
				this.interrupted = true;
				break;
			}
			case 'notification.turn_complete': {
				this.audioReceived = false;
				const wasInterrupted = this.interrupted;
				this.interrupted = false;
				if (!wasInterrupted) this.flushOne();
				break;
			}
			case 'notification.reset_audio': {
				// Pre-greeting / post-interrupt fresh-turn reset; queue is preserved.
				this.audioReceived = false;
				break;
			}
			case 'notification.clear': {
				const p = msg.payload as Omit<NotificationClear, 'type'>;
				this.log(`notification.clear (${p.reason}); ${this.queue.length} dropped`);
				this.queue = [];
				break;
			}
			default:
				// Unknown message type — ignore (dead-letter handled by runtime).
				break;
		}
	}

	async onStop(_reason: string): Promise<void> {
		this.queue = [];
		this.subscribers.clear();
	}

	// -- Internals -----------------------------------------------------------

	private handlePublish(p: Omit<NotificationPublish, 'type'>, correlationId?: string): void {
		const n: QueuedNotification = {
			id: p.id ?? randomUUID(),
			label: normalizeLabel(p.label),
			text: p.text,
			priority: p.priority ?? 'normal',
			turnComplete: p.turnComplete ?? true,
			dedupKey: p.dedupKey,
			publishedAtMs: Date.now(),
			correlationId,
		};

		// Dedup runs FIRST so the rule "entries with a matching dedupKey are
		// replaced" holds regardless of which delivery branch the new entry
		// takes (immediate vs queued).
		if (n.dedupKey) {
			const before = this.queue.length;
			this.queue = this.queue.filter((q) => q.dedupKey !== n.dedupKey);
			if (this.queue.length < before) {
				this.log(
					`dedup replaced ${before - this.queue.length} entry/entries with key=${n.dedupKey}`,
				);
			}
		}

		// Idle: deliver immediately.
		if (!this.audioReceived) {
			this.deliver(n);
			return;
		}

		// High-priority on truncation-capable transport (OpenAI): cancel-and-deliver.
		if (n.priority === 'high' && this.messageTruncation) {
			this.deliver(n);
			return;
		}

		// Audio-active: queue. High-priority goes to the front (Gemini).
		if (n.priority === 'high') {
			this.queue.unshift(n);
		} else {
			this.queue.push(n);
		}
	}

	private flushOne(): void {
		const n = this.queue.shift();
		if (n) this.deliver(n);
	}

	private deliver(n: QueuedNotification): void {
		// "Cancel-and-deliver" for high-priority notifications on truncation-capable
		// transports (OpenAI). The design's contract is: when messageTruncation is
		// true and a high-priority notification is delivered immediately while the
		// model is mid-utterance, the active response must be cancelled BEFORE the
		// new synthetic user turn lands. We send `transport.cancel_generation`
		// (the existing actor message handled by TransportActor's onMessage) so
		// the cancel is an explicit, traceable envelope in the observer + DLQ —
		// not a side-effect of the delivered handler reaching into the adapter
		// directly. The cancel is gated on audioReceived as well: there is no
		// active response to interrupt if the model is idle.
		if (n.priority === 'high' && this.messageTruncation && this.audioReceived) {
			this.sendMessage('transport.cancel_generation', {}, this.transportActorId, {
				correlationId: n.correlationId,
				from: this.id,
			});
		}

		n.deliveredAtMs = Date.now();
		const deferredMs = n.deliveredAtMs - n.publishedAtMs;
		const payload: Omit<NotificationDelivered, 'type'> = {
			id: n.id,
			label: n.label,
			text: n.text,
			priority: n.priority,
			turnComplete: n.turnComplete,
			publishedAtMs: n.publishedAtMs,
			deliveredAtMs: n.deliveredAtMs,
			deferredMs,
		};
		for (const [subscriberId, filter] of this.subscribers) {
			if (!matchesFilter(filter, n)) continue;
			this.sendMessage('notification.delivered', payload, subscriberId, {
				correlationId: n.correlationId,
				from: this.id,
			});
		}
	}
}
