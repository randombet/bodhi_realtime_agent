// SPDX-License-Identifier: MIT

import type { ClientMessage } from '../types/audio.js';
import type { SessionConfig, SessionEndReason, SessionState } from '../types/session.js';
import { SessionError } from './errors.js';
import type { IEventBus } from './event-bus.js';
import type { HooksManager } from './hooks.js';

/** Legal state transitions — any unlisted transition throws SessionError. */
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
	CREATED: ['CONNECTING', 'CLOSED'],
	CONNECTING: ['ACTIVE', 'CLOSED'],
	ACTIVE: ['RECONNECTING', 'TRANSFERRING', 'CLOSED'],
	RECONNECTING: ['ACTIVE', 'CLOSED'],
	TRANSFERRING: ['ACTIVE', 'CLOSED'],
	CLOSED: [],
};

/**
 * Manages the session state machine and resumption handle.
 * Publishes state-change events to the EventBus and fires lifecycle hooks.
 * Also buffers client messages during disconnected states (RECONNECTING/TRANSFERRING).
 */
export class SessionManager {
	private _state: SessionState = 'CREATED';
	private _resumptionHandle: string | null = null;
	private _bufferedMessages: ClientMessage[] = [];
	private startedAt: number | null = null;
	/** Close-in-progress guard — set synchronously so re-entrant/duplicate closes no-op. */
	private _closing = false;
	/** Caller-supplied close reason, consumed by the CLOSED transition. */
	private _pendingReason: SessionEndReason | null = null;

	readonly sessionId: string;
	readonly userId: string;
	readonly initialAgent: string;

	constructor(
		config: SessionConfig,
		private eventBus: IEventBus,
		private hooks: HooksManager,
	) {
		this.sessionId = config.sessionId;
		this.userId = config.userId;
		this.initialAgent = config.initialAgent;
	}

	get state(): SessionState {
		return this._state;
	}

	get isActive(): boolean {
		return this._state === 'ACTIVE';
	}

	get isDisconnected(): boolean {
		return this._state === 'RECONNECTING' || this._state === 'TRANSFERRING';
	}

	get resumptionHandle(): string | null {
		return this._resumptionHandle;
	}

	transitionTo(newState: SessionState): void {
		const allowed = VALID_TRANSITIONS[this._state];
		if (!allowed.includes(newState)) {
			throw new SessionError(`Invalid transition: ${this._state} → ${newState}`, {
				severity: 'error',
			});
		}

		const fromState = this._state;
		this._state = newState;

		this.eventBus.publish('session.stateChange', {
			sessionId: this.sessionId,
			fromState,
			toState: newState,
		});

		if (newState === 'ACTIVE' && !this.startedAt) {
			this.startedAt = Date.now();
			if (this.hooks.onSessionStart) {
				this.hooks.onSessionStart({
					sessionId: this.sessionId,
					userId: this.userId,
					agentName: this.initialAgent,
				});
			}
			this.eventBus.publish('session.start', {
				sessionId: this.sessionId,
				userId: this.userId,
				agentName: this.initialAgent,
			});
		}

		if (newState === 'CLOSED') {
			const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
			// Prefer the caller-supplied reason (via closeWithReason); fall back to the
			// state-derived reason for legacy direct transitionTo('CLOSED') callers.
			const reason: SessionEndReason =
				this._pendingReason ?? (fromState === 'ACTIVE' ? 'normal' : fromState);
			if (this.hooks.onSessionEnd) {
				this.hooks.onSessionEnd({
					sessionId: this.sessionId,
					durationMs,
					reason,
				});
			}
			this.eventBus.publish('session.close', {
				sessionId: this.sessionId,
				reason,
			});
		}
	}

	/**
	 * The single reason-carrying entry point to CLOSED. Idempotent: the first call
	 * claims close (sets the guard, records the reason) and transitions; re-entrant
	 * or duplicate calls — including a raced reconnect/transfer-fail path — become
	 * no-ops, so `session.close` fires exactly once with the caller's reason.
	 */
	closeWithReason(reason: SessionEndReason): void {
		if (this._closing || this._state === 'CLOSED') return;
		this._closing = true;
		this._pendingReason = reason;
		this.transitionTo('CLOSED');
	}

	updateResumptionHandle(handle: string): void {
		this._resumptionHandle = handle;
		this.eventBus.publish('session.resume', {
			sessionId: this.sessionId,
			handle,
		});
	}

	/** Clear the cached resumption handle. Called when the transport reports
	 *  a non-resumable session update — keeping a stale handle would let a
	 *  later reconnect-with-state attempt a resume that loses data. */
	clearResumptionHandle(): void {
		this._resumptionHandle = null;
	}

	bufferMessage(message: ClientMessage): void {
		this._bufferedMessages.push(message);
	}

	drainBufferedMessages(): ClientMessage[] {
		const messages = this._bufferedMessages;
		this._bufferedMessages = [];
		return messages;
	}
}
