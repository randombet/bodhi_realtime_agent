import type { IClientChannel } from '../types/session-client.js';
import type { LLMTransport, ReplayItem, RetainedUserTurn } from '../types/transport.js';
import type { EventBus } from './event-bus.js';
import { decideOnGateReleased, decideOnWatchdogFire } from './policies/recovery.policy.js';
import type { SessionManager } from './session-manager.js';

/** Session-state surface the reconnector drives during recovery. */
export interface ReconnectSessionManager {
	readonly state: SessionManager['state'];
	readonly resumptionHandle: string | null;
	transitionTo(state: Parameters<SessionManager['transitionTo']>[0]): void;
	closeWithReason(reason: Parameters<SessionManager['closeWithReason']>[0]): Promise<void>;
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
	/** R7a mid-speech guard: true while the client VAD reports an in-progress
	 *  speech segment. A watchdog fire during live speech defers recovery (the
	 *  in-flight speech drives it) instead of replaying/reconnecting. Optional. */
	isSpeechActive?(): boolean;
	/** R7c hosted freshness verdict for the just-ended reconnect window, from
	 *  the session's input-side tee (captured before the `isSessionActive()`
	 *  drop): `'hosted-speech'` = user spoke (their speech was DROPPED — a
	 *  retained replay would be stale), `'none'` = frames flowed and none were
	 *  speech, `'unknown'` = no signal (zero frames seen — forwarding may have
	 *  stopped; unsafe to guess). Consulted only when the drain returned no
	 *  inbound chunks. Optional; absent → `'none'` (legacy behavior). */
	hostedReconnectSpeech?(): 'none' | 'hosted-speech' | 'unknown';
	/** R7c: a reconnect window opened (client channel began buffering) — the
	 *  session resets its reconnect-window freshness tee. Optional. */
	onReconnectWindowStart?(): void;
	/** R7b: a retained-utterance replay was successfully dispatched (stage 1 or
	 *  stage 2). The session promotes any pending input partial to a finalized
	 *  transcript — replay turns emit no input transcription of their own.
	 *  Never fires for deferred/failed replays or the content-less nudge.
	 *  Optional. */
	onReplayDispatched?(): void;
	/** Phase-3 coordinator seam: invoked BEFORE any recovery actuation
	 *  (in-place replay, post-reconnect replay, or nudge) so the greeting
	 *  token is invalidated first — a recovery response must never bind as
	 *  the greeting. */
	onRecoveryDispatch?(): void;
	/** H4 hold predicate — FULL-GREETING suppression ONLY (never the AEC
	 *  grace or pre-first-audio windows; see recovery.policy.ts). */
	isGreetingSuppressionArmed?(): boolean;
	/** H2 gate-aware drain: capture-tagged inbound frames are filtered
	 *  (gate-active discarded) and transform-sent by the SESSION; the
	 *  returned buffers are the ADMITTED frames only, so the drained-speech
	 *  verdict below cannot count gated greeting-period audio as fresh
	 *  speech. Fallback: the legacy raw stopBuffering drain. */
	drainBufferedInbound?(reason: 'reconnect' | 'goaway'): Buffer[];
	/** H2 drain-freshness: a candidate sealed before the latest drained
	 *  speech is not replayable at ANY stage (escalate instead). */
	isCandidateReplayEligible?(retained: RetainedUserTurn): boolean;
}

/** Reconnect-window speech verdict driving the stage-2 replay decision. */
export type ReconnectWindowSpeech = 'none' | 'local-drained-speech' | 'hosted-speech' | 'unknown';

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
	/** Absolute ceiling on watchdog deferral via `notifyProviderActivity`,
	 *  measured from the arm. Sized for Gemini's observed worst input-commit
	 *  latency (~7.5s from client-VAD end) with headroom. */
	private static readonly RESPONSE_WATCHDOG_ACTIVITY_CAP_MS = 15_000;

	/** Tracks consecutive reconnect attempts to prevent infinite reconnect storms. */
	private reconnectAttempts = 0;
	/** Pending response-watchdog timer (model-silence-after-user-turn). */
	private _responseWatchdogTimer?: ReturnType<typeof setTimeout>;
	/** When the current watchdog window was first armed — anchors the
	 *  `notifyProviderActivity` extension cap. */
	private _watchdogArmedAtMs?: number;
	/** Retained-replay stage for the CURRENT stalled utterance (max one in-place
	 *  + one post-reconnect replay per sealed utterance — duplicate-context cap).
	 *  See design-retained-user-content-recovery.md. */
	private _replayStage: 'idle' | 'replayed-in-place' | 'replayed-after-reconnect' = 'idle';
	private _replayedUtteranceId: number | null = null;
	/** R7a: a watchdog fire was deferred because the user was mid-speech. The
	 *  deferring speech's own completion re-arms the watchdog; if that segment
	 *  is instead aborted (ignored blip / forced reset), `notifySegmentAborted`
	 *  re-arms so recovery for the original retained utterance is not stranded. */
	private _replayDeferred = false;
	/** H4: a watchdog fire held behind full-greeting suppression. */
	private _heldGate = false;

	constructor(
		private readonly deps: TransportReconnectorDeps,
		/** Resolved watchdog timeout (ms); `<= 0` disables. */
		private readonly responseWatchdogMs: number,
	) {}

	/** Arm (or re-arm) the response watchdog after the user's turn ends. */
	armResponseWatchdog(): void {
		if (this.responseWatchdogMs <= 0) return;
		if (!this.deps.isAgentMode()) return; // never watch a non-agent (dictation/transcription) turn
		this._replayDeferred = false; // a new arm supersedes any deferred fire
		this._watchdogArmedAtMs = Date.now(); // liveness-extension cap anchor
		this.startWatchdogTimer(this.responseWatchdogMs);
	}

	private startWatchdogTimer(delayMs: number): void {
		this.disarmResponseWatchdog();
		// Safe to arm even if the session isn't ACTIVE right now: the fire-time
		// `state !== 'ACTIVE'` guard below makes a stale timer a no-op.
		this._responseWatchdogTimer = setTimeout(() => {
			this._responseWatchdogTimer = undefined;
			if (this.deps.sessionManager.state !== 'ACTIVE') return;
			this.onResponseWatchdogFired();
		}, delayMs);
	}

	/**
	 * The provider demonstrated it is actively working on the committed user
	 * turn (e.g. Gemini's streaming input transcription — deltas arrive seconds
	 * before the model's first output on slow turns). Extend the armed watchdog
	 * by a fresh budget so premature recovery does not cut off a response that
	 * is demonstrably coming, but never past an absolute cap measured from the
	 * original arm — a stuck transcription stream must not defer stall recovery
	 * forever. No-op when the watchdog is not armed.
	 */
	notifyProviderActivity(): void {
		if (!this._responseWatchdogTimer || this._watchdogArmedAtMs === undefined) return;
		const elapsed = Date.now() - this._watchdogArmedAtMs;
		const remainingCap = TransportReconnector.RESPONSE_WATCHDOG_ACTIVITY_CAP_MS - elapsed;
		if (remainingCap <= 0) return; // cap exhausted — let the pending timer fire
		this.startWatchdogTimer(Math.min(this.responseWatchdogMs, remainingCap));
	}

	/** Stall detected. STAGE 1: replay the retained utterance in-place on the
	 *  still-open connection (stalled sessions stay usable — investigation repro
	 *  1). STAGE 2 (escalation, also the path when stage 1 is impossible):
	 *  budgeted reconnect, then replay again. */
	private onResponseWatchdogFired(): void {
		// R7a mid-speech guard (stage 1 only — the only time the VAD can see live
		// speech): the in-flight utterance drives recovery; replaying or
		// reconnecting under the user would inject a stale turn or cut them off.
		// No re-arm here — re-arming would loop the timer through one long
		// utterance. The segment's own completion re-arms (onUserTurnCompleted),
		// and an aborted segment re-arms via notifySegmentAborted().
		const fireVerdict = decideOnWatchdogFire({
			speechActive: this.deps.isSpeechActive?.() === true,
			greetingSuppressionArmed: this.deps.isGreetingSuppressionArmed?.() === true,
		});
		if (fireVerdict === 'defer-speech') {
			this._replayDeferred = true;
			this.deps.log(
				`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — deferred (user speech in progress; no replay, no reconnect)`,
			);
			return;
		}
		if (fireVerdict === 'hold-gate') {
			// H4: recovery output must not land inside an open greeting turn.
			// Held — NOT cancelled: ambiguous model activity (the greeting's own
			// start) must not erase this; gate release re-evaluates.
			this._heldGate = true;
			this.deps.log(
				`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — HELD (greeting suppression armed; recovery resumes at gate release)`,
			);
			return;
		}
		const retained = this.deps.peekRetainedUtterance?.() ?? null;
		if (
			retained &&
			this.stageFor(retained) === 'idle' &&
			this.deps.transport.isConnected &&
			(this.deps.isCandidateReplayEligible?.(retained) ?? true)
		) {
			this._replayStage = 'replayed-in-place';
			this.deps.onRecoveryDispatch?.();
			if (this.tryReplay(retained, 'in-place')) {
				this.deps.log(
					`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — replayed retained user utterance in-place (no reconnect)`,
				);
				this.deps.onReplayDispatched?.(); // R7b: surface the replayed turn's transcript
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
		this._replayDeferred = false;
	}

	/** R7a: the VAD segment that deferred a watchdog fire was aborted (ignored
	 *  blip / forced reset) — it will never complete, so its completion can
	 *  never re-arm. Re-arm now for the ORIGINAL retained utterance; replay
	 *  stage state is intentionally unchanged. No-op without a deferred fire. */
	/** H4: is a recovery currently held behind the greeting gate? While held,
	 *  the session defers ambiguous-activity candidate clearing (held-state
	 *  override — see recovery.policy.ts). */
	isRecoveryHeld(): boolean {
		return this._heldGate;
	}

	/** H4: the greeting gate released — re-evaluate the held recovery with
	 *  FRESH facts (never a blind transition; the gate can hold for seconds). */
	onGreetingGateReleased(): void {
		if (!this._heldGate) return;
		this._heldGate = false;
		const verdict = decideOnGateReleased({
			speechActive: this.deps.isSpeechActive?.() === true,
			sessionActive: this.deps.sessionManager.state === 'ACTIVE',
		});
		if (verdict === 'idle') return;
		if (verdict === 'defer-speech') {
			this._replayDeferred = true;
			return;
		}
		this.onResponseWatchdogFired(); // full decision, fresh facts
	}

	/** Cancel a held recovery without running it: session teardown, or the
	 *  held candidate was superseded (direct input pre-emption releases the
	 *  greeting gate — the release must find nothing to fire). */
	cancelHeldRecovery(): void {
		this._heldGate = false;
	}

	notifySegmentAborted(): void {
		if (!this._replayDeferred) return;
		this.deps.log(
			'[Watchdog] Deferring speech segment aborted — re-arming for the retained utterance',
		);
		this.armResponseWatchdog(); // also clears _replayDeferred
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
			this.deps.onReconnectWindowStart?.();
			setTimeout(() => {
				this.deps.transport
					.reconnect({
						resumptionHandle: handle,
						conversationHistory: this.deps.toReplayContent(),
					})
					.then(() => {
						// H2 gate-aware drain: the session filters capture-tagged frames
						// (gate-active discarded) and transform-sends admitted ones;
						// the legacy raw path remains for harnesses without the dep.
						let buffered: Buffer[];
						if (this.deps.drainBufferedInbound) {
							buffered = this.deps.drainBufferedInbound('reconnect');
						} else {
							buffered = this.deps.clientTransport.stopBuffering();
							for (const chunk of buffered) {
								this.deps.transport.sendAudio(chunk.toString('base64'));
							}
						}
						// Reconnect-window speech verdict ("fresh speech wins" — never
						// replay an old utterance after newer speech). Local mode: drained
						// chunks are inbound mic PCM — energy-check them. Hosted mode
						// drains nothing inbound; the session's input-side tee supplies
						// the verdict (absent → 'none', the legacy behavior).
						const reconnectSpeech: ReconnectWindowSpeech =
							buffered.length > 0
								? (this.deps.detectSpeech?.(buffered) ?? false)
									? 'local-drained-speech'
									: 'none'
								: (this.deps.hostedReconnectSpeech?.() ?? 'none');
						this.deps.sessionManager.transitionTo('ACTIVE');
						this.deps.log('Reconnect complete; session ACTIVE');
						if (elicit) this.recoverModelResponse(reason, reconnectSpeech);
					})
					.catch((err) => {
						this.deps.clientTransport.stopBuffering();
						this.deps.reportError('reconnect', err);
						void this.deps.sessionManager.closeWithReason('reconnect_failed');
					});
			}, delay);
		} else {
			if (this.reconnectAttempts >= TransportReconnector.MAX_RECONNECT_ATTEMPTS) {
				this.deps.log(
					`Reconnect limit reached (${TransportReconnector.MAX_RECONNECT_ATTEMPTS} attempts), giving up`,
				);
			}
			void this.deps.sessionManager.closeWithReason('reconnect_failed');
		}
	}

	/** Post-reconnect recovery. STAGE 2: replay the retained utterance once on
	 *  the fresh session — but only when the reconnect-window speech verdict is
	 *  a proven `'none'` ("fresh speech wins", and unknown is unsafe to guess).
	 *  Falls back to the content-less nudge (tier 3). Agent mode only — never
	 *  nudge a non-agent dictation/transcription turn. */
	private recoverModelResponse(reason: string, reconnectSpeech: ReconnectWindowSpeech): void {
		if (!this.deps.isAgentMode()) return;
		if (reconnectSpeech === 'local-drained-speech') {
			this.deps.log('[Watchdog] Skipping retained replay — user spoke during reconnect');
			// The drained speech bypassed AudioRouter/VAD, so no completion will
			// arm a watchdog for it — re-arm here or a second stall on that fresh
			// speech has no timer left to recover it (R7c bookkeeping).
			this.armResponseWatchdog();
			return; // server VAD handles the freshly drained speech as a normal turn
		}
		if (reconnectSpeech === 'hosted-speech') {
			// The user's reconnect-window speech was dropped at the input gate —
			// answering the OLDER retained utterance now would be out of order.
			this.deps.log('[Watchdog] Skipping retained replay — hosted user spoke during reconnect');
			return;
		}
		if (reconnectSpeech === 'unknown') {
			this.deps.log('[Watchdog] Skipping retained replay — reconnect-window speech state unknown');
			return;
		}
		const retained = this.deps.peekRetainedUtterance?.() ?? null;
		const replayEligible =
			reason === 'response-watchdog' &&
			retained !== null &&
			this.stageFor(retained) !== 'replayed-after-reconnect' &&
			(this.deps.isCandidateReplayEligible?.(retained) ?? true);
		if (replayEligible) this.deps.onRecoveryDispatch?.();
		if (replayEligible && retained && this.tryReplay(retained, 'after reconnect')) {
			this._replayStage = 'replayed-after-reconnect';
			this.deps.log('[Watchdog] Replayed retained user utterance after reconnect');
			this.deps.onReplayDispatched?.(); // R7b: surface the replayed turn's transcript
			this.armResponseWatchdog();
			return;
		}
		// Tier 3 — content-less nudge, for transports that accept one. No in-tree
		// transport currently does (see `LLMTransport.elicitResponse`), so this
		// resolves to triggerGeneration: a `response.create` on OpenAI/Qwen, and a
		// no-op on Gemini, which auto-generates and rejects content-less requests.
		this.deps.log(`[Watchdog] Re-eliciting model response after reconnect (reason=${reason})`);
		this.deps.onRecoveryDispatch?.();
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
					if (this.deps.drainBufferedInbound) {
						this.deps.drainBufferedInbound('goaway');
					} else {
						const buffered = this.deps.clientTransport.stopBuffering();
						for (const chunk of buffered) {
							this.deps.transport.sendAudio(chunk.toString('base64'));
						}
					}
					this.deps.sessionManager.transitionTo('ACTIVE');
					this.deps.log('Reconnect complete; session ACTIVE');
				})
				.catch((err) => {
					this.deps.clientTransport.stopBuffering();
					this.deps.reportError('reconnect', err);
					void this.deps.sessionManager.closeWithReason('reconnect_failed');
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
