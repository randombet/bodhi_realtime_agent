// SPDX-License-Identifier: MIT

import type { ClientMessage } from '../types/audio.js';
import type { SessionConfig, SessionState } from '../types/session.js';
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
			if (this.hooks.onSessionEnd) {
				this.hooks.onSessionEnd({
					sessionId: this.sessionId,
					durationMs,
					reason: fromState === 'ACTIVE' ? 'normal' : fromState,
				});
			}
			this.eventBus.publish('session.close', {
				sessionId: this.sessionId,
				reason: fromState === 'ACTIVE' ? 'normal' : fromState,
			});
		}
	}

	updateResumptionHandle(handle: string): void {
		this._resumptionHandle = handle;
		this.eventBus.publish('session.resume', {
			sessionId: this.sessionId,
			handle,
		});
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
