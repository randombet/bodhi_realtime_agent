// SPDX-License-Identifier: MIT

/**
 * TransportActor — provider-agnostic control-plane actor for LLM transport.
 *
 * Converts inbound provider callbacks to canonical runtime messages and
 * dispatches outbound control commands to the transport.
 *
 * Also acts as the default subscriber to `notification.delivered` (the
 * single wire-out path for queue-routed text in actor mode): on each
 * delivered envelope it constructs the `[label]: text` synthetic user turn
 * and writes it via `adapter.sendContent`.
 *
 * **Scope guard:** This actor handles control signaling only. Raw audio chunk
 * bridging remains on the direct ClientTransport ↔ LLMTransport fast path.
 */

import type { Actor } from '../actor-runtime.js';
import type { ActorSendFn } from '../actor-send-fn.js';
import type { TransportAdapter } from '../adapters/transport-adapter.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { NotificationDelivered, NotificationFilter, RuntimeMessage } from '../messages.js';

/**
 * TransportActor wraps a TransportAdapter to participate in the actor runtime.
 *
 * Inbound: adapter fires callbacks → actor sends canonical messages to peers.
 * Outbound: actor receives canonical messages → adapter dispatches to transport.
 */
export class TransportActor implements Actor {
	readonly id: ActorId;

	constructor(
		id: ActorId,
		private adapter: TransportAdapter,
		private sendMessage: ActorSendFn,
		private sessionActorId: ActorId,
		private toolRouterActorId: ActorId,
		/** NotificationActor id; defaults to `'notification'`. */
		private notificationActorId: ActorId = 'notification',
		/**
		 * Optional filter for the subscription `notification.subscribe` envelope
		 * sent in `onStart`. Omit (or pass `undefined`) to receive every label;
		 * RuntimeOrchestrator forwards `OrchestratorConfig.notification?.transportSubscriptionFilter`.
		 */
		private transportSubscriptionFilter?: NotificationFilter,
	) {
		this.id = id;
	}

	async onStart(): Promise<void> {
		// Wire adapter callbacks to canonical message sends
		this.adapter.onSessionReady = () => {
			this.sendMessage('transport.session_ready', {}, this.sessionActorId);
		};

		this.adapter.onTurnComplete = (turnId?: string) => {
			// Drive SessionActor's phase machine. We do NOT mirror to
			// `notification.turn_complete` here — that signal must come from
			// the EFFECTIVE turn boundary (which defers when an external TTS
			// provider is mid-audio). VoiceSession.handleTurnCompleteInternal
			// owns the actor-mode `notification.turn_complete` send so the
			// gate matches the legacy queue's `onTurnComplete()` call site.
			this.sendMessage('transport.turn_complete', { turnId }, this.sessionActorId);
		};

		this.adapter.onInterrupted = () => {
			// Same rationale: VoiceSession.handleInterrupted is the effective
			// interrupt boundary (it also fires from the TTS speech-started
			// callback when the user barges in during TTS audio). It owns the
			// `notification.reset_audio` + `notification.interrupted` pair so
			// barge-in detection during TTS is covered.
			this.sendMessage('transport.interrupted', {}, this.sessionActorId);
		};

		this.adapter.onToolCallReceived = (calls) => {
			this.sendMessage('transport.tool_call_received', { calls }, this.toolRouterActorId);
		};

		this.adapter.onToolCallCancelled = (ids) => {
			this.sendMessage('transport.tool_call_cancelled', { ids }, this.toolRouterActorId);
		};

		this.adapter.onError = (error, recoverable) => {
			this.sendMessage('transport.error', { error, recoverable }, this.sessionActorId);
		};

		this.adapter.onClosed = (reason?: string) => {
			this.sendMessage('transport.closed', { reason }, this.sessionActorId);
		};

		// Subscribe to the single wire-out path for queue-routed synthetic
		// turns. Self-resubscribes on actor restart (this onStart re-runs).
		this.sendMessage(
			'notification.subscribe',
			{ subscriberId: this.id, filter: this.transportSubscriptionFilter },
			this.notificationActorId,
		);
	}

	async onMessage(envelope: Envelope): Promise<void> {
		const msg = envelope as Envelope<RuntimeMessage['type']>;

		switch (msg.type) {
			case 'transport.send_content': {
				const p = msg.payload as { content: unknown[]; turnComplete?: boolean };
				this.adapter.sendContent(p.content, p.turnComplete);
				break;
			}
			case 'transport.send_tool_result': {
				const p = msg.payload as {
					id: string;
					name: string;
					result: unknown;
					scheduling: string;
				};
				this.adapter.sendToolResult(p.id, p.name, p.result, p.scheduling);
				break;
			}
			case 'transport.transfer_session': {
				const p = msg.payload as { config: unknown; state: unknown };
				await this.adapter.transferSession(p.config, p.state);
				break;
			}
			case 'transport.cancel_generation': {
				this.adapter.cancelGeneration();
				break;
			}
			case 'transport.trigger_generation': {
				this.adapter.triggerGeneration();
				break;
			}
			case 'notification.delivered': {
				// Single wire-out path for queue-routed text in actor mode.
				// Wraps the producer-supplied label/text into `[label]: text` here
				// (centralized at the boundary, not at every emitter).
				//
				// "Cancel-and-deliver" semantics for high-priority on truncation-
				// capable transports are NOT implemented here — they are encoded
				// as a separate `transport.cancel_generation` envelope sent by
				// NotificationActor.deliver() *before* this notification.delivered.
				// That keeps the cancel visible as a first-class actor message
				// in observer/DLQ traces, and keeps this handler single-purpose:
				// format and write.
				const p = msg.payload as Omit<NotificationDelivered, 'type'>;
				this.adapter.sendContent(
					[{ role: 'user', parts: [{ text: `[${p.label}]: ${p.text}` }] }],
					p.turnComplete,
				);
				break;
			}
			default:
				// Unknown message type — ignore (dead-letter handled by runtime)
				break;
		}
	}

	async onStop(_reason: string): Promise<void> {
		// Best-effort unsubscribe; if NotificationActor already stopped, the
		// envelope dead-letters silently.
		this.sendMessage(
			'notification.unsubscribe',
			{ subscriberId: this.id },
			this.notificationActorId,
		);

		// Clear adapter callbacks
		this.adapter.onSessionReady = undefined;
		this.adapter.onTurnComplete = undefined;
		this.adapter.onInterrupted = undefined;
		this.adapter.onToolCallReceived = undefined;
		this.adapter.onToolCallCancelled = undefined;
		this.adapter.onError = undefined;
		this.adapter.onClosed = undefined;
	}
}
