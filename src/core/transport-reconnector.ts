import type { IClientChannel } from '../types/session-client.js';
import type { LLMTransport, ReplayItem, RetainedUserTurn } from '../types/transport.js';
import { DEFAULT_RECONNECT_DEADLINE_MS } from './constants.js';
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
	/** Synthetic-output hold predicate: while true, a watchdog fire is held
	 *  (never replayed, nudged or reconnected) until
	 *  {@link TransportReconnector.onSyntheticHoldReleased}. Optional. */
	isSyntheticHeld?(): boolean;
	/** What happens when automatic recovery cannot continue (budget spent, no
	 *  resumption handle, a failed or timed-out attempt): `'close'` closes the
	 *  session with `reconnect_failed` (the session's default); `'hold'` parks
	 *  it in UPSTREAM_LOST without finalization
	 *  ({@link TransportReconnector.parkUpstreamLost}). */
	upstreamLossPolicy: 'close' | 'hold';
	/** Host-owned recovery gate, consulted only under policy `'hold'`: while
	 *  it returns true, a transport close or watchdog stall parks the session
	 *  instead of starting an automatic dial, and it is checked again when the
	 *  backoff elapses. GoAway still resumes with the handle. Optional. */
	hostOwnsRecovery?(): boolean;
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

/** Test-only overrides; production constructs the reconnector without them. */
export interface TransportReconnectorOptions {
	/** Deadline for one reconnect attempt (ms); `<= 0` disables it. Defaults to
	 *  `DEFAULT_RECONNECT_DEADLINE_MS`. */
	reconnectDeadlineMs?: number;
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
 * Both dial through {@link runReconnect}, which bounds each attempt by a
 * session-level deadline, so the session can never stay in RECONNECTING.
 *
 * When automatic recovery cannot continue, `upstreamLossPolicy` decides: the
 * default `'close'` closes the session as described above, while `'hold'`
 * parks it in UPSTREAM_LOST ({@link parkUpstreamLost}) for the host to redial.
 * Under `'hold'` a host that owns recovery parks the session without an
 * automatic dial, and {@link beginHostRecovery} hands a running recovery over
 * to the host.
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
	/** Pending budgeted-reconnect backoff timer (the dial has not started yet). */
	private _backoffTimer?: ReturnType<typeof setTimeout>;
	/** Deadline timer of the in-flight automatic reconnect attempt. */
	private _deadlineTimer?: ReturnType<typeof setTimeout>;
	/** Automatic-attempt token. Each {@link runReconnect} captures a fresh value;
	 *  its resolution, rejection and deadline handlers act only while it is still
	 *  current, so an abandoned attempt (deadline, {@link dispose}) settling late
	 *  can never touch session state. */
	private _attemptToken = 0;
	/** True between a `transport.reconnect()` dispatch and its handling. */
	private _attemptInFlight = false;
	/** Set by dispose(): terminal, so a transport close or GoAway that arrives
	 *  while the owning session is finalizing can never start a new dial. */
	private _disposed = false;
	/** True while reconnect-window client buffering this reconnector started
	 *  is still open and still its own ({@link beginHostRecovery} hands it over). */
	private _clientBuffering = false;
	/** Session-level deadline per reconnect attempt (ms); `<= 0` disables. */
	private readonly reconnectDeadlineMs: number;
	private readonly upstreamLossPolicy: 'close' | 'hold';

	constructor(
		private readonly deps: TransportReconnectorDeps,
		/** Resolved watchdog timeout (ms); `<= 0` disables. */
		private readonly responseWatchdogMs: number,
		options?: TransportReconnectorOptions,
	) {
		this.reconnectDeadlineMs = options?.reconnectDeadlineMs ?? DEFAULT_RECONNECT_DEADLINE_MS;
		this.upstreamLossPolicy = deps.upstreamLossPolicy;
	}

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
		const fireFacts = {
			speechActive: this.deps.isSpeechActive?.() === true,
			greetingSuppressionArmed: this.deps.isGreetingSuppressionArmed?.() === true,
			syntheticHoldActive: this.deps.isSyntheticHeld?.() === true,
		};
		const fireVerdict = decideOnWatchdogFire(fireFacts);
		if (fireVerdict === 'defer-speech') {
			this._replayDeferred = true;
			this.deps.log(
				`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — deferred (user speech in progress; no replay, no reconnect)`,
			);
			return;
		}
		if (fireVerdict === 'hold-gate') {
			// H4: recovery output must not land inside an open greeting turn, nor
			// while the synthetic-output hold forbids autonomous output.
			// Held — NOT cancelled: ambiguous model activity (the greeting's own
			// start) must not erase this; the release re-evaluates.
			this._heldGate = true;
			this.deps.log(
				fireFacts.greetingSuppressionArmed
					? `[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — HELD (greeting suppression armed; recovery resumes at gate release)`
					: `[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — HELD (synthetic-output hold active; recovery resumes at hold release)`,
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
		this.reevaluateHeldRecovery();
	}

	/** The synthetic-output hold released — re-evaluate a watchdog fire it
	 *  held, exactly as a greeting-gate release does (a hold still armed on
	 *  the other side holds it again). No-op without a held recovery. */
	onSyntheticHoldReleased(): void {
		this.reevaluateHeldRecovery();
	}

	private reevaluateHeldRecovery(): void {
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

	/** Budgeted + backed-off reconnect entry (transport-close / watchdog).
	 *  `closeDetail` carries a transport close's code and reason into the
	 *  `session.upstreamLost` publication when this ends in a park. */
	triggerReconnect(
		reason: string,
		elicit = false,
		closeDetail?: { code?: number; reason?: string },
	): void {
		if (this._disposed) return;
		// Automatic recovery starts from ACTIVE only: a close during the first
		// dial is the failed connect that start() handles.
		if (this.deps.sessionManager.state !== 'ACTIVE') return;
		// The host owns recovery: park and leave the redial to it.
		if (this.isHostOwningRecovery()) {
			this.parkUpstreamLost('host-owns-recovery', closeDetail);
			return;
		}
		const handle = this.deps.sessionManager.resumptionHandle;
		if (handle && this.reconnectAttempts < TransportReconnector.MAX_RECONNECT_ATTEMPTS) {
			const attempt = this.reconnectAttempts++;
			const delay = TransportReconnector.RECONNECT_BACKOFF_MS[attempt] ?? 4000;
			this.deps.log(
				`Reconnect attempt ${attempt + 1}/${TransportReconnector.MAX_RECONNECT_ATTEMPTS} in ${delay}ms (reason=${reason})`,
			);
			this.deps.sessionManager.transitionTo('RECONNECTING');
			this.deps.clientTransport.startBuffering();
			this._clientBuffering = true;
			this.deps.onReconnectWindowStart?.();
			this._backoffTimer = setTimeout(() => {
				this._backoffTimer = undefined;
				// The session left RECONNECTING during the backoff (closed): no dial.
				if (this.deps.sessionManager.state !== 'RECONNECTING') return;
				// The host began owning recovery during the backoff: park, no dial.
				if (this.isHostOwningRecovery()) {
					this.parkUpstreamLost('host-owns-recovery', closeDetail);
					return;
				}
				this.runReconnect(reason, handle, { drainReason: 'reconnect', elicit });
			}, delay);
		} else {
			if (this.reconnectAttempts >= TransportReconnector.MAX_RECONNECT_ATTEMPTS) {
				this.deps.log(
					`Reconnect limit reached (${TransportReconnector.MAX_RECONNECT_ATTEMPTS} attempts), giving up`,
				);
			}
			this.giveUp(handle ? 'reconnect-exhausted' : 'no-resumption-handle', closeDetail);
		}
	}

	/** Exhaustion policy: automatic recovery cannot continue. Policy `'hold'`
	 *  parks the session in UPSTREAM_LOST; `'close'` closes it with
	 *  `reconnect_failed`, as before. */
	private giveUp(reason: string, detail?: { code?: number; reason?: string }): void {
		if (this.upstreamLossPolicy === 'hold') {
			this.parkUpstreamLost(reason, detail);
			return;
		}
		void this.deps.sessionManager.closeWithReason('reconnect_failed');
	}

	/** A dialed automatic attempt failed or timed out: report it, then apply
	 *  the exhaustion policy. Under `'close'` the client buffering ends through
	 *  `stopBuffering()` before the report, as before; under `'hold'` the park
	 *  drops it instead. */
	private failAttempt(reason: string, error: unknown): void {
		if (this.upstreamLossPolicy !== 'hold') {
			this._clientBuffering = false;
			this.deps.clientTransport.stopBuffering();
		}
		this.deps.reportError('reconnect', error as Error);
		this.giveUp(reason, { reason: error instanceof Error ? error.message : String(error) });
	}

	/** Host-owned recovery gate; inert under policy `'close'`, which never parks.
	 *  The gate is a host hook reached from transport callbacks and the backoff
	 *  timer, so a throw is logged and read as false: automatic recovery goes on. */
	private isHostOwningRecovery(): boolean {
		if (this.upstreamLossPolicy !== 'hold') return false;
		try {
			return this.deps.hostOwnsRecovery?.() === true;
		} catch (e) {
			this.deps.log(
				`Host recovery-ownership check threw (treated as not owning): ${e instanceof Error ? e.message : String(e)}`,
			);
			return false;
		}
	}

	/**
	 * Hand recovery over to the host. Cancels a pending backoff dial and
	 * advances the automatic-attempt token, so an automatic reconnect still in
	 * flight is superseded: its resolution, rejection and deadline handlers
	 * all no-op (no incumbent abort, no close, no activation) and its deadline
	 * timer is cleared. The reconnect-window client buffering, if open, becomes
	 * the caller's to end. The attempt budget is left for the caller to reset
	 * once its own dial activates.
	 */
	beginHostRecovery(): { cancelledPendingDial: boolean; wasBuffering: boolean } {
		const cancelledPendingDial = this.cancelBackoffDial();
		this._attemptToken++;
		this.settleAttempt();
		const wasBuffering = this._clientBuffering;
		this._clientBuffering = false;
		return { cancelledPendingDial, wasBuffering };
	}

	/**
	 * Park the session in UPSTREAM_LOST: no automatic dial follows, but
	 * nothing is finalized; only a host redial or a real close leaves the
	 * state. Self-contained: it cancels a pending backoff dial and strands an
	 * automatic attempt still in flight (aborting the transport incumbent, as
	 * {@link dispose} does, so a late dial cannot land on a parked session),
	 * drops reconnect-window client buffering this reconnector still owns,
	 * transitions, then publishes `session.upstreamLost`. `detail` is a
	 * transport close's code and reason, or an error text. Ignored once
	 * disposed and from states that cannot enter UPSTREAM_LOST (already
	 * parked, CLOSED, not started, transferring).
	 *
	 * A park from ACTIVE that no transport close caused (a watchdog stall
	 * the host owns, or one with no resumption handle) leaves the
	 * still-connected provider socket alone, exactly as the `'close'` policy
	 * leaves it to the session's close: the host's redial strands that
	 * incumbent, or `close()` disconnects it. While parked the session is not
	 * ACTIVE, so no microphone audio is routed to it.
	 */
	parkUpstreamLost(reason: string, detail?: { code?: number; reason?: string }): void {
		if (this._disposed) return;
		const state = this.deps.sessionManager.state;
		if (state !== 'CONNECTING' && state !== 'ACTIVE' && state !== 'RECONNECTING') {
			this.deps.log(`Upstream-lost park ignored (reason=${reason}) — session state is ${state}`);
			return;
		}
		this.cancelBackoffDial();
		if (this._attemptInFlight) this.abandonAttempt();
		this.discardClientBuffering();
		this.deps.sessionManager.transitionTo('UPSTREAM_LOST');
		this.deps.log(`Upstream lost (reason=${reason}) — session parked in UPSTREAM_LOST`);
		this.deps.eventBus.publish('session.upstreamLost', {
			sessionId: this.deps.getSessionId(),
			reason,
			...(detail?.code != null ? { code: detail.code } : {}),
			...(detail?.reason ? { detail: detail.reason } : {}),
		});
	}

	/** Cancel a pending backoff dial; true when one was pending. */
	private cancelBackoffDial(): boolean {
		if (!this._backoffTimer) return false;
		clearTimeout(this._backoffTimer);
		this._backoffTimer = undefined;
		return true;
	}

	/** Drop the reconnect-window client buffering this reconnector still owns,
	 *  forwarding nothing. A channel without `discardBuffered()` falls back to
	 *  `stopBuffering()` with a log: owned frames it returns are dropped here,
	 *  while a hosted channel flushes its own buffer to the client. */
	private discardClientBuffering(): void {
		if (!this._clientBuffering) return;
		this._clientBuffering = false;
		const channel = this.deps.clientTransport;
		if (channel.discardBuffered) {
			channel.discardBuffered();
			return;
		}
		this.deps.log(
			'Client channel has no discardBuffered(); ending reconnect buffering with stopBuffering()',
		);
		channel.stopBuffering();
	}

	/**
	 * One automatic reconnect attempt, shared by the budgeted path and GoAway:
	 * `transport.reconnect()` raced against the session-level deadline. The
	 * attempt's token is captured here; every handler below no-ops once it is no
	 * longer current. A result is applied only while the session is still
	 * RECONNECTING; a rejection closes with `reconnect_failed`; the deadline (like
	 * {@link dispose}) first aborts the transport incumbent, so the in-flight
	 * reconnect continuation cannot dial after CLOSED and a late dial result is
	 * closed rather than orphaned.
	 */
	private runReconnect(
		reason: string,
		handle: string,
		opts: { drainReason: 'reconnect' | 'goaway'; elicit: boolean },
	): void {
		const token = ++this._attemptToken;
		this._attemptInFlight = true;
		const deadlineMs = this.reconnectDeadlineMs;
		if (deadlineMs > 0) {
			this._deadlineTimer = setTimeout(() => {
				this._deadlineTimer = undefined;
				if (token !== this._attemptToken) return;
				this.abandonAttempt();
				this.failAttempt(
					'reconnect-timeout',
					new Error(`Reconnect timed out after ${deadlineMs}ms`),
				);
			}, deadlineMs);
		}
		this.deps.transport
			.reconnect({
				resumptionHandle: handle,
				conversationHistory: this.deps.toReplayContent(),
			})
			.then(() => {
				if (token !== this._attemptToken) return;
				this.settleAttempt();
				this._clientBuffering = false; // both branches below end it
				const state = this.deps.sessionManager.state;
				if (state !== 'RECONNECTING') {
					// Closed while the reconnect was in flight: never re-activate a
					// terminal session; just release the client buffer.
					this.deps.clientTransport.stopBuffering();
					this.deps.log(`Reconnect completed but session is ${state} — result ignored`);
					return;
				}
				// H2 gate-aware drain: the session filters capture-tagged frames
				// (gate-active discarded) and transform-sends admitted ones;
				// the legacy raw path remains for harnesses without the dep.
				let buffered: Buffer[];
				if (this.deps.drainBufferedInbound) {
					buffered = this.deps.drainBufferedInbound(opts.drainReason);
				} else {
					buffered = this.deps.clientTransport.stopBuffering();
					for (const chunk of buffered) {
						this.deps.transport.sendAudio(chunk.toString('base64'));
					}
				}
				// Only the eliciting (watchdog) path consults the speech verdict.
				const reconnectSpeech = opts.elicit ? this.reconnectWindowSpeech(buffered) : null;
				this.deps.sessionManager.transitionTo('ACTIVE');
				this.deps.log('Reconnect complete; session ACTIVE');
				if (reconnectSpeech) this.recoverModelResponse(reason, reconnectSpeech);
			})
			.catch((err) => {
				if (token !== this._attemptToken) return;
				this.settleAttempt();
				this.failAttempt('reconnect-failed', err);
			});
	}

	/** Reconnect-window speech verdict ("fresh speech wins" — never replay an old
	 *  utterance after newer speech). Local mode: drained chunks are inbound mic
	 *  PCM — energy-check them. Hosted mode drains nothing inbound; the session's
	 *  input-side tee supplies the verdict (absent → 'none', the legacy behavior). */
	private reconnectWindowSpeech(buffered: Buffer[]): ReconnectWindowSpeech {
		if (buffered.length > 0) {
			return (this.deps.detectSpeech?.(buffered) ?? false) ? 'local-drained-speech' : 'none';
		}
		return this.deps.hostedReconnectSpeech?.() ?? 'none';
	}

	/** The in-flight attempt was handled: clear its deadline. */
	private settleAttempt(): void {
		this._attemptInFlight = false;
		if (this._deadlineTimer) {
			clearTimeout(this._deadlineTimer);
			this._deadlineTimer = undefined;
		}
	}

	/** Strand the in-flight attempt (its late settlement becomes a no-op) and
	 *  abort the transport incumbent, so the reconnect continuation cannot dial
	 *  and a late-resolving dial closes its own session. */
	private abandonAttempt(): void {
		this._attemptToken++;
		this.settleAttempt();
		void this.deps.transport.abortIncumbent?.();
	}

	/** Session teardown: strand an in-flight reconnect (aborting the transport
	 *  incumbent) and cancel its deadline, cancel a pending backoff dial, disarm
	 *  the watchdog and drop a held recovery. Idempotent. */
	dispose(): void {
		this._disposed = true;
		if (this._attemptInFlight) this.abandonAttempt();
		if (this._backoffTimer) {
			clearTimeout(this._backoffTimer);
			this._backoffTimer = undefined;
		}
		this.disarmResponseWatchdog();
		this.cancelHeldRecovery();
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
		this.triggerReconnect('transport-close', false, { code, reason });
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

		if (this._disposed) return;
		// Only an ACTIVE session reconnects on GoAway. A late GoAway from a
		// connection that a close or an earlier reconnect already tore down must
		// not throw an invalid-transition SessionError out of the transport
		// callback, and one arriving during the first dial must not take the
		// CONNECTING → RECONNECTING edge, which only a host recovery uses.
		const state = this.deps.sessionManager.state;
		if (state !== 'ACTIVE') {
			this.deps.log(`GoAway ignored — session state is ${state}, not ACTIVE`);
			return;
		}

		// Initiate reconnection
		const handle = this.deps.sessionManager.resumptionHandle;
		if (handle) {
			this.deps.sessionManager.transitionTo('RECONNECTING');
			this.deps.clientTransport.startBuffering();
			this._clientBuffering = true;
			this.runReconnect('goaway', handle, { drainReason: 'goaway', elicit: false });
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
