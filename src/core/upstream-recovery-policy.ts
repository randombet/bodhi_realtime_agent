// SPDX-License-Identifier: MIT

/**
 * When to redial a lost upstream, in one place. `HostRecoveryController` owns
 * how a session redials (`recoverUpstream()`) and parks (`parkUpstream()`);
 * this policy owns when, so a host no longer re-implements the same timers,
 * gates and classifiers around those two calls. It needs
 * `upstreamLossPolicy: 'hold'` and works in both orchestration modes.
 *
 * What it does:
 * - **Redial ladder**: a terminal loss (a remote `generation-close`, or
 *   `setup-failed`) schedules a dial after 1 s, 2 s, 4 s, ... capped at 60 s
 *   and jittered ±20%. A `setup-ok` resets the ladder only once that
 *   connection proved stable (no close for 30 s), so a connection that dies
 *   every few seconds keeps backing off. A dial fires only while the session
 *   is parked in `UPSTREAM_LOST` with a client attached.
 * - **Fatal backoff**: a close the classifier calls non-retryable (quota,
 *   depleted credits, invalid key, unknown model) blocks every dial for
 *   `fatalBackoffMs`; reaching `ACTIVE` clears it.
 * - **Stuck dial**: a session in `CONNECTING` for `stuckConnectingMs` with a
 *   client attached has its dial replaced by `recoverUpstream()`.
 * - **Health tick**: every `healthTickMs`, a parked session with a client
 *   attached is redialed if the ladder missed it (at most once a minute).
 * - **Idle park**: with no client attached for `idleParkMs`, the upstream is
 *   parked; the next client attach redials it (the session's attach path).
 * - **Attach gate**: while a fatal backoff is pending and the reconnector is
 *   already redialing, a client attach does not add a dial of its own.
 *
 * Presentation stays with the host: `onFatal` and `onRecovered` report the
 * edges, and the host decides what the user sees.
 */

import type { SessionState } from '../types/session.js';
import type { ConnectionLifecycleEvent } from '../types/transport.js';
import type { RecoverUpstreamArgs } from './host-recovery.js';

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
	/** How long a fatal close blocks dialing. Default 300000 ms (5 min). */
	fatalBackoffMs?: number;
	/** Close classifier. Default {@link classifyGeminiClose}. */
	classifyClose?: CloseClassifier;
	/** How long a client-attached session may stay in `CONNECTING` before its
	 *  dial is replaced. Default 120000 ms; `0` disables; a positive value
	 *  below 60000 ms is raised to 60000 ms, twice the dial deadline. */
	stuckConnectingMs?: number;
	/** Health tick period. Default 30000 ms; `0` disables the tick (and with it
	 *  the stuck-dial check and the backstop redial). */
	healthTickMs?: number;
	/** Park the upstream after this long with no client attached. Default
	 *  60000 ms; `0` disables. */
	idleParkMs?: number;
	/** A fatal close started a backoff. */
	onFatal?: (close: FatalClose & { until: number }) => void;
	/** The session reached `ACTIVE` after a fatal close was reported. */
	onRecovered?: () => void;
}

export interface UpstreamRecoveryDeps {
	getState(): SessionState;
	isClientConnected(): boolean;
	/** `VoiceSession.recoverUpstream()`; a synchronous throw is logged. */
	recoverUpstream(reason: RecoverUpstreamArgs['reason']): void;
	/** `VoiceSession.parkUpstream()`. */
	parkUpstream(reason: string): Promise<void>;
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

/** Non-retryable Gemini Live close reasons. Anything else is retryable. */
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
	private readonly fatalBackoffMs: number;
	private readonly stuckConnectingMs: number;
	private readonly healthTickMs: number;
	private readonly idleParkMs: number;
	private readonly classify: CloseClassifier;
	private readonly now: () => number;
	private readonly random: () => number;

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
		this.fatalBackoffMs = options.fatalBackoffMs ?? 300_000;
		const stuck = options.stuckConnectingMs ?? 120_000;
		this.stuckConnectingMs = stuck > 0 ? Math.max(stuck, MIN_STUCK_CONNECTING_MS) : 0;
		this.healthTickMs = options.healthTickMs ?? 30_000;
		this.idleParkMs = options.idleParkMs ?? 60_000;
		this.classify = options.classifyClose ?? classifyGeminiClose;
		this.now = deps.now ?? Date.now;
		this.random = deps.random ?? Math.random;
	}

	/** Start the health tick and, with no client attached yet, the idle clock. */
	start(): void {
		if (this.disposed) return;
		if (this.healthTickMs > 0 && !this.tickTimer) {
			this.tickTimer = setInterval(() => this.tick(), this.healthTickMs);
		}
		if (!this.deps.isClientConnected()) this.armIdlePark();
	}

	dispose(): void {
		this.disposed = true;
		this.clearDialTimer();
		this.clearIdleTimer();
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = null;
	}

	/** Whether a fatal backoff blocks dialing now. */
	inFatalBackoff(): boolean {
		return this.now() < this.fatalUntil;
	}

	/**
	 * The attach gate: `true` while a fatal backoff is pending and the
	 * reconnector is already redialing, so a client attach adds no dial of its
	 * own. A parked session still redials on attach.
	 */
	suppressAttachRedial(): boolean {
		return this.deps.getState() === 'RECONNECTING' && this.inFatalBackoff();
	}

	/** A transport connection-lifecycle event. */
	onLifecycle(ev: ConnectionLifecycleEvent): void {
		if (this.disposed) return;
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
			case 'attempt-close':
				// The failed-dial verdict is the `setup-failed` that follows.
				return;
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
				this.nextDialAt = Math.max(now + this.backoffDelayMs(this.failures), this.fatalUntil);
				this.armDialTimer(this.nextDialAt - now);
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
		this.fatalUntil = 0;
		if (this.fatalReported) {
			this.fatalReported = false;
			this.safe('onRecovered', () => this.options.onRecovered?.());
		}
	}

	onClientConnected(): void {
		this.clearIdleTimer();
	}

	onClientDisconnected(): void {
		this.armIdlePark();
	}

	/** One health tick: replace a stuck dial, then the backstop redial. */
	tick(): void {
		if (this.disposed) return;
		const now = this.now();
		const state = this.deps.getState();
		const client = this.deps.isClientConnected();
		if (
			state === 'CONNECTING' &&
			this.stuckConnectingMs > 0 &&
			this.connectingSince > 0 &&
			client &&
			now - this.connectingSince > this.stuckConnectingMs &&
			now - this.lastDialAt > BACKSTOP_MIN_INTERVAL_MS &&
			!this.inFatalBackoff()
		) {
			const stuckForS = Math.round((now - this.connectingSince) / 1000);
			this.deps.log(`[UpstreamRecovery] stuck in CONNECTING for ${stuckForS}s; replacing the dial`);
			this.connectingSince = 0;
			this.dial('stuck-connecting');
			return;
		}
		if (
			state === 'UPSTREAM_LOST' &&
			client &&
			now >= this.nextDialAt &&
			now - this.lastDialAt > BACKSTOP_MIN_INTERVAL_MS &&
			!this.inFatalBackoff()
		) {
			this.deps.log(
				'[UpstreamRecovery] health tick: parked session with a client attached; redialing',
			);
			this.dial('health-tick');
		}
	}

	// --- Internals ---

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
		this.safe('onFatal', () => this.options.onFatal?.({ ...fatal, until: this.fatalUntil }));
	}

	private armDialTimer(delayMs: number): void {
		this.clearDialTimer();
		this.dialTimer = setTimeout(() => this.fireLadderDial(), Math.max(0, delayMs));
	}

	private fireLadderDial(): void {
		this.dialTimer = null;
		if (this.disposed) return;
		const now = this.now();
		if (this.nextDialAt === 0 || now < this.nextDialAt) return;
		if (this.deps.getState() !== 'UPSTREAM_LOST' || !this.deps.isClientConnected()) {
			// Not parked, or nobody to talk to: the next lifecycle event, an
			// attach or the health tick takes over.
			return;
		}
		if (this.inFatalBackoff()) {
			this.armDialTimer(this.fatalUntil - now + 100);
			return;
		}
		this.dial('redial-ladder');
	}

	private dial(origin: string): void {
		this.nextDialAt = 0;
		this.lastDialAt = this.now();
		this.clearDialTimer();
		try {
			this.deps.recoverUpstream('human-retry');
		} catch (err) {
			this.deps.log(
				`[UpstreamRecovery] ${origin}: recoverUpstream threw: ${err instanceof Error ? err.message : String(err)}`,
			);
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
		if (this.disposed || this.deps.isClientConnected()) return;
		const state = this.deps.getState();
		if (state !== 'ACTIVE' && state !== 'RECONNECTING') return;
		this.deps.log('[UpstreamRecovery] no client attached; parking the upstream until one attaches');
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
