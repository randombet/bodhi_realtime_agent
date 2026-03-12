// SPDX-License-Identifier: MIT

/**
 * TransportActor — provider-agnostic control-plane actor for LLM transport.
 *
 * Converts inbound provider callbacks to canonical runtime messages and
 * dispatches outbound control commands to the transport.
 *
 * **Scope guard:** This actor handles control signaling only. Raw audio chunk
 * bridging remains on the direct ClientTransport ↔ LLMTransport fast path.
 */

import type { Actor } from '../actor-runtime.js';
import type { TransportAdapter } from '../adapters/transport-adapter.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { RuntimeMessage } from '../messages.js';

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
		private sendMessage: (type: RuntimeMessage['type'], payload: unknown, to: ActorId) => void,
		private sessionActorId: ActorId,
		private toolRouterActorId: ActorId,
	) {
		this.id = id;
	}

	async onStart(): Promise<void> {
		// Wire adapter callbacks to canonical message sends
		this.adapter.onSessionReady = () => {
			this.sendMessage('transport.session_ready', {}, this.sessionActorId);
		};

		this.adapter.onTurnComplete = (turnId?: string) => {
			this.sendMessage('transport.turn_complete', { turnId }, this.sessionActorId);
		};

		this.adapter.onInterrupted = () => {
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
			default:
				// Unknown message type — ignore (dead-letter handled by runtime)
				break;
		}
	}

	async onStop(_reason: string): Promise<void> {
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
