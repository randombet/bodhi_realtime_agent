// SPDX-License-Identifier: MIT

import type { PostSessionPipeline, PostSessionSnapshotBuilder } from '../post-session/types.js';
import type { ClientMessage } from '../types/audio.js';
import type { SessionConfig, SessionEndReason, SessionState } from '../types/session.js';
import { SessionError } from './errors.js';
import type { IEventBus } from './event-bus.js';
import type { HooksManager } from './hooks.js';

/** Optional post-session wiring: a process-scoped pipeline + drain preference. */
export interface SessionPostProcessing {
	readonly pipeline: PostSessionPipeline;
	/** When true, closeWithReason awaits the run report before resolving (drain mode). */
	readonly drain?: boolean;
}

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
	/** Pre-close finalizers, run (awaited, all-settled) before `session.close` publishes. */
	private _finalizers: Array<() => void | Promise<void>> = [];
	/** Memoized close completion, so repeated closeWithReason() calls share one promise. */
	private _closePromise: Promise<void> | null = null;
	/** Per-session snapshot builder used at dispatch time (phase 4 of close). */
	private _snapshotBuilder: PostSessionSnapshotBuilder | null = null;

	readonly sessionId: string;
	readonly userId: string;
	readonly initialAgent: string;

	constructor(
		config: SessionConfig,
		private eventBus: IEventBus,
		private hooks: HooksManager,
		/** Optional post-session pipeline. When absent, close behaves exactly as before. */
		private postSession?: SessionPostProcessing,
	) {
		this.sessionId = config.sessionId;
		this.userId = config.userId;
		this.initialAgent = config.initialAgent;
	}

	/** Millisecond timestamp of first ACTIVE, or null if never activated. */
	get startedAtMs(): number | null {
		return this.startedAt;
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
				// Isolated: a throwing hook must not abort the lifecycle transition.
				try {
					this.hooks.onSessionStart({
						sessionId: this.sessionId,
						userId: this.userId,
						agentName: this.initialAgent,
					});
				} catch (error) {
					console.error('[SessionManager] onSessionStart hook threw:', error);
				}
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
				// Isolated: a throwing hook must not prevent session.close from publishing
				// (which would skip all post-session work).
				try {
					this.hooks.onSessionEnd({
						sessionId: this.sessionId,
						durationMs,
						reason,
					});
				} catch (error) {
					console.error('[SessionManager] onSessionEnd hook threw:', error);
				}
			}
			this.eventBus.publish('session.close', {
				sessionId: this.sessionId,
				reason,
			});
		}
	}

	/**
	 * Register a finalizer to run (awaited, all-settled) before `session.close`
	 * publishes — transcript flush, turn finalize, snapshot-capture of
	 * soon-to-be-disposed state. A throwing finalizer is logged, never blocks close.
	 * Must be registered before close.
	 */
	registerPreCloseFinalizer(fn: () => void | Promise<void>): void {
		this._finalizers.push(fn);
	}

	/**
	 * Register the per-session snapshot builder dispatched in phase 4 of close.
	 * Register once, before the session goes active. No-op effect unless a
	 * post-session pipeline was provided to the constructor.
	 */
	registerSnapshotBuilder(build: PostSessionSnapshotBuilder): void {
		this._snapshotBuilder = build;
	}

	/**
	 * The single reason-carrying entry point to CLOSED. Idempotent: the first call
	 * claims close (sets the guard, records the reason); re-entrant or duplicate
	 * calls — including a raced reconnect/transfer-fail path — return the same
	 * promise, so `session.close` fires exactly once with the caller's reason.
	 *
	 * Phases: (1) claim, (2) run pre-close finalizers (awaited, all-settled),
	 * (3) transitionTo CLOSED (fires onSessionEnd + publishes session.close),
	 * (4) dispatch the post-session pipeline (drain mode awaits its report).
	 *
	 * Fast path (no finalizers): phases 3–4 run synchronously, preserving legacy
	 * close timing (dispatch returns a handle synchronously).
	 */
	closeWithReason(reason: SessionEndReason): Promise<void> {
		if (this._closing || this._state === 'CLOSED') {
			return this._closePromise ?? Promise.resolve();
		}
		this._closing = true;
		this._pendingReason = reason;
		if (this._finalizers.length === 0) {
			this.transitionTo('CLOSED');
			this._closePromise = this.dispatchPostSession(reason);
			return this._closePromise;
		}
		this._closePromise = (async () => {
			await this.runFinalizers();
			this.transitionTo('CLOSED');
			await this.dispatchPostSession(reason);
		})();
		return this._closePromise;
	}

	private async runFinalizers(): Promise<void> {
		// Wrap each in an async thunk so a synchronous throw becomes a rejection
		// that allSettled captures (rather than escaping the map).
		const results = await Promise.allSettled(this._finalizers.map(async (fn) => fn()));
		for (const r of results) {
			if (r.status === 'rejected') {
				console.error('[SessionManager] pre-close finalizer threw:', r.reason);
			}
		}
	}

	/** Phase 4: dispatch the post-session pipeline (if wired). Drain awaits the report. */
	private dispatchPostSession(reason: SessionEndReason): Promise<void> {
		if (!this.postSession || !this._snapshotBuilder) return Promise.resolve();
		const run = this.postSession.pipeline.dispatch({
			sessionId: this.sessionId,
			reason,
			build: this._snapshotBuilder,
		});
		return this.postSession.drain ? run.report.then(() => undefined) : Promise.resolve();
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
