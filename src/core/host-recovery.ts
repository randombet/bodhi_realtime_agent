import type { IClientChannel } from '../types/session-client.js';
import type { SessionState } from '../types/session.js';
import type { LLMTransport } from '../types/transport.js';
import { SessionError } from './errors.js';
import type { EventBus } from './event-bus.js';
import type { TransportReconnector } from './transport-reconnector.js';

/**
 * Host upstream recovery: the public recovery surface (capability
 * descriptor, `recoverUpstream` arguments and result), the controller that
 * runs a recovery, the synthetic-output hold and the dial-generation fence.
 * The package index exports only `RECOVERY_CAPABILITIES` and the three
 * recovery types; the classes and the origin union stay internal.
 */

/**
 * Versioned descriptor of the host recovery surface a session supports. A
 * host gates its recovery on `VoiceSession.getRecoveryCapabilities()`, which
 * reports what this session can do, never on {@link RECOVERY_CAPABILITIES}
 * or on method presence.
 */
export interface RecoveryCapabilities {
	version: 1;
	/** `recoverUpstream()` can redial this session. */
	recoverUpstream: boolean;
	/** Each recovery publishes one `session.reconnectBoundary`. */
	reconnectBoundary: boolean;
	/** `turn.start` is published once per turn. */
	turnStartPublication: boolean;
	/** The transport reports its dial and post-setup generation counters, so
	 *  `attemptEpoch` and `turn.start` can be correlated. */
	transportGenerations: boolean;
	/** `holdSyntheticUntilFreshSpeech` and `isSyntheticHoldActive()` work. */
	syntheticHold: boolean;
}

/** The full descriptor: what a legacy-orchestration session with
 *  `upstreamLossPolicy: 'hold'` and the native Gemini transport supports. */
export const RECOVERY_CAPABILITIES: RecoveryCapabilities = Object.freeze({
	version: 1,
	recoverUpstream: true,
	reconnectBoundary: true,
	turnStartPublication: true,
	transportGenerations: true,
	syntheticHold: true,
});

/** Arguments of `VoiceSession.recoverUpstream()`. */
export interface RecoverUpstreamArgs {
	reason: 'active-silence' | 'human-retry' | 'fatal-backoff-clear';
	/** `false` injects the recent conversation as quiet context once the
	 *  replacement connection is active; `true` injects nothing. */
	skipContextInjection: boolean;
	/** Hold synthetic output (greeting, directives, notifications, injected
	 *  context) until the user is heard again. */
	holdSyntheticUntilFreshSpeech: boolean;
}

/** What `VoiceSession.recoverUpstream()` returns, complete at return time. */
export interface RecoverUpstreamResult {
	/** The DIAL generation the replacement connection dials on: the domain of
	 *  `turn.start.attemptEpoch` and of the lifecycle `att_<n>` attempt id.
	 *  Not `turn.start.transportGeneration`, the post-setup counter, which is
	 *  legitimately lower (the dial counter also advances on failed and
	 *  aborted dials). A `turn.start` carrying a lower `attemptEpoch` belongs
	 *  to an earlier connection. */
	attemptEpoch: number;
	/** Resolves once the replacement connection is ACTIVE; rejects when the
	 *  dial or another recovery step fails (the session is then parked in
	 *  UPSTREAM_LOST) or the session closes or is parked first. */
	activated: Promise<void>;
	/** Close of the abandoned connection: bounded, never rejects. */
	incumbentClosed: Promise<'closed' | 'forced'>;
}

/** What produced a synthetic (not user-initiated) send. A log label only. */
export type SyntheticHoldOrigin =
	| 'greeting'
	| 'greeting-memory'
	| 'directive-reinforcement'
	| 'client-reconnect-context'
	| 'gemini-reconnect-context'
	| 'divergence-correction'
	| 'assistant-initiated'
	| 'host-inject'
	| 'watchdog-replay'
	| 'watchdog-nudge';

/** Fresh user evidence that releases the fresh-speech hold. Raw microphone
 *  PCM (client-VAD energy) is not evidence and never releases it. */
export type SyntheticHoldReleaseSource =
	| 'input-transcription'
	| 'external-stt-final'
	| 'provider-interrupted'
	| 'typed-input';

/** Collaborators the {@link SyntheticOutputHold} reaches back into. */
export interface SyntheticOutputHoldDeps {
	/** Hold (`true`) or release (`false`) background-notification delivery. */
	setNotificationsHeld(held: boolean): void;
	/** Deliver one queued notification if the model is idle. Called when a
	 *  dial window releases the notification hold, since a released queue
	 *  otherwise waits for the next turn completion before delivering. */
	drainNotifications(): void;
	log(message: string): void;
}

/**
 * The gate every framework-generated ("synthetic") send passes through:
 * greeting, directive reinforcement, guarded generation triggers and
 * hold-respecting injections. Two independent holds close it:
 *
 * - the fresh-speech hold ({@link engage}): after a host recovery that asks
 *   for it, nothing synthetic is sent until the user is heard again
 *   ({@link release});
 * - the dial window ({@link engageDialWindow}): a transient hold while no
 *   connection can carry output, from the moment a recovery strands the old
 *   connection (or the session parks in UPSTREAM_LOST) until a replacement
 *   activates ({@link releaseDialWindow}).
 *
 * Either one also holds background-notification delivery; the notifications
 * are released only once neither remains.
 */
export class SyntheticOutputHold {
	private freshSpeechHold = false;
	private dialWindow = false;
	private readonly releaseListeners = new Set<() => void>();

	constructor(private readonly deps: SyntheticOutputHoldDeps) {}

	/** Whether the fresh-speech hold is engaged. The dial window is not
	 *  reported here: it is part of an in-flight recovery, not a hold the
	 *  host can observe. */
	isActive(): boolean {
		return this.freshSpeechHold;
	}

	/** Hold synthetic output and notifications until fresh user evidence. */
	engage(): void {
		this.deps.setNotificationsHeld(true);
		this.freshSpeechHold = true;
	}

	/**
	 * Fresh user evidence arrived. Releases the fresh-speech hold, and the
	 * notification hold unless a dial window still holds it, then notifies the
	 * {@link onRelease} listeners. Returns `true` when a hold was released,
	 * `false` when none was engaged (a no-op).
	 */
	release(source: SyntheticHoldReleaseSource): boolean {
		if (!this.freshSpeechHold) return false;
		this.freshSpeechHold = false;
		if (!this.dialWindow) this.deps.setNotificationsHeld(false);
		this.deps.log(`Synthetic output hold released by fresh user evidence (${source})`);
		for (const listener of [...this.releaseListeners]) listener();
		return true;
	}

	/** Open the dial window: synthetic output and notifications are held
	 *  until {@link releaseDialWindow}. */
	engageDialWindow(): void {
		this.deps.setNotificationsHeld(true);
		this.dialWindow = true;
	}

	/** Close the dial window. When no fresh-speech hold remains, release the
	 *  notification hold and run one notification drain. */
	releaseDialWindow(): void {
		if (!this.dialWindow) return;
		this.dialWindow = false;
		if (this.freshSpeechHold) return;
		this.deps.setNotificationsHeld(false);
		this.deps.drainNotifications();
	}

	/** `true` when a synthetic send may proceed; `false` (logged with its
	 *  origin) while either hold is engaged. */
	gate(origin: SyntheticHoldOrigin): boolean {
		if (!this.freshSpeechHold && !this.dialWindow) return true;
		this.deps.log(`Synthetic output held — suppressed ${origin}`);
		return false;
	}

	/** Subscribe to fresh-speech hold releases; returns the unsubscribe. */
	onRelease(cb: () => void): () => void {
		this.releaseListeners.add(cb);
		return () => {
			this.releaseListeners.delete(cb);
		};
	}
}

/**
 * Drops work that belongs to a provider connection a host recovery has
 * abandoned: tool results for calls the old connection issued, and external
 * STT captures committed on it.
 *
 * Tool calls and STT commits are stamped with the transport's dial
 * generation (`currentDialGen`). {@link markBoundary} records the generation
 * of the connection a host recovery is about to abandon; a stamp at or below
 * it is stale. Automatic reconnects never mark a boundary, so across them
 * tool results and STT captures are delivered as before. Until a boundary is
 * marked nothing is stale, and on a transport without `currentDialGen`
 * nothing is stamped.
 *
 * The constructor wraps `transport.sendToolResult` once, so every result
 * sent through the transport afterwards passes the fence, including results
 * a later wrapper queues and sends through the sender it captured.
 */
export class DialGenerationFence {
	/** Dial generation each tool call was issued on, until its result is sent. */
	private readonly toolCallGens = new Map<string, number>();
	/** Dial generation each turn's STT capture was committed on. A batch
	 *  provider transcribes asynchronously, so a transcript can arrive long
	 *  after its commit: its capture, not its arrival, places it. */
	private readonly sttCommitGens = new Map<number, number>();
	/** Latest turn whose STT capture was stamped. */
	private latestSttTurn: number | null = null;
	/** Dial generation of the connection abandoned at the last boundary. */
	private boundaryGen: number | null = null;
	/** Latest turn whose STT capture was stamped before the last boundary. */
	private boundaryTurn: number | null = null;

	constructor(
		private readonly transport: LLMTransport,
		private readonly log: (message: string) => void,
	) {
		const send = transport.sendToolResult.bind(transport);
		transport.sendToolResult = (result) => {
			if (this.shouldDropToolResult(result.id)) return;
			send(result);
		};
	}

	/** Record the dial generation these tool calls were issued on. */
	stampToolCalls(ids: string[]): void {
		const gen = this.transport.currentDialGen;
		if (gen === undefined) return;
		for (const id of ids) this.toolCallGens.set(id, gen);
	}

	/** Whether this result answers a call issued before the last boundary
	 *  (logged when so). Settles the call's stamp either way. */
	shouldDropToolResult(id: string): boolean {
		const issuedGen = this.toolCallGens.get(id);
		this.toolCallGens.delete(id);
		if (issuedGen === undefined || this.boundaryGen === null || issuedGen > this.boundaryGen) {
			return false;
		}
		this.log(
			`Dropped tool result ${id}: its call was issued on dial ${issuedGen}, abandoned by a host recovery`,
		);
		return true;
	}

	/** Record the dial generation a turn's STT capture was committed on. The
	 *  turn window consults only the current and the preceding turn, so older
	 *  stamps are pruned; a reserved transcript outside that window is placed
	 *  by its turn instead ({@link isSttCaptureStale}). */
	stampSttCommit(turnId: number): void {
		const gen = this.transport.currentDialGen;
		if (gen === undefined) return;
		this.sttCommitGens.set(turnId, gen);
		if (this.latestSttTurn === null || turnId > this.latestSttTurn) this.latestSttTurn = turnId;
		for (const t of this.sttCommitGens.keys()) {
			if (t < turnId - 2) this.sttCommitGens.delete(t);
		}
	}

	/** Whether this turn's STT capture was committed before the last boundary.
	 *  An id-less transcript (a streaming provider's own commit) has no stamp
	 *  and is never stale. A turn whose stamp was pruned is stale when it is
	 *  no later than the last turn stamped before the boundary, since turns
	 *  commit in order. */
	isSttCaptureStale(turnId: number | undefined): boolean {
		if (turnId === undefined || this.boundaryGen === null) return false;
		const capturedGen = this.sttCommitGens.get(turnId);
		if (capturedGen === undefined) {
			return this.boundaryTurn !== null && turnId <= this.boundaryTurn;
		}
		return capturedGen <= this.boundaryGen;
	}

	/** Mark a host-recovery boundary: record the current dial generation,
	 *  before the recovery aborts the connection and advances it, and the
	 *  latest turn whose capture was stamped on it or earlier. */
	markBoundary(): void {
		const gen = this.transport.currentDialGen;
		if (gen === undefined) return;
		this.boundaryGen = gen;
		this.boundaryTurn = this.latestSttTurn;
	}
}

/** Collaborators the {@link HostRecoveryController} drives. The session
 *  supplies the turn and greeting steps of the boundary as callbacks. */
export interface HostRecoveryControllerDeps {
	transport: LLMTransport;
	sessionManager: {
		readonly state: SessionState;
		readonly resumptionHandle: string | null;
		transitionTo(state: SessionState): void;
		clearResumptionHandle(): void;
	};
	reconnector: Pick<
		TransportReconnector,
		| 'beginHostRecovery'
		| 'parkUpstreamLost'
		| 'resetAttempts'
		| 'cancelHeldRecovery'
		| 'disarmResponseWatchdog'
	>;
	clientTransport: IClientChannel;
	eventBus: EventBus;
	hold: SyntheticOutputHold;
	fence: DialGenerationFence;
	getSessionId(): string;
	upstreamLossPolicy: 'close' | 'hold';
	/** `orchestrationMode: 'actor'`: host recovery is unavailable. */
	actorMode: boolean;
	/** Dial the transport exactly as `start()` does. */
	dialTransport(): Promise<void>;
	/** Flush the transcript buffers. */
	flushTranscript(): void;
	/** Finalize the active turn, if any, as interrupted. */
	abandonActiveTurn(): void;
	/** Discard the external STT provider's uncommitted audio. */
	discardSttUtterance(): void;
	/** Clear pending-greeting, greeting-suppression and grace state without
	 *  sending a greeting. */
	clearGreetingState(): void;
	/** Drop retained user audio (the watchdog replay candidate). */
	clearRetainedUtterances(): void;
	/** Inject the recent conversation as quiet context, hold-gated. */
	injectRecentContext(origin: 'gemini-reconnect-context'): void;
	reportError(component: string, error: Error): void;
	log(message: string): void;
}

/** One in-flight host recovery. */
interface RecoveryAttempt {
	readonly result: RecoverUpstreamResult;
	readonly args: RecoverUpstreamArgs;
	readonly resolveActivated: () => void;
	readonly rejectActivated: (error: Error) => void;
	readonly settleIncumbentClosed: (closing: Promise<'closed' | 'forced'>) => void;
	/** The boundary ran for this recovery. */
	boundaryDone: boolean;
	/** `incumbentClosed` is settled: the incumbent was aborted, or its close
	 *  is another recovery's. */
	incumbentSettled: boolean;
	/** Reconnect-window client buffering handed over by the reconnector,
	 *  still open. */
	ownsClientBuffer: boolean;
}

/** States `recoverUpstream()` accepts. From CONNECTING the recovery replaces
 *  the first dial of `start()`, still pending. */
const RECOVERABLE_STATES: readonly SessionState[] = [
	'CONNECTING',
	'ACTIVE',
	'RECONNECTING',
	'UPSTREAM_LOST',
];

/** States `parkUpstream()` accepts. */
const PARKABLE_STATES: readonly SessionState[] = ['ACTIVE', 'RECONNECTING', 'UPSTREAM_LOST'];

/**
 * Runs host-driven upstream recovery for a legacy-orchestration session with
 * `upstreamLossPolicy: 'hold'`. The session never enters CLOSED: a recovery
 * goes from CONNECTING, ACTIVE, RECONNECTING or UPSTREAM_LOST to RECONNECTING
 * and, once the replacement dial is set up, to ACTIVE. From CONNECTING it
 * strands the first dial of `start()`, still pending, and dials the
 * replacement itself ({@link firstDialReplaced} lets `start()` tell), or,
 * when the recovery comes before `start()` dials, `start()` dials nothing and
 * resolves.
 *
 * {@link recoverUpstream} is single-flight: the complete result is built and
 * latched before anything that can publish an event, so a caller re-entering
 * from any subscriber (including a `generation.end` published while the
 * incumbent is aborted) receives the recovery in flight and never starts a
 * second dial. The latch is released however the recovery ends: activated,
 * failed (a failed dial or a throwing step), superseded by a park, or
 * outlived by the session. Recovery takes over from the {@link TransportReconnector}:
 * a pending backoff dial is cancelled, an in-flight automatic reconnect is
 * superseded, and the reconnect-window client buffering it opened is ended
 * here, discarding its frames.
 */
export class HostRecoveryController {
	private inFlight: RecoveryAttempt | null = null;
	private disposed = false;
	private replacedFirstDial = false;

	constructor(private readonly deps: HostRecoveryControllerDeps) {}

	/** Set once a recovery starts while the session is CONNECTING: that
	 *  recovery replaces the first dial of `start()` and owns the session from
	 *  then on. A recovery from any other state leaves it unset, including one
	 *  that runs after the first dial set up but before `start()` resumes. */
	get firstDialReplaced(): boolean {
		return this.replacedFirstDial;
	}

	/** What this session supports: the full descriptor with the native
	 *  transport under policy `'hold'` in legacy orchestration, otherwise one
	 *  degraded shape in which nothing recovery-related can engage. */
	getRecoveryCapabilities(): RecoveryCapabilities {
		if (this.canRecover()) return RECOVERY_CAPABILITIES;
		return Object.freeze({
			version: 1,
			recoverUpstream: false,
			reconnectBoundary: false,
			turnStartPublication: true,
			transportGenerations: this.hasGenerationCounters(),
			syntheticHold: false,
		});
	}

	/**
	 * Abandon the current provider connection and dial a fresh one (no
	 * resumption handle). Throws `SessionError` when
	 * `getRecoveryCapabilities().recoverUpstream` is false, the session is
	 * closing, or the state is not CONNECTING, ACTIVE, RECONNECTING or
	 * UPSTREAM_LOST. From CONNECTING the aborted incumbent is the first dial
	 * of `start()`, still pending; `start()` leaves the session to this
	 * recovery when that dial settles, or dials nothing when the recovery
	 * came before `start()` began its dial (called the transport's
	 * `connect()`).
	 *
	 * Synchronously, in order: latch the result; engage the fresh-speech hold
	 * when asked and, always, the dial window (which holds notifications);
	 * take recovery over from the reconnector; drop retained user audio; run
	 * the boundary against the still-open incumbent; abort the incumbent;
	 * enter RECONNECTING; publish `session.reset` then
	 * `session.reconnectBoundary`; clear both resumption handle copies. Then
	 * the dial runs; see {@link finishDial}.
	 *
	 * The latch never outlives the recovery. A step that throws fails it as a
	 * failed dial does ({@link failAttempt}): reported, parked, `activated`
	 * rejected, and the result is still returned. A park or a `close()` from a
	 * subscriber during the sequence stops it: the rest of the sequence and the
	 * dial are skipped and `activated` rejects.
	 */
	recoverUpstream(args: RecoverUpstreamArgs): RecoverUpstreamResult {
		if (this.inFlight) return this.inFlight.result;
		this.assertHostRecovery('recoverUpstream');
		if (!this.hasRecoveryPrimitives()) {
			throw new SessionError(
				'recoverUpstream(): the transport lacks the recovery primitives (abortIncumbent, currentDialGen, currentTransportGeneration); getRecoveryCapabilities().recoverUpstream is false',
			);
		}
		this.assertState('recoverUpstream', RECOVERABLE_STATES);
		if (this.deps.sessionManager.state === 'CONNECTING') this.replacedFirstDial = true;

		// Nothing below publishes before the latch is set. abortIncumbent()
		// advances the dial generation once and the dial mints the next.
		const attemptEpoch = (this.deps.transport.currentDialGen ?? 0) + 2;
		const activated = deferred<void>();
		const incumbentClosed = deferred<'closed' | 'forced'>();
		const attempt: RecoveryAttempt = {
			result: {
				attemptEpoch,
				activated: activated.promise,
				incumbentClosed: incumbentClosed.promise,
			},
			args,
			resolveActivated: () => activated.resolve(),
			rejectActivated: (error) => activated.reject(error),
			settleIncumbentClosed: (closing) => incumbentClosed.resolve(closing),
			boundaryDone: false,
			incumbentSettled: false,
			ownsClientBuffer: false,
		};
		// A caller that never observes `activated` must not surface its
		// rejection as unhandled.
		attempt.result.activated.catch(() => {});
		this.inFlight = attempt;
		this.deps.log(`recoverUpstream(${args.reason}): dialing attempt ${attemptEpoch}`);
		// Every step reaches code outside this controller (providers, the
		// transport, subscribers): a throw must not leave the latch set.
		try {
			this.runRecovery(attempt);
		} catch (error) {
			this.failAttempt(attempt, toError(error));
		}
		return attempt.result;
	}

	/** The recovery sequence after the latch; see {@link recoverUpstream}. */
	private runRecovery(attempt: RecoveryAttempt): void {
		const { sessionManager, reconnector, hold, eventBus } = this.deps;
		const { args } = attempt;
		const { attemptEpoch } = attempt.result;
		if (args.holdSyntheticUntilFreshSpeech) hold.engage();
		hold.engageDialWindow();
		const handover = reconnector.beginHostRecovery();
		attempt.ownsClientBuffer = handover.wasBuffering;
		// A watchdog fire or armed watchdog belongs to the abandoned connection:
		// left alone, it could start an automatic reconnect beside this dial.
		reconnector.cancelHeldRecovery();
		reconnector.disarmResponseWatchdog();
		this.deps.clearRetainedUtterances();
		this.beginReconnectBoundary(args.reason);
		if (this.stopIfSuperseded(attempt)) return;
		this.abortIncumbent(attempt);
		if (this.stopIfSuperseded(attempt)) return;
		const state = sessionManager.state;
		if (state === 'CONNECTING' || state === 'ACTIVE' || state === 'UPSTREAM_LOST') {
			sessionManager.transitionTo('RECONNECTING');
		}
		const sessionId = this.deps.getSessionId();
		eventBus.publish('session.reset', { sessionId, reason: 'reconnect' });
		eventBus.publish('session.reconnectBoundary', {
			sessionId,
			reason: args.reason,
			transportGeneration: attemptEpoch,
			attemptEpoch,
		});
		this.clearResumption();
		if (this.stopIfSuperseded(attempt)) return;

		void this.deps
			.dialTransport()
			.then(
				() => this.finishDial(attempt, null),
				(error: unknown) => this.finishDial(attempt, toError(error)),
			)
			.catch((error: unknown) => this.deps.reportError('recover-upstream', toError(error)));
	}

	/**
	 * The recovery boundary, run once per recovery against the still-open
	 * incumbent (before its dial generation advances): flush the transcript,
	 * finalize the active turn as interrupted, discard the external STT
	 * provider's uncommitted audio (interrupted finalization keeps it), clear
	 * leftover greeting state, then mark the boundary for the dial-generation
	 * fence. No-op outside a recovery or when it already ran.
	 */
	beginReconnectBoundary(reason: string): void {
		const attempt = this.inFlight;
		if (!attempt || attempt.boundaryDone) return;
		attempt.boundaryDone = true;
		this.deps.log(
			`Reconnect boundary (${reason}) before dial attempt ${attempt.result.attemptEpoch}`,
		);
		this.deps.flushTranscript();
		this.deps.abandonActiveTurn();
		this.deps.discardSttUtterance();
		this.deps.clearGreetingState();
		this.deps.fence.markBoundary();
	}

	/**
	 * Host-intentional teardown of the provider connection: park the session
	 * in UPSTREAM_LOST without finalization (publishing `session.upstreamLost`
	 * with reason `'host-parked'` and the caller's reason as its detail), then
	 * disconnect the transport. Automatic recovery is cancelled, and a host
	 * recovery in flight is superseded: its `activated` rejects and its dial,
	 * if it completes, is disconnected. Only `recoverUpstream()` redials.
	 * Rejects with `SessionError` in actor mode, under policy `'close'`, while
	 * closing, and outside ACTIVE, RECONNECTING and UPSTREAM_LOST.
	 */
	async parkUpstream(reason: string): Promise<void> {
		this.assertHostRecovery('parkUpstream');
		this.assertState('parkUpstream', PARKABLE_STATES);
		const attempt = this.inFlight;
		if (attempt) {
			this.inFlight = null;
			this.endClientBuffering(attempt);
		}
		this.deps.reconnector.parkUpstreamLost('host-parked', { reason });
		await this.deps.transport.disconnect();
	}

	/** Clear the session manager's and the transport's resumption handle
	 *  copies, so the next dial opens a fresh server session. Returns whether
	 *  the session held a handle. */
	clearResumption(): boolean {
		const hadHandle = this.deps.sessionManager.resumptionHandle !== null;
		this.deps.sessionManager.clearResumptionHandle();
		this.deps.transport.clearResumption?.();
		return hadHandle;
	}

	/** Session teardown: no new recovery or park starts, a recovery still in
	 *  its synchronous sequence stops before it dials, and a dial still in
	 *  flight is disconnected when it completes. Idempotent. */
	dispose(): void {
		this.disposed = true;
	}

	/**
	 * The dial settled. A recovery the session closed or a park superseded
	 * rejects `activated` (a completed dial is disconnected, best-effort). A
	 * failed dial fails the recovery ({@link failAttempt}). Otherwise the
	 * session activates: ACTIVE, a fresh reconnect budget, the dial window
	 * released (which runs one notification drain when the model is idle and
	 * no fresh-speech hold remains), then quiet recent context unless
	 * `skipContextInjection`. A throw in the drain or the injection is
	 * reported and skips neither the other nor the settlement of `activated`.
	 * A park or a `close()` from code the activation reaches (a subscriber of
	 * the ACTIVE transition, the drain, the injection) stops it
	 * ({@link stopIfSuperseded}): nothing after that point runs, so a parked
	 * session keeps its dial window, and `activated` rejects; the park or the
	 * close disconnects the replacement. A throw before the dial window is
	 * released fails the recovery with the replacement connection open, which
	 * {@link failAttempt} then disconnects. The handed-over client buffering
	 * is discarded in every case.
	 */
	private finishDial(attempt: RecoveryAttempt, failure: Error | null): void {
		const { sessionManager, reconnector, hold } = this.deps;
		const epoch = attempt.result.attemptEpoch;
		const why = this.stopReason(attempt);
		if (why !== null) {
			if (attempt === this.inFlight) this.inFlight = null;
			if (!failure) {
				this.deps.log(`recoverUpstream: attempt ${epoch} dialed after ${why}; disconnecting it`);
				this.deps.transport.disconnect().catch(() => {});
			}
			this.rejectAttempt(attempt, why);
			return;
		}
		if (failure) {
			this.failAttempt(attempt, failure);
			return;
		}
		try {
			this.endClientBuffering(attempt);
			sessionManager.transitionTo('ACTIVE');
			// A subscriber of the transition may have parked or closed the session.
			if (this.stopIfSuperseded(attempt)) return;
			reconnector.resetAttempts();
		} catch (error) {
			this.failAttempt(attempt, toError(error), true);
			return;
		}
		// The replacement connection is live: a throw in one activation effect
		// skips neither the other nor the settlement of `activated`.
		try {
			this.runGuarded('notification drain on activation', () => hold.releaseDialWindow());
			if (!attempt.args.skipContextInjection) {
				this.runGuarded('context injection on activation', () =>
					this.deps.injectRecentContext('gemini-reconnect-context'),
				);
			}
		} finally {
			// A park or a close from the drain or the injection: `activated` rejects.
			if (!this.stopIfSuperseded(attempt)) {
				this.inFlight = null;
				this.deps.log(`recoverUpstream: attempt ${epoch} active`);
				attempt.resolveActivated();
			}
		}
	}

	/** Run one recovery step whose throw must not skip the steps after it:
	 *  the throw is logged and reported as `recover-upstream`. */
	private runGuarded(step: string, run: () => void): void {
		try {
			run();
		} catch (error) {
			const err = toError(error);
			this.deps.log(`recoverUpstream: ${step} failed: ${err.message}`);
			this.deps.reportError('recover-upstream', err);
		}
	}

	/**
	 * A recovery that cannot activate, from a failed dial or a step that
	 * threw: release the latch, reject `activated`, report
	 * `recover-upstream`, discard the handed-over client buffering, abort the
	 * incumbent when the sequence had not yet, then park in UPSTREAM_LOST (the
	 * dial window stays engaged while parked). When the dial had succeeded
	 * (`replacementOpen`, a throw during activation), the replacement
	 * connection it opened is disconnected after the park, so no provider
	 * connection stays open while parked. Nothing is parked or disconnected
	 * when a park already superseded the recovery, or when a newer recovery
	 * started from a subscriber of that abort's `generation.end`; nothing is
	 * disconnected when one started from a subscriber of the park (it strands
	 * that connection itself).
	 */
	private failAttempt(attempt: RecoveryAttempt, failure: Error, replacementOpen = false): void {
		const current = this.inFlight === attempt;
		if (current) this.inFlight = null;
		attempt.rejectActivated(failure);
		this.deps.log(
			`recoverUpstream: attempt ${attempt.result.attemptEpoch} failed: ${failure.message}`,
		);
		this.deps.reportError('recover-upstream', failure);
		this.runGuarded('client buffer discard', () => this.endClientBuffering(attempt));
		if (!attempt.incumbentSettled) {
			this.runGuarded('incumbent abort', () => this.abortIncumbent(attempt));
		}
		if (current && this.inFlight === null) {
			this.deps.reconnector.parkUpstreamLost('recover-upstream-failed', {
				reason: failure.message,
			});
			if (replacementOpen && this.inFlight === null) {
				this.runGuarded('replacement disconnect', () => {
					this.deps.transport.disconnect().catch(() => {});
				});
			}
		}
	}

	/** Strand the incumbent connection, once per recovery, settling
	 *  `incumbentClosed` with its bounded close (`'forced'` when the abort
	 *  throws, which is rethrown). */
	private abortIncumbent(attempt: RecoveryAttempt): void {
		attempt.incumbentSettled = true;
		let closing: Promise<'closed' | 'forced'>;
		try {
			closing = this.deps.transport.abortIncumbent?.() ?? Promise.resolve('closed');
		} catch (error) {
			attempt.settleIncumbentClosed(Promise.resolve('forced'));
			throw error;
		}
		attempt.settleIncumbentClosed(closing);
	}

	/**
	 * Whether this recovery must stop, checked between the steps of its
	 * synchronous sequence and of its activation: a park from a subscriber
	 * superseded it, or the session is closing ({@link stopReason}). If so the
	 * recovery stops before its next step: from the sequence it never
	 * transitions or dials; from the activation it never releases the dial
	 * window or injects. The latch is released. Its `incumbentClosed` follows
	 * a newer recovery's when one started meanwhile (that recovery aborts the
	 * same connection), otherwise the incumbent is aborted here if the
	 * sequence had not yet; `activated` rejects.
	 */
	private stopIfSuperseded(attempt: RecoveryAttempt): boolean {
		const why = this.stopReason(attempt);
		if (why === null) return false;
		if (this.inFlight === attempt) this.inFlight = null;
		if (!attempt.incumbentSettled) {
			const newer = this.inFlight;
			if (newer) {
				attempt.incumbentSettled = true;
				attempt.settleIncumbentClosed(newer.result.incumbentClosed);
			} else {
				this.abortIncumbent(attempt);
			}
		}
		this.deps.log(`recoverUpstream: attempt ${attempt.result.attemptEpoch} stopped (${why})`);
		this.rejectAttempt(attempt, why);
		return true;
	}

	/** Why this recovery can no longer go on, or `null` while it can: a park
	 *  superseded it, or the session is closing. */
	private stopReason(attempt: RecoveryAttempt): string | null {
		if (attempt !== this.inFlight) return 'superseded by a park';
		if (this.disposed || this.deps.sessionManager.state === 'CLOSED') return 'the session closed';
		return null;
	}

	/** Reject `activated` of a recovery that was superseded or outlived the
	 *  session, discarding its handed-over client buffering. */
	private rejectAttempt(attempt: RecoveryAttempt, why: string): void {
		attempt.rejectActivated(
			new SessionError(
				`recoverUpstream: attempt ${attempt.result.attemptEpoch} did not activate (${why})`,
			),
		);
		this.endClientBuffering(attempt);
	}

	/** End the client buffering a recovery took over, dropping its frames. A
	 *  channel without `discardBuffered()` falls back to `stopBuffering()`
	 *  with a log (owned frames it returns are dropped here). */
	private endClientBuffering(attempt: RecoveryAttempt): void {
		if (!attempt.ownsClientBuffer) return;
		attempt.ownsClientBuffer = false;
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

	private canRecover(): boolean {
		return (
			!this.deps.actorMode &&
			this.deps.upstreamLossPolicy === 'hold' &&
			this.hasRecoveryPrimitives()
		);
	}

	private hasGenerationCounters(): boolean {
		const t = this.deps.transport;
		return typeof t.currentDialGen === 'number' && typeof t.currentTransportGeneration === 'number';
	}

	private hasRecoveryPrimitives(): boolean {
		return this.hasGenerationCounters() && typeof this.deps.transport.abortIncumbent === 'function';
	}

	private assertHostRecovery(method: string): void {
		if (this.deps.actorMode) {
			throw new SessionError(
				`${method}() is not supported with orchestrationMode 'actor'; host recovery requires legacy orchestration`,
			);
		}
		if (this.deps.upstreamLossPolicy !== 'hold') {
			throw new SessionError(`${method}() requires upstreamLossPolicy 'hold'`);
		}
		if (this.disposed) throw new SessionError(`${method}(): the session is closing`);
	}

	private assertState(method: string, accepted: readonly SessionState[]): void {
		const state = this.deps.sessionManager.state;
		if (!accepted.includes(state)) {
			const listed = `${accepted.slice(0, -1).join(', ')} or ${accepted[accepted.length - 1]}`;
			throw new SessionError(`${method}() requires the session to be ${listed}; it is ${state}`);
		}
	}
}

/** `error` as an `Error`, wrapping a thrown non-Error value. */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** A promise with its settle functions. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
