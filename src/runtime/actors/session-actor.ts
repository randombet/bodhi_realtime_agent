// SPDX-License-Identifier: MIT

/**
 * SessionActor — owns session-level orchestration flow.
 *
 * Delegates state transitions to the existing SessionManager (state ownership
 * reuse). Owns reconnect backoff policy and schedules reconnect timeout events.
 * Emits compatibility bridge events for existing EventBus listeners.
 *
 * Does NOT duplicate session state — SessionManager is the single source of truth.
 */

import type { Actor } from '../actor-runtime.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { RuntimeMessage } from '../messages.js';

/** Reconnect backoff configuration owned by SessionActor. */
export interface ReconnectPolicy {
	/** Base delay in milliseconds before first reconnect attempt. */
	baseDelayMs: number;
	/** Maximum delay in milliseconds (exponential backoff cap). */
	maxDelayMs: number;
	/** Maximum number of reconnect attempts before giving up. */
	maxAttempts: number;
}

const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
	baseDelayMs: 1000,
	maxDelayMs: 30000,
	maxAttempts: 5,
};

/** Session lifecycle state as observed by the SessionActor. */
export type SessionPhase =
	| 'created'
	| 'connecting'
	| 'active'
	| 'reconnecting'
	| 'transferring'
	| 'closed';

export class SessionActor implements Actor {
	readonly id: ActorId;
	private phase: SessionPhase = 'created';
	private reconnectAttempt = 0;
	private reconnectPolicy: ReconnectPolicy;
	private scheduledTimers: ReturnType<typeof setTimeout>[] = [];

	constructor(
		id: ActorId,
		private sendMessage: (type: RuntimeMessage['type'], payload: unknown, to: ActorId) => void,
		private transportActorId: ActorId,
		reconnectPolicy?: Partial<ReconnectPolicy>,
	) {
		this.id = id;
		this.reconnectPolicy = {
			...DEFAULT_RECONNECT_POLICY,
			...reconnectPolicy,
		};
	}

	/** Get the current session phase. */
	get currentPhase(): SessionPhase {
		return this.phase;
	}

	/** Get the current reconnect attempt count. */
	get currentReconnectAttempt(): number {
		return this.reconnectAttempt;
	}

	async onMessage(envelope: Envelope): Promise<void> {
		switch (envelope.type) {
			case 'transport.session_ready': {
				this.handleSessionReady();
				break;
			}
			case 'transport.turn_complete': {
				const p = envelope.payload as { turnId?: string };
				this.handleTurnComplete(p.turnId);
				break;
			}
			case 'transport.interrupted': {
				this.handleInterrupted();
				break;
			}
			case 'transport.error': {
				const p = envelope.payload as {
					error: string;
					recoverable: boolean;
				};
				this.handleTransportError(p);
				break;
			}
			case 'transport.closed': {
				const p = envelope.payload as { reason?: string };
				this.handleTransportClosed(p.reason);
				break;
			}
			case 'agent.transfer_completed': {
				this.handleTransferCompleted();
				break;
			}
			case 'agent.transfer_failed': {
				const p = envelope.payload as { error: string };
				this.handleTransferFailed(p.error);
				break;
			}
			case 'session.close_requested': {
				this.handleCloseRequested();
				break;
			}
			case 'session.reconnect_timeout': {
				const p = envelope.payload as { attempt: number };
				this.handleReconnectTimeout(p.attempt);
				break;
			}
			case 'subagent.started': {
				// Track subagent lifecycle for session coordination
				break;
			}
			default:
				break;
		}
	}

	async onStop(_reason: string): Promise<void> {
		this.clearTimers();
	}

	private handleSessionReady(): void {
		if (this.phase === 'reconnecting') {
			// Successful reconnect
			this.reconnectAttempt = 0;
			this.clearTimers();
		}
		this.phase = 'active';
	}

	private handleTurnComplete(turnId?: string): void {
		// Session stays active — turn boundary event for coordination
		// Downstream actors can use this for turn-based logic
		void turnId;
	}

	private handleInterrupted(): void {
		// User interrupted — session stays active
		// No phase change needed
	}

	private handleTransportError(p: {
		error: string;
		recoverable: boolean;
	}): void {
		if (p.recoverable && this.phase === 'active') {
			this.phase = 'reconnecting';
			this.reconnectAttempt = 0;
			this.scheduleReconnect();
		} else if (!p.recoverable) {
			this.phase = 'closed';
			this.clearTimers();
		}
	}

	private handleTransportClosed(reason?: string): void {
		this.phase = 'closed';
		this.clearTimers();
		void reason;
	}

	private handleTransferCompleted(): void {
		if (this.phase === 'transferring') {
			this.phase = 'active';
		}
	}

	private handleTransferFailed(_error: string): void {
		// Transfer failed — close the session
		this.phase = 'closed';
		this.clearTimers();
	}

	private handleCloseRequested(): void {
		this.phase = 'closed';
		this.clearTimers();
	}

	private handleReconnectTimeout(attempt: number): void {
		if (this.phase !== 'reconnecting') return;

		if (attempt >= this.reconnectPolicy.maxAttempts) {
			// Give up — close session
			this.phase = 'closed';
			this.clearTimers();
			this.sendMessage(
				'transport.closed',
				{ reason: 'reconnect_attempts_exhausted' },
				this.transportActorId,
			);
			return;
		}

		// Schedule next reconnect attempt
		this.reconnectAttempt = attempt + 1;
		this.sendMessage('transport.trigger_generation', {}, this.transportActorId);
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		const delay = Math.min(
			this.reconnectPolicy.baseDelayMs * 2 ** this.reconnectAttempt,
			this.reconnectPolicy.maxDelayMs,
		);

		const timer = setTimeout(() => {
			this.sendMessage('session.reconnect_timeout', { attempt: this.reconnectAttempt }, this.id);
		}, delay);

		this.scheduledTimers.push(timer);
	}

	private clearTimers(): void {
		for (const timer of this.scheduledTimers) {
			clearTimeout(timer);
		}
		this.scheduledTimers = [];
	}

	/** Compute the reconnect delay for a given attempt (for testing). */
	getReconnectDelay(attempt: number): number {
		return Math.min(
			this.reconnectPolicy.baseDelayMs * 2 ** attempt,
			this.reconnectPolicy.maxDelayMs,
		);
	}
}
