// SPDX-License-Identifier: MIT

import type { IClientChannel } from '../types/session-client.js';
import type { LLMTransport, ReplayItem, RetainedUserTurn } from '../types/transport.js';
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
	/** Retained-utterance recovery (`watchdogReplayRecovery`): freshness-windowed,
	 *  non-consuming read of the last routed user utterance. `null`/absent when
	 *  the feature is off, nothing is retained, or it is stale. Optional. */
	peekRetainedUtterance?(): RetainedUserTurn | null;
	/** Energy check over drained reconnect-buffer PCM chunks ("did the user
	 *  speak during the reconnect window?"). Chunk presence is meaningless —
	 *  clients stream continuously, silence included. Optional. */
	detectSpeech?(chunks: Buffer[]): boolean;
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
	/** Retained-replay stage for the CURRENT stalled utterance (max one in-place
	 *  + one post-reconnect replay per sealed utterance — duplicate-context cap).
	 *  See design-retained-user-content-recovery.md. */
	private _replayStage: 'idle' | 'replayed-in-place' | 'replayed-after-reconnect' = 'idle';
	private _replayedUtteranceId: number | null = null;

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
			this.onResponseWatchdogFired();
		}, this.responseWatchdogMs);
	}

	/** Stall detected. STAGE 1: replay the retained utterance in-place on the
	 *  still-open connection (stalled sessions stay usable — investigation repro
	 *  1). STAGE 2 (escalation, also the path when stage 1 is impossible):
	 *  budgeted reconnect, then replay again. */
	private onResponseWatchdogFired(): void {
		const retained = this.deps.peekRetainedUtterance?.() ?? null;
		if (retained && this.stageFor(retained) === 'idle' && this.deps.transport.isConnected) {
			this._replayStage = 'replayed-in-place';
			if (this.tryReplay(retained, 'in-place')) {
				this.deps.log(
					`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — replayed retained user utterance in-place (no reconnect)`,
				);
				this.armResponseWatchdog(); // response window for the replay itself
				return;
			}
			// Transport can't replay (returned false / threw) → reconnect path.
		}
		this.deps.log(
			`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — forcing reconnect`,
		);
		this.triggerReconnect('response-watchdog', true);
	}

	/** Stage state belongs to ONE sealed utterance; reset when identity changes
	 *  (a new utterance sealed mid-recovery must start back at stage idle, and a
	 *  stale utterance must not inherit a fresh stage). */
	private stageFor(retained: RetainedUserTurn): typeof this._replayStage {
		if (this._replayedUtteranceId !== retained.utteranceId) {
			this._replayedUtteranceId = retained.utteranceId;
			this._replayStage = 'idle';
		}
		return this._replayStage;
	}

	/** Wired from correlated model activity (the stall resolved) and teardown. */
	resetReplayState(): void {
		this._replayStage = 'idle';
		this._replayedUtteranceId = null;
	}

	/** Best-effort: a throwing transport must not abort recovery (the
	 *  `elicitResponse` empty-`turns` SDK rejection is the cautionary precedent). */
	private tryReplay(retained: RetainedUserTurn, where: string): boolean {
		try {
			return this.deps.transport.replayUserTurn?.(retained) === true;
		} catch (e) {
			this.deps.log(
				`[Watchdog] Retained utterance replay failed ${where} (best-effort): ${(e as Error).message}`,
			);
			return false;
		}
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
						// Local mode: drained chunks are inbound mic PCM — energy-check
						// them ("fresh speech wins" — never replay an old utterance after
						// newer speech). Hosted mode drains nothing inbound by design.
						const drainedSpeechDetected =
							buffered.length > 0 && (this.deps.detectSpeech?.(buffered) ?? false);
						this.deps.sessionManager.transitionTo('ACTIVE');
						this.deps.log('Reconnect complete; session ACTIVE');
						if (elicit) this.recoverModelResponse(reason, drainedSpeechDetected);
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

	/** Post-reconnect recovery. STAGE 2: replay the retained utterance once on
	 *  the fresh session (skipped when the user spoke during the reconnect
	 *  window — that fresh speech, already drained to the transport, drives
	 *  recovery instead). Falls back to the content-less nudge (tier 3).
	 *  Agent mode only — never nudge a non-agent dictation/transcription turn. */
	private recoverModelResponse(reason: string, drainedSpeechDetected: boolean): void {
		if (!this.deps.isAgentMode()) return;
		if (drainedSpeechDetected) {
			this.deps.log('[Watchdog] Skipping retained replay — user spoke during reconnect');
			return; // server VAD handles the freshly drained speech as a normal turn
		}
		const retained = this.deps.peekRetainedUtterance?.() ?? null;
		if (
			reason === 'response-watchdog' &&
			retained &&
			this.stageFor(retained) !== 'replayed-after-reconnect' &&
			this.tryReplay(retained, 'after reconnect')
		) {
			this._replayStage = 'replayed-after-reconnect';
			this.deps.log('[Watchdog] Replayed retained user utterance after reconnect');
			this.armResponseWatchdog();
			return;
		}
		// Tier 3 — content-less nudge: prefer the transport's elicit (Gemini),
		// else fall back to triggerGeneration (OpenAI).
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
