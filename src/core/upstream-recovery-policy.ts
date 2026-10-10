// SPDX-License-Identifier: MIT

/**
 * When to redial a lost upstream, in one place. `HostRecoveryController` owns
 * how a session redials (`recoverUpstream()`) and parks (`parkUpstream()`);
 * this policy owns when, so a host no longer re-implements the same timers,
 * gates and classifiers around those two calls. It needs
 * `upstreamLossPolicy: 'hold'` and a transport with the recovery primitives
 * (the Gemini transport), and works in both orchestration modes.
 *
 * What it does:
 * - **Redial ladder**: a terminal loss (a remote `generation-close`, or
 *   `setup-failed`) schedules a dial after 1 s, 2 s, 4 s, ... capped at 60 s
 *   and jittered ±20%. A `setup-ok` resets the ladder only once that
 *   connection proved stable (no close for 30 s), so a connection that dies
 *   every few seconds keeps backing off. A dial fires only while the session
 *   is parked in `UPSTREAM_LOST` and someone is there to talk to (an attached
 *   client, or `isLive()` for a session without one, such as a phone call).
 * - **Redial after a park**: when the reconnector gives up and parks the
 *   session, a dial follows after `parkRedialDelayMs`, or later if the ladder
 *   or a fatal backoff says so. A park the host asked for is left alone.
 * - **Fatal backoff**: a close the classifier calls non-retryable (quota,
 *   depleted credits, invalid key, unknown model) blocks every dial for
 *   `fatalBackoffMs`; reaching `ACTIVE` clears it.
 * - **Stuck dial**: a session in `CONNECTING` for `stuckConnectingMs` with
 *   someone there has its dial replaced by `recoverUpstream()`.
 * - **Health tick**: every `healthTickMs`, a parked session with someone there
 *   is redialed if the ladder missed it (at most once a minute).
 * - **Idle park**: with nobody there for `idleParkMs`, the upstream is parked;
 *   the next client attach redials it (the session's attach path).
 * - **Attach gate**: while a fatal backoff is pending and the reconnector is
 *   already redialing, a client attach does not add a dial of its own.
 * - **Active silence** (opt-in, `activeSilence`): a connected session whose
 *   model stays silent after the user spoke is redialed; see
 *   `active-silence-recovery.ts`. While it owns a recovery, the ladder and the
 *   health tick stand down.
 *
 * Presentation stays with the host: `onFatal` and `onRecovered` report the
 * edges, and the host decides what the user sees. Active silence speaks its
 * own client protocol (`voice-stalled`, `voice.retryUpstream`).
 */

import type { SessionState } from '../types/session.js';
import type { ConnectionLifecycleEvent } from '../types/transport.js';
import { ActiveSilenceRecovery, DEFAULT_ACTIVE_SILENCE_TICKS } from './active-silence-recovery.js';
import type { RecoverUpstreamArgs, RecoverUpstreamResult } from './host-recovery.js';

/** A close the policy treats as non-retryable, and why. */
export interface FatalClose {
	category: string;
	code?: number;
	reason: string;
}

/** Classifies a provider close: a `FatalClose` stops dialing for the fatal
 *  backoff, `null` lets the ladder retry. */
export type CloseClassifier = (
	code: number | undefined,
	reason: string | undefined,
) => FatalClose | null;

export interface UpstreamRecoveryOptions {
	/** First ladder delay. Default 1000 ms. */
	redialBaseMs?: number;
	/** Ladder cap. Default 60000 ms. */
	redialCapMs?: number;
	/** How long a connection must live after `setup-ok` to reset the ladder.
	 *  Default 30000 ms. */
	redialStableMs?: number;
	/** Delay from a reconnector park to its redial, giving the session's own
	 *  close handling time to settle. Default 1500 ms. */
	parkRedialDelayMs?: number;
	/** Whether someone is there to talk to. Default: a client is attached. A
	 *  session fed without a client (a phone call through
	 *  `feedAudioFromClient`) passes its own, such as "the call is up". */
	isLive?: () => boolean;
	/** Ladder, park and health-tick redials hold synthetic output (greeting,
	 *  injected context) until the user is heard. Default `false`. */
	holdSyntheticUntilFreshSpeech?: boolean;
	/** How long a fatal close blocks dialing. Default 300000 ms (5 min). */
	fatalBackoffMs?: number;
	/** Close classifier. Default {@link classifyGeminiClose}. */
	classifyClose?: CloseClassifier;
	/** How long a session may stay in `CONNECTING`, with someone there, before
	 *  its dial is replaced. Default 120000 ms; `0` disables; a positive value
	 *  below 60000 ms is raised to 60000 ms, twice the dial deadline. */
	stuckConnectingMs?: number;
	/** Health tick period. Default 30000 ms; `0` disables the tick (and with it
	 *  the stuck-dial check, the backstop redial and active silence). */
	healthTickMs?: number;
	/** Park the upstream after this long with nobody there. Default 60000 ms;
	 *  `0` disables. */
	idleParkMs?: number;
	/** Redial a connected session whose model stays silent after the user
	 *  spoke. `requiredTicks` consecutive qualifying health ticks (default 3)
	 *  start a redial. Omitted: off. */
	activeSilence?: { requiredTicks?: number };
	/** A fatal close started a backoff. */
	onFatal?: (close: FatalClose & { until: number }) => void;
	/** The session reached `ACTIVE` after a fatal close was reported. */
	onRecovered?: () => void;
}

export interface UpstreamRecoveryDeps {
	sessionId: string;
	getState(): SessionState;
	isClientConnected(): boolean;
	/** `VoiceSession.recoverUpstream()`. */
	recoverUpstream(args: RecoverUpstreamArgs): RecoverUpstreamResult;
	/** `VoiceSession.parkUpstream()`. */
	parkUpstream(reason: string): Promise<void>;
	sendJsonToClient(message: Record<string, unknown>): void;
	log(message: string): void;
	now?: () => number;
	random?: () => number;
}

export const REDIAL_JITTER_FRAC = 0.2;
export const MIN_STUCK_CONNECTING_MS = 60_000;
const BACKSTOP_MIN_INTERVAL_MS = 60_000;

interface PatternRule {
	rx: RegExp;
	category: string;
}

/** Non-retryable Gemini Live close reasons. Anything else is retryable. Broad on purpose (a bare
 *  404, 401/403, `deprecated`): each match only delays redial by `fatalBackoffMs`, so a false
 *  positive costs minutes, while a missed fatal close redials a dead key forever. Hosts with their
 *  own wording pass `classifyClose`. */
const GEMINI_FATAL_PATTERNS: readonly PatternRule[] = [
	{
		rx: /prepayment.{0,20}credits.{0,20}depleted|prepayment.{0,20}depleted/i,
		category: 'credits_depleted',
	},
	{
		rx: /exceeded your current quota|quota.{0,20}exceeded|quota.{0,20}exhausted/i,
		category: 'quota_exceeded',
	},
	{
		rx: /api.?key.{0,20}(not valid|invalid)|invalid.{0,20}api.?key|api_key_invalid|permission_denied|unauthorized|\b401\b|\b403\b/i,
		category: 'auth_invalid',
	},
	{
		rx: /is not found for API version|not supported for|\bmodels?\/\S+\s+(is\s+)?not\s+found|\b404\b|\bdeprecated\b/i,
		category: 'model_not_found',
	},
];

/** The default classifier: Gemini Live's non-retryable close reasons. */
export const classifyGeminiClose: CloseClassifier = (code, reason) => {
	const text = (reason ?? '').trim();
	const rule = GEMINI_FATAL_PATTERNS.find((p) => p.rx.test(text));
	return rule ? { category: rule.category, code, reason: text } : null;
};

/** bodhi's own `disconnect()` emits exactly this close; it is not a loss. */
function isLocalDisconnect(ev: ConnectionLifecycleEvent): boolean {
	return ev.kind === 'generation-close' && ev.code === 1000 && ev.reason === 'local disconnect';
}

export class UpstreamRecoveryPolicy {
	private readonly baseMs: number;
	private readonly capMs: number;
	private readonly stableMs: number;
	private readonly parkRedialDelayMs: number;
	private readonly fatalBackoffMs: number;
	private readonly stuckConnectingMs: number;
	private readonly healthTickMs: number;
	private readonly idleParkMs: number;
	private readonly classify: CloseClassifier;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly activeSilence: ActiveSilenceRecovery | null;

	/** Consecutive unstable or failed connections: the ladder index. */
	private failures = 0;
	/** When the next ladder dial may fire; 0 when none is pending. */
	private nextDialAt = 0;
	/** The current connection's `setup-ok` time; 0 when none. */
	private setupOkAt = 0;
	private fatalUntil = 0;
	private fatalReported = false;
	private lastDialAt = 0;
	private connectingSince = 0;
	/** The session is parked because the host asked: no dial until an attach. */
	private hostParked = false;
	/** `isLive()` at the last health tick: a client-less session has no attach to un-park it. */
	private wasLive = false;
	private dialTimer: ReturnType<typeof setTimeout> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(
		private readonly deps: UpstreamRecoveryDeps,
		private readonly options: UpstreamRecoveryOptions = {},
	) {
		this.baseMs = options.redialBaseMs ?? 1_000;
		this.capMs = options.redialCapMs ?? 60_000;
		this.stableMs = options.redialStableMs ?? 30_000;
		this.parkRedialDelayMs = options.parkRedialDelayMs ?? 1_500;
		this.fatalBackoffMs = options.fatalBackoffMs ?? 300_000;
		const stuck = options.stuckConnectingMs ?? 120_000;
		this.stuckConnectingMs = stuck > 0 ? Math.max(stuck, MIN_STUCK_CONNECTING_MS) : 0;
		this.healthTickMs = options.healthTickMs ?? 30_000;
		this.idleParkMs = options.idleParkMs ?? 60_000;
		this.classify = options.classifyClose ?? classifyGeminiClose;
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
		this.activeSilence = options.activeSilence
			? new ActiveSilenceRecovery(
					{
						voiceSessionId: deps.sessionId,
						recoverUpstream: (args) => deps.recoverUpstream(args),
						sendJsonToClient: (m) => deps.sendJsonToClient(m),
						log: (m) => deps.log(m),
						now: this.now,
					},
					options.activeSilence.requiredTicks ?? DEFAULT_ACTIVE_SILENCE_TICKS,
				)
			: null;
	}

	/** Start the health tick and, with nobody there yet, the idle clock. */
	start(): void {
		if (this.disposed) return;
		if (this.healthTickMs > 0 && !this.tickTimer) {
			this.tickTimer = setInterval(() => this.tick(), this.healthTickMs);
		}
		if (!this.hasAudience()) this.armIdlePark();
	}

	dispose(): void {
		this.disposed = true;
		this.clearDialTimer();
		this.clearIdleTimer();
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = null;
		this.activeSilence?.stop();
	}

	/** Whether a fatal backoff blocks dialing now. */
	inFatalBackoff(): boolean {
		return this.now() < this.fatalUntil;
	}

	/**
	 * The attach gate: `true` while active silence owns a recovery (its attempt
	 * budget decides every dial), or while a fatal backoff is pending and the
	 * reconnector is already redialing. A client attach then adds no dial of its
	 * own, and the reconnector parks instead of redialing. Otherwise a parked
	 * session redials on attach.
	 */
	suppressAttachRedial(): boolean {
		if (this.activeSilence?.ownsRecovery === true) return true;
		return this.deps.getState() === 'RECONNECTING' && this.inFatalBackoff();
	}

	// --- Feeds ---

	/** A transport connection-lifecycle event. */
	onLifecycle(ev: ConnectionLifecycleEvent): void {
		if (this.disposed) return;
		this.activeSilence?.handleLifecycle(ev);
		const now = this.now();
		switch (ev.kind) {
			case 'attempt':
				// A dial is in flight: a pending ladder dial must not fire under it,
				// and stability credit belongs to the connection that earns it.
				this.nextDialAt = 0;
				this.setupOkAt = 0;
				this.clearDialTimer();
				return;
			case 'setup-ok':
				this.setupOkAt = now;
				this.nextDialAt = 0;
				this.clearDialTimer();
				return;
			case 'attempt-close': {
				// A close before setupComplete: only this event carries the provider's reason (the
				// `setup-failed` that follows does not), so a fatal one starts the backoff here and
				// the `setup-failed` schedules its dial after it.
				const fatal = this.classify(ev.code, ev.reason);
				if (fatal) this.noteFatal(fatal);
				return;
			}
			case 'setup-failed':
			case 'generation-close': {
				const stable = this.setupOkAt > 0 && now - this.setupOkAt >= this.stableMs;
				const prior = stable ? 0 : this.failures;
				this.setupOkAt = 0;
				if (isLocalDisconnect(ev)) {
					this.failures = prior;
					return;
				}
				const code = ev.kind === 'generation-close' ? ev.code : undefined;
				const fatal = this.classify(code, ev.reason);
				if (fatal) this.noteFatal(fatal);
				this.failures = prior + 1;
				this.scheduleDial(now + this.backoffDelayMs(this.failures));
				return;
			}
		}
	}

	/** The session changed state. */
	onStateChange(state: SessionState): void {
		if (this.disposed) return;
		if (state === 'CONNECTING') {
			if (this.connectingSince === 0) this.connectingSince = this.now();
		} else {
			this.connectingSince = 0;
		}
		if (state !== 'ACTIVE') return;
		this.hostParked = false;
		if (this.fatalUntil > 0) {
			this.fatalUntil = 0;
			this.activeSilence?.handleFatalBackoffCleared();
		}
		if (this.fatalReported) {
			this.fatalReported = false;
			this.safe('onRecovered', () => this.options.onRecovered?.());
		}
	}

	/** The session parked in `UPSTREAM_LOST` (`session.upstreamLost`). */
	onUpstreamLost(reason: string): void {
		if (this.disposed) return;
		if (reason === 'host-parked') {
			this.hostParked = true;
			this.clearDialTimer();
			this.nextDialAt = 0;
			return;
		}
		this.hostParked = false;
		this.scheduleDial(Math.max(this.nextDialAt, this.now() + this.parkRedialDelayMs));
	}

	onClientConnected(): void {
		this.clearIdleTimer();
		this.activeSilence?.handleClientConnected();
	}

	onClientDisconnected(): void {
		this.activeSilence?.handleClientDisconnected();
		this.armIdlePark();
	}

	/** The user spoke: recognized input (a transcription with text), never a voiced segment alone, which room noise produces. */
	noteUserSpeech(): void {
		this.activeSilence?.noteSpeech();
	}

	/** A microphone frame arrived. */
	noteMicFrame(): void {
		this.activeSilence?.noteMicFrame();
	}

	/** The model started a turn. */
	noteModelTurnStart(transportGeneration?: number): void {
		this.activeSilence?.noteModelEvent(transportGeneration);
	}

	/** The model finished a turn. */
	noteModelTurnEnd(): void {
		this.activeSilence?.noteResponse();
	}

	/** A foreground tool started. */
	noteToolCall(toolCallId: string): void {
		this.activeSilence?.noteToolCall(toolCallId);
	}

	noteToolSettled(toolCallId: string): void {
		this.activeSilence?.noteToolSettled(toolCallId);
	}

	/** The session switched between agent mode and dictation. */
	noteDictation(active: boolean): void {
		this.activeSilence?.noteMeetingMode(active);
	}

	/** A client command. Returns `true` when the policy handled it (a
	 *  `voice.retryUpstream` with active silence on). */
	handleClientCommand(msg: Record<string, unknown>): boolean {
		return this.activeSilence?.handleClientCommand(msg) ?? false;
	}

	/** One health tick: replace a stuck dial, the backstop redial, then the
	 *  active-silence tick. */
	tick(): void {
		if (this.disposed) return;
		const now = this.now();
		const state = this.deps.getState();
		const live = this.hasAudience();
		// A client-less session (isLive) idle-parked has no attach to redial it: becoming live again does.
		if (this.options.isLive && live && !this.wasLive && this.hostParked) this.hostParked = false;
		this.wasLive = live;
		const owned = this.activeSilence?.ownsRecovery === true;
		if (
			!owned &&
			state === 'CONNECTING' &&
			this.stuckConnectingMs > 0 &&
			this.connectingSince > 0 &&
			live &&
			now - this.connectingSince > this.stuckConnectingMs &&
			now - this.lastDialAt > BACKSTOP_MIN_INTERVAL_MS &&
			!this.inFatalBackoff()
		) {
			const stuckForS = Math.round((now - this.connectingSince) / 1000);
			this.deps.log(`[UpstreamRecovery] stuck in CONNECTING for ${stuckForS}s; replacing the dial`);
			// A replacement that is refused keeps the clock, so the next tick tries again.
			if (this.dial('stuck-connecting')) this.connectingSince = 0;
		} else if (
			!owned &&
			!this.hostParked &&
			state === 'UPSTREAM_LOST' &&
			live &&
			now >= this.nextDialAt &&
			now - this.lastDialAt > BACKSTOP_MIN_INTERVAL_MS &&
			!this.inFatalBackoff()
		) {
			this.deps.log('[UpstreamRecovery] health tick: parked session with someone there; redialing');
			this.dial('health-tick');
		}
		this.activeSilence?.tick(state);
	}

	// --- Internals ---

	private hasAudience(): boolean {
		if (this.options.isLive) {
			try {
				return this.options.isLive();
			} catch (err) {
				this.deps.log(
					`[UpstreamRecovery] isLive threw (treated as not live): ${err instanceof Error ? err.message : String(err)}`,
				);
				return false;
			}
		}
		return this.deps.isClientConnected();
	}

	private backoffDelayMs(failures: number): number {
		const base = Math.min(this.capMs, this.baseMs * 2 ** Math.max(0, failures - 1));
		return Math.round(base * (1 + REDIAL_JITTER_FRAC * (2 * this.random() - 1)));
	}

	private noteFatal(fatal: FatalClose): void {
		this.fatalUntil = this.now() + this.fatalBackoffMs;
		this.fatalReported = true;
		this.deps.log(
			`[UpstreamRecovery] fatal close (${fatal.category}); no dial for ${Math.round(this.fatalBackoffMs / 1000)}s`,
		);
		this.activeSilence?.handleFatalBackoff(this.fatalUntil);
		this.safe('onFatal', () => this.options.onFatal?.({ ...fatal, until: this.fatalUntil }));
	}

	/** Schedule the next ladder dial at `at`, or later if a fatal backoff says so. */
	private scheduleDial(at: number): void {
		this.nextDialAt = Math.max(at, this.fatalUntil);
		this.armDialTimer(this.nextDialAt - this.now());
	}

	private armDialTimer(delayMs: number): void {
		this.clearDialTimer();
		this.dialTimer = setTimeout(() => this.fireLadderDial(), Math.max(0, delayMs));
	}

	private fireLadderDial(): void {
		this.dialTimer = null;
		if (this.disposed) return;
		const now = this.now();
		if (this.nextDialAt === 0) return;
		// A timer can fire a little before the clock reaches its deadline: wait out the rest.
		if (now < this.nextDialAt) {
			this.armDialTimer(this.nextDialAt - now);
			return;
		}
		if (this.activeSilence?.ownsRecovery === true || this.hostParked) return;
		if (this.deps.getState() !== 'UPSTREAM_LOST' || !this.hasAudience()) {
			// Not parked, or nobody to talk to: the next park, an attach or the
			// health tick takes over.
			return;
		}
		if (this.inFatalBackoff()) {
			this.armDialTimer(this.fatalUntil - now + 100);
			return;
		}
		this.dial('redial-ladder');
	}

	/** Redial; `false` when `recoverUpstream()` refused synchronously. */
	private dial(origin: string): boolean {
		this.nextDialAt = 0;
		this.lastDialAt = this.now();
		this.clearDialTimer();
		try {
			this.deps
				.recoverUpstream({
					reason: 'human-retry',
					skipContextInjection: false,
					holdSyntheticUntilFreshSpeech: this.options.holdSyntheticUntilFreshSpeech ?? false,
				})
				.activated.catch((err: unknown) =>
					this.deps.log(
						`[UpstreamRecovery] ${origin}: recovery did not activate: ${err instanceof Error ? err.message : String(err)}`,
					),
				);
			return true;
		} catch (err) {
			this.deps.log(
				`[UpstreamRecovery] ${origin}: recoverUpstream threw: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	private armIdlePark(): void {
		if (this.idleParkMs <= 0 || this.disposed) return;
		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			void this.parkIdle();
		}, this.idleParkMs);
	}

	private async parkIdle(): Promise<void> {
		if (this.disposed || this.hasAudience()) return;
		const state = this.deps.getState();
		if (state !== 'ACTIVE' && state !== 'RECONNECTING') {
			// Still dialing: look again later, so a session that comes up with nobody there is parked.
			if (state === 'CONNECTING') this.armIdlePark();
			return;
		}
		this.deps.log('[UpstreamRecovery] nobody there; parking the upstream until a client attaches');
		try {
			await this.deps.parkUpstream('idle');
		} catch (err) {
			this.deps.log(
				`[UpstreamRecovery] idle park failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private clearDialTimer(): void {
		if (this.dialTimer) clearTimeout(this.dialTimer);
		this.dialTimer = null;
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private safe(hook: string, fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.deps.log(
				`[UpstreamRecovery] ${hook} threw: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
