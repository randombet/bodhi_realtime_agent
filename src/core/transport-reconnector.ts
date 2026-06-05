// SPDX-License-Identifier: MIT

import type { IClientChannel } from '../types/session-client.js';
import type { LLMTransport, ReplayItem } from '../types/transport.js';
import type { EventBus } from './event-bus.js';
import type { SessionManager } from './session-manager.js';

/** Session-state surface the reconnector drives during recovery. */
export interface ReconnectSessionManager {
	readonly state: SessionManager['state'];
	readonly resumptionHandle: string | null;
	transitionTo(state: Parameters<SessionManager['transitionTo']>[0]): void;
	updateResumptionHandle(handle: string): void;
	clearResumptionHandle(): void;
}

/**
 * Collaborators the {@link TransportReconnector} reaches back into on the
 * session. Thunks/getters carry values mutable at runtime or constructed after
 * the reconnector (`getSessionId`, `isAgentMode`); direct callbacks carry
 * actions (`reportError`, `log`). The transport / clientTransport /
 * sessionManager / eventBus references are stable after construction.
 */
export interface TransportReconnectorDeps {
	sessionManager: ReconnectSessionManager;
	clientTransport: IClientChannel;
	transport: LLMTransport;
	/** Conversation replay content for reconnect-with-state. */
	toReplayContent(): ReplayItem[];
	eventBus: EventBus;
	/** The session id (used in the `session.goaway` publish). */
	getSessionId(): string;
	/** True only in agent mode — gates watchdog arming and the post-reconnect
	 *  nudge (never watch/nudge a non-agent dictation/transcription turn). */
	isAgentMode(): boolean;
	reportError(context: string, error: Error): void;
	log(message: string): void;
}

/**
 * Owns the transport reconnect path and the response-watchdog liveness timer as
 * one cohesive unit. Two reconnect triggers share this unit but NOT the same
 * policy:
 *
 *  - {@link triggerReconnect} (transport-close / watchdog) is **budgeted** and
 *    **backed-off**: it consumes the shared {@link reconnectAttempts} budget,
 *    waits a backoff delay, and CLOSEs the session when the budget or
 *    resumption handle is exhausted.
 *  - {@link handleGoAway} reconnects **immediately** with the resumption handle
 *    — no budget, no backoff — because Gemini's GoAway is a graceful,
 *    handle-bearing migration signal, not an error.
 *
 * The watchdog's sole job is to force a {@link triggerReconnect} when the model
 * goes silent after the user's turn ends, so it lives here too.
 *
 * `VoiceSession` keeps thin `handleTransportClose` / `handleGoAway` delegators
 * (a test invokes the private `handleTransportClose`) and rewires every
 * model-activity {@link disarmResponseWatchdog} call site to this unit.
 */
export class TransportReconnector {
	private static readonly MAX_RECONNECT_ATTEMPTS = 3;
	private static readonly RECONNECT_BACKOFF_MS = [1000, 2000, 4000];

	/** Tracks consecutive reconnect attempts to prevent infinite reconnect storms. */
	private reconnectAttempts = 0;
	/** Pending response-watchdog timer (model-silence-after-user-turn). */
	private _responseWatchdogTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly deps: TransportReconnectorDeps,
		/** Resolved watchdog timeout (ms); `<= 0` disables. */
		private readonly responseWatchdogMs: number,
	) {}

	/** Arm (or re-arm) the response watchdog after the user's turn ends. */
	armResponseWatchdog(): void {
		if (this.responseWatchdogMs <= 0) return;
		if (!this.deps.isAgentMode()) return; // never watch a non-agent (dictation/transcription) turn
		this.disarmResponseWatchdog();
		// Safe to arm even if the session isn't ACTIVE right now: the fire-time
		// `state !== 'ACTIVE'` guard below makes a stale timer a no-op.
		this._responseWatchdogTimer = setTimeout(() => {
			this._responseWatchdogTimer = undefined;
			if (this.deps.sessionManager.state !== 'ACTIVE') return;
			this.deps.log(
				`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — forcing reconnect`,
			);
			this.triggerReconnect('response-watchdog', true);
		}, this.responseWatchdogMs);
	}

	/** Cancel the response watchdog (model showed activity, or teardown). */
	disarmResponseWatchdog(): void {
		if (this._responseWatchdogTimer) {
			clearTimeout(this._responseWatchdogTimer);
			this._responseWatchdogTimer = undefined;
		}
	}

	/** Reset the shared reconnect budget — called on a healthy turn completion. */
	resetAttempts(): void {
		this.reconnectAttempts = 0;
	}

	/** Budgeted + backed-off reconnect entry (transport-close / watchdog). */
	triggerReconnect(reason: string, elicit = false): void {
		if (this.deps.sessionManager.state !== 'ACTIVE') return;
		const handle = this.deps.sessionManager.resumptionHandle;
		if (handle && this.reconnectAttempts < TransportReconnector.MAX_RECONNECT_ATTEMPTS) {
			const attempt = this.reconnectAttempts++;
			const delay = TransportReconnector.RECONNECT_BACKOFF_MS[attempt] ?? 4000;
			this.deps.log(
				`Reconnect attempt ${attempt + 1}/${TransportReconnector.MAX_RECONNECT_ATTEMPTS} in ${delay}ms (reason=${reason})`,
			);
			this.deps.sessionManager.transitionTo('RECONNECTING');
			this.deps.clientTransport.startBuffering();
			setTimeout(() => {
				this.deps.transport
					.reconnect({
						resumptionHandle: handle,
						conversationHistory: this.deps.toReplayContent(),
					})
					.then(() => {
						const buffered = this.deps.clientTransport.stopBuffering();
						for (const chunk of buffered) {
							this.deps.transport.sendAudio(chunk.toString('base64'));
						}
						this.deps.sessionManager.transitionTo('ACTIVE');
						this.deps.log('Reconnect complete; session ACTIVE');
						if (elicit) this.elicitModelResponse(reason);
					})
					.catch((err) => {
						this.deps.clientTransport.stopBuffering();
						this.deps.reportError('reconnect', err);
						this.deps.sessionManager.transitionTo('CLOSED');
					});
			}, delay);
		} else {
			if (this.reconnectAttempts >= TransportReconnector.MAX_RECONNECT_ATTEMPTS) {
				this.deps.log(
					`Reconnect limit reached (${TransportReconnector.MAX_RECONNECT_ATTEMPTS} attempts), giving up`,
				);
			}
			this.deps.sessionManager.transitionTo('CLOSED');
		}
	}

	/** Best-effort post-reconnect generation nudge: prefer the transport's
	 *  content-less elicit (Gemini), else fall back to triggerGeneration (OpenAI).
	 *  Agent mode only — never nudge while in transcription/dictation mode. */
	private elicitModelResponse(reason: string): void {
		if (!this.deps.isAgentMode()) return;
		this.deps.log(`[Watchdog] Re-eliciting model response after reconnect (reason=${reason})`);
		try {
			if (this.deps.transport.elicitResponse) {
				this.deps.transport.elicitResponse();
			} else {
				this.deps.transport.triggerGeneration();
			}
		} catch (e) {
			this.deps.log(`[Watchdog] Re-elicit nudge failed (best-effort): ${(e as Error).message}`);
		}
	}

	handleTransportClose(code?: number, reason?: string): void {
		const detail = code != null ? ` code=${code}${reason ? ` reason="${reason}"` : ''}` : '';
		this.deps.log(`Transport closed (state=${this.deps.sessionManager.state}${detail})`);
		this.triggerReconnect('transport-close');
	}

	/** Gemini GoAway — reconnect IMMEDIATELY with the resumption handle, outside
	 *  the budgeted/backed-off `triggerReconnect` path. */
	handleGoAway(timeLeft: string): void {
		this.disarmResponseWatchdog();
		this.deps.log(`GoAway from Gemini (timeLeft=${timeLeft})`);
		this.deps.eventBus.publish('session.goaway', {
			sessionId: this.deps.getSessionId(),
			timeLeft,
		});

		// Initiate reconnection
		const handle = this.deps.sessionManager.resumptionHandle;
		if (handle) {
			this.deps.sessionManager.transitionTo('RECONNECTING');
			this.deps.clientTransport.startBuffering();

			this.deps.transport
				.reconnect({
					resumptionHandle: handle,
					conversationHistory: this.deps.toReplayContent(),
				})
				.then(() => {
					const buffered = this.deps.clientTransport.stopBuffering();
					for (const chunk of buffered) {
						this.deps.transport.sendAudio(chunk.toString('base64'));
					}
					this.deps.sessionManager.transitionTo('ACTIVE');
					this.deps.log('Reconnect complete; session ACTIVE');
				})
				.catch((err) => {
					this.deps.clientTransport.stopBuffering();
					this.deps.reportError('reconnect', err);
					this.deps.sessionManager.transitionTo('CLOSED');
				});
		}
	}

	handleResumptionUpdate(handle: string, resumable: boolean): void {
		// On resumable updates, cache the handle so a later reconnect can resume.
		// On non-resumable updates, CLEAR the cache so reconnect-with-state
		// cannot attempt a resume from a stale handle (Google's docs warn that
		// resuming after non-resumable can lose data — fresh-session-with-replay
		// is safer; the GeminiLiveTransport applies the same policy internally).
		if (resumable) {
			this.deps.sessionManager.updateResumptionHandle(handle);
		} else {
			this.deps.sessionManager.clearResumptionHandle();
		}
	}
}
