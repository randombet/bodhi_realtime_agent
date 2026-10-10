// SPDX-License-Identifier: MIT

/**
 * Active-silence recovery: a connected session whose model stays silent after
 * the user spoke is redialed, a bounded number of times, and the client is
 * told when that is spent. Owned by {@link UpstreamRecoveryPolicy}; enabled
 * with `upstreamRecovery.activeSilence`.
 *
 * The state machine ({@link reduceRecovery}) is a pure reducer over events in
 * one clock domain. Its rules:
 * - a qualifying tick needs an ACTIVE session, an attached client, no
 *   dictation, user speech since the last model progress, microphone frames
 *   in the window, nothing from the model for 15 s, and no foreground tool;
 * - `requiredTicks` consecutive qualifying ticks (default 3) authorize a
 *   redial, once the user has been quiet for 2 s, no sooner than 60 s after
 *   the previous attempt and never inside a fatal backoff;
 * - three attempts per episode, then `terminal`: the client gets
 *   `voice-stalled`, and `voice.retryUpstream` starts one more;
 * - a model response on the current connection ends the episode.
 *
 * Events carry the transport generation (and the client epoch) they belong
 * to, so a stale event from a replaced connection or a detached client never
 * moves the state.
 */

import type { ConnectionLifecycleEvent } from '../types/transport.js';
import type { RecoverUpstreamArgs, RecoverUpstreamResult } from './host-recovery.js';

export const DEFAULT_ACTIVE_SILENCE_TICKS = 3; // >=75s continuous silence
export const MIN_ACTIVE_SILENCE_TICKS = 2; // floor >=45s
export const MAX_ACTIVE_SILENCE_TICKS = 40; // cap ~20min
export const QUIESCENCE_MS = 2_000;
export const ATTEMPT_COOLDOWN_MS = 60_000;
export const EPISODE_ATTEMPT_LIMIT = 3;
export const SILENCE_TICK_MIN_MS = 15_000;

/** Per-tick facts the trigger consumes. */
export interface ActiveSilenceFacts {
	factsAvailable: boolean;
	speechInWindow: boolean;
	speechObservedAt: number | null;
	ingressAdvanced: boolean;
	modelSilentFor15s: boolean;
}

export type RecoveryPhase = 'idle' | 'restarting' | 'waiting-retry' | 'terminal';
export type RecoveryEffect =
	| 'none'
	| 'restart'
	| 'notify-stalled'
	| 'record-only'
	| 'schedule-retry';

// All `at`/`until` values share one process-local monotonic clock domain.
export interface RecoveryState {
	phase: RecoveryPhase;
	origin: 'active-silence' | null;
	currentTransportEpoch: number | null;
	currentClientEpoch: number | null; // retained across detach as a stale-event fence
	clientAttached: boolean;
	streak: number;
	speechLatched: boolean;
	firstSpeechAt: number | null;
	lastAboveFloorAt: number | null;
	silenceAnchorAt: number | null;
	meetingMode: boolean;
	episodeAttempts: number; // consumed at restart AUTHORIZATION
	lastActionAt: number | null;
	retryNotBefore: number | null;
	attemptEpoch: number;
	backoffUntil: number;
}

export type RecoveryEvent =
	| {
			kind: 'tick';
			at: number;
			state: string;
			facts: ActiveSilenceFacts;
			pendingToolCount: number;
			requiredTicks?: number;
	  }
	| { kind: 'speechObserved'; at: number }
	| { kind: 'meetingModeChanged'; active: boolean; at: number }
	| { kind: 'clientAttached'; clientEpoch: number; at: number }
	| { kind: 'clientDetached'; clientEpoch: number; at: number }
	| { kind: 'transportActive'; transportEpoch: number; attemptEpoch: number | null; at: number }
	| { kind: 'closedObserved'; transportEpoch: number; attemptEpoch: number | null; at: number }
	| { kind: 'dialFailed'; attemptEpoch: number; at: number }
	| { kind: 'retryDue'; attemptEpoch: number; at: number }
	| { kind: 'modelEvent'; at: number; transportEpoch: number }
	| { kind: 'toolOutcome'; at: number; transportEpoch: number }
	| {
			kind: 'userVisibleResponse';
			at: number;
			transportEpoch: number;
			clientEpoch: number;
			channel: 'audio-egress' | 'typed-tool-route';
	  }
	| { kind: 'fatalBackoff'; until: number }
	| { kind: 'fatalBackoffCleared'; at: number }
	| {
			kind: 'retry';
			stalledAttemptEpoch: number;
			clientEpoch: number;
			requestId: string;
			at: number;
	  };

export function initialRecoveryState(): RecoveryState {
	return {
		phase: 'idle',
		origin: null,
		currentTransportEpoch: null,
		currentClientEpoch: null,
		clientAttached: false,
		streak: 0,
		speechLatched: false,
		firstSpeechAt: null,
		lastAboveFloorAt: null,
		silenceAnchorAt: null,
		meetingMode: false,
		episodeAttempts: 0,
		lastActionAt: null,
		retryNotBefore: null,
		attemptEpoch: 0,
		backoffUntil: 0,
	};
}

function maxOf(a: number | null, b: number): number {
	return a === null ? b : Math.max(a, b);
}

/** "Full reset" per the design: keep identities + meeting mode, clear the episode. */
function fullReset(s: RecoveryState): RecoveryState {
	return {
		...s,
		phase: 'idle',
		origin: null,
		streak: 0,
		speechLatched: false,
		firstSpeechAt: null,
		lastAboveFloorAt: null,
		silenceAnchorAt: null,
		episodeAttempts: 0,
		retryNotBefore: null,
	};
}

function authorize(s: RecoveryState, at: number): { state: RecoveryState; effect: RecoveryEffect } {
	return {
		state: {
			...s,
			phase: 'restarting',
			origin: 'active-silence',
			episodeAttempts: s.episodeAttempts + 1,
			attemptEpoch: s.attemptEpoch + 1,
			lastActionAt: at,
			retryNotBefore: null,
		},
		effect: 'restart',
	};
}

function toWaitingRetry(s: RecoveryState): { state: RecoveryState; effect: RecoveryEffect } {
	const notBefore = Math.max((s.lastActionAt ?? 0) + ATTEMPT_COOLDOWN_MS, s.backoffUntil);
	return {
		state: { ...s, phase: 'waiting-retry', retryNotBefore: notBefore },
		effect: 'schedule-retry',
	};
}

export function reduceRecovery(
	s: RecoveryState,
	ev: RecoveryEvent,
): { state: RecoveryState; effect: RecoveryEffect } {
	const none = (state: RecoveryState) => ({ state, effect: 'none' as RecoveryEffect });
	const recordOnly = { state: s, effect: 'record-only' as RecoveryEffect };

	switch (ev.kind) {
		case 'fatalBackoff': {
			const backoffUntil = Math.max(s.backoffUntil, ev.until);
			if (s.phase === 'waiting-retry') {
				const retryNotBefore = Math.max(s.retryNotBefore ?? 0, backoffUntil);
				return { state: { ...s, backoffUntil, retryNotBefore }, effect: 'schedule-retry' };
			}
			return none({ ...s, backoffUntil });
		}
		case 'fatalBackoffCleared': {
			if (s.phase === 'waiting-retry') {
				const retryNotBefore = (s.lastActionAt ?? 0) + ATTEMPT_COOLDOWN_MS;
				return { state: { ...s, backoffUntil: 0, retryNotBefore }, effect: 'schedule-retry' };
			}
			return none({ ...s, backoffUntil: 0 });
		}
		case 'meetingModeChanged': {
			if (ev.active) {
				return none({
					...s,
					meetingMode: true,
					speechLatched: false,
					firstSpeechAt: null,
					lastAboveFloorAt: null,
					streak: 0,
				});
			}
			return none({ ...s, meetingMode: false });
		}
		case 'speechObserved': {
			if (s.meetingMode) return none(s);
			if (!s.speechLatched) {
				return none({
					...s,
					speechLatched: true,
					firstSpeechAt: ev.at,
					lastAboveFloorAt: ev.at,
					silenceAnchorAt: maxOf(s.silenceAnchorAt, ev.at),
				});
			}
			return none({ ...s, lastAboveFloorAt: ev.at });
		}
		case 'clientAttached': {
			if (s.currentClientEpoch !== null && ev.clientEpoch <= s.currentClientEpoch)
				return recordOnly;
			const attached = { ...s, currentClientEpoch: ev.clientEpoch, clientAttached: true };
			if (s.phase === 'terminal') return { state: attached, effect: 'notify-stalled' };
			if (
				s.phase === 'waiting-retry' &&
				s.retryNotBefore !== null &&
				ev.at >= s.retryNotBefore &&
				ev.at >= s.backoffUntil
			) {
				return { state: attached, effect: 'schedule-retry' };
			}
			return none(attached);
		}
		case 'clientDetached': {
			if (ev.clientEpoch !== s.currentClientEpoch) return recordOnly;
			if (s.phase === 'terminal') return none({ ...s, clientAttached: false });
			return none({
				...s,
				clientAttached: false,
				speechLatched: false,
				firstSpeechAt: null,
				lastAboveFloorAt: null,
				streak: 0,
			});
		}
		case 'modelEvent':
		case 'toolOutcome': {
			if (ev.transportEpoch !== s.currentTransportEpoch) return recordOnly;
			return none({ ...s, silenceAnchorAt: maxOf(s.silenceAnchorAt, ev.at), streak: 0 });
		}
		case 'userVisibleResponse': {
			if (ev.transportEpoch !== s.currentTransportEpoch) return recordOnly;
			if (!s.clientAttached || ev.clientEpoch !== s.currentClientEpoch) return recordOnly;
			return none(fullReset(s));
		}
		case 'transportActive': {
			const newer = s.currentTransportEpoch === null || ev.transportEpoch > s.currentTransportEpoch;
			if (ev.attemptEpoch !== null) {
				// Watchdog-correlated activation: must be the in-flight attempt AND
				// a strictly newer transport generation.
				if (ev.attemptEpoch !== s.attemptEpoch || s.phase !== 'restarting' || !newer)
					return recordOnly;
				return none({
					...s,
					currentTransportEpoch: ev.transportEpoch,
					phase: 'idle',
					streak: 0,
					silenceAnchorAt: ev.at,
					retryNotBefore: null,
				});
			}
			// Ordinary/initial activation: strictly newer, and never mid-restart
			// (a null-attempt activation cannot end a watchdog attempt).
			if (!newer || s.phase === 'restarting') return recordOnly;
			if (s.phase === 'terminal') {
				return none({
					...s,
					currentTransportEpoch: ev.transportEpoch,
					silenceAnchorAt: maxOf(s.silenceAnchorAt, ev.at),
				});
			}
			return none({
				...s,
				currentTransportEpoch: ev.transportEpoch,
				phase: 'idle',
				streak: 0,
				silenceAnchorAt: ev.at,
				retryNotBefore: null,
			});
		}
		case 'closedObserved': {
			if (ev.transportEpoch !== s.currentTransportEpoch) return recordOnly;
			if (s.phase === 'restarting' && ev.attemptEpoch === s.attemptEpoch) return none(s);
			if (s.phase === 'waiting-retry' || s.phase === 'terminal') return none(s);
			if (s.phase === 'idle' && s.origin === 'active-silence') {
				if (s.episodeAttempts >= EPISODE_ATTEMPT_LIMIT) {
					return { state: { ...s, phase: 'terminal' }, effect: 'notify-stalled' };
				}
				return toWaitingRetry(s);
			}
			return none(s); // ordinary-CLOSED sessions belong to the existing guard
		}
		case 'dialFailed': {
			if (ev.attemptEpoch !== s.attemptEpoch || s.phase !== 'restarting') return recordOnly;
			if (s.episodeAttempts >= EPISODE_ATTEMPT_LIMIT) {
				return { state: { ...s, phase: 'terminal' }, effect: 'notify-stalled' };
			}
			return toWaitingRetry(s);
		}
		case 'retryDue': {
			if (ev.attemptEpoch !== s.attemptEpoch || s.phase !== 'waiting-retry') return recordOnly;
			if (
				!s.clientAttached ||
				(s.retryNotBefore !== null && ev.at < s.retryNotBefore) ||
				ev.at < s.backoffUntil
			) {
				return none(s);
			}
			if (s.episodeAttempts >= EPISODE_ATTEMPT_LIMIT) {
				return { state: { ...s, phase: 'terminal' }, effect: 'notify-stalled' };
			}
			return authorize(s, ev.at);
		}
		case 'retry': {
			if (s.phase !== 'terminal') return recordOnly;
			if (ev.stalledAttemptEpoch !== s.attemptEpoch) return recordOnly;
			if (!s.clientAttached || ev.clientEpoch !== s.currentClientEpoch) return recordOnly;
			const fresh: RecoveryState = { ...s, episodeAttempts: 0, origin: 'active-silence' };
			if (ev.at < s.backoffUntil) {
				// Residue-6 decision: human retry never overrides fatal backoff.
				const parked = {
					...fresh,
					phase: 'waiting-retry' as RecoveryPhase,
					retryNotBefore: s.backoffUntil,
					episodeAttempts: 0,
				};
				return { state: parked, effect: 'schedule-retry' };
			}
			return authorize(fresh, ev.at);
		}
		case 'tick': {
			if (s.phase !== 'idle') return none(s);
			const f = ev.facts;
			const qualifies =
				ev.state === 'ACTIVE' &&
				s.clientAttached &&
				!s.meetingMode &&
				s.speechLatched &&
				f.factsAvailable &&
				f.ingressAdvanced &&
				f.modelSilentFor15s &&
				s.silenceAnchorAt !== null &&
				ev.at - s.silenceAnchorAt > SILENCE_TICK_MIN_MS &&
				ev.pendingToolCount === 0;
			if (!qualifies) return none({ ...s, streak: 0 });

			const required = ev.requiredTicks ?? DEFAULT_ACTIVE_SILENCE_TICKS;
			const streak = Math.min(s.streak + 1, required);
			if (streak < required) return none({ ...s, streak });

			// Threshold reached: authorization vetoes cap the streak, never reset it.
			const quiescent = s.lastAboveFloorAt !== null && ev.at - s.lastAboveFloorAt >= QUIESCENCE_MS;
			const cooldownOk = s.lastActionAt === null || ev.at - s.lastActionAt > ATTEMPT_COOLDOWN_MS;
			const backoffOk = ev.at >= s.backoffUntil;
			if (!quiescent || !cooldownOk || !backoffOk) return none({ ...s, streak: required });
			if (s.episodeAttempts >= EPISODE_ATTEMPT_LIMIT) {
				return { state: { ...s, streak: required, phase: 'terminal' }, effect: 'notify-stalled' };
			}
			return authorize({ ...s, streak: required }, ev.at);
		}
	}
}

// --- The driver ----------------------------------------------------------

/** `voice.retryUpstream` v1, the client's retry command for a stalled voice. */
export interface RetryUpstreamCommand {
	type: 'voice.retryUpstream';
	version: 1;
	voiceSessionId: string;
	clientEpoch: number;
	stalledAttemptEpoch: number;
	requestId: string;
}

const RETRY_KEYS = [
	'type',
	'version',
	'voiceSessionId',
	'clientEpoch',
	'stalledAttemptEpoch',
	'requestId',
] as const;

const isInt = (v: unknown, min: number): v is number =>
	typeof v === 'number' && Number.isInteger(v) && v >= min;

/** Parse `voice.retryUpstream` v1 exactly (no extra keys); `null` otherwise. */
export function parseRetryUpstreamCommand(msg: unknown): RetryUpstreamCommand | null {
	if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null;
	const m = msg as Record<string, unknown>;
	if (Object.keys(m).length !== RETRY_KEYS.length) return null;
	if (!RETRY_KEYS.every((k) => k in m)) return null;
	if (m.type !== 'voice.retryUpstream' || m.version !== 1) return null;
	if (typeof m.voiceSessionId !== 'string' || m.voiceSessionId.length < 1) return null;
	if (!isInt(m.clientEpoch, 0)) return null;
	if (!isInt(m.stalledAttemptEpoch, 1)) return null;
	// Length in characters (code points), not UTF-16 units.
	if (typeof m.requestId !== 'string') return null;
	const requestIdChars = Array.from(m.requestId).length;
	if (requestIdChars < 1 || requestIdChars > 128) return null;
	return m as unknown as RetryUpstreamCommand;
}

/** How long the model must have produced nothing for a tick to count. */
export const MODEL_SILENT_MS = 15_000;
const ACK_CACHE_CAP = 64;

export interface ActiveSilenceDeps {
	/** The session id the stalled frame and the retry command carry. */
	voiceSessionId: string;
	recoverUpstream(args: RecoverUpstreamArgs): RecoverUpstreamResult;
	sendJsonToClient(message: Record<string, unknown>): void;
	log(message: string): void;
	now: () => number;
}

/**
 * Recovers a session that is connected but silent: the user spoke, audio
 * keeps arriving, the model has produced nothing, no tool is running, and
 * this has held for `requiredTicks` consecutive health ticks. It redials a
 * fresh connection (`reason: 'active-silence'`, nothing synthetic until the
 * user speaks again), at most {@link EPISODE_ATTEMPT_LIMIT} times per episode
 * and {@link ATTEMPT_COOLDOWN_MS} apart. When those are spent it tells the
 * client (`voice-stalled`), and a client `voice.retryUpstream` starts one
 * more attempt. Suspended while the session dictates. The decisions are the
 * pure {@link reduceRecovery}; this class feeds it and runs its effects.
 */
export class ActiveSilenceRecovery {
	private st: RecoveryState = initialRecoveryState();
	private clientEpochCounter = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private meeting = false;
	private stalledEnteredAt: number | null = null;
	/** reducer attemptEpoch -> session dial attemptEpoch, for setup-ok correlation. */
	private readonly dialByReducerEpoch = new Map<number, number>();
	/** Pending foreground tool calls, keyed `${transportEpoch}:${id}`. */
	private readonly pendingTools = new Map<string, number | null>();
	/** requestId -> ack frame; a duplicate re-sends the original ack. */
	private readonly ackByRequestId = new Map<string, Record<string, unknown>>();
	/** A retry accepted while a fatal backoff blocks dialing: its ack waits for
	 *  the dial, so it can name the attempt it started. */
	private parkedRetry: {
		requestId: string;
		clientEpoch: number;
		stalledAttemptEpoch: number;
	} | null = null;
	private prevTransportEpoch: number | null = null;
	private micFramesSinceTick = 0;
	private lastModelOutputAt: number | null = null;
	private stopped = false;

	constructor(
		private readonly deps: ActiveSilenceDeps,
		private readonly requiredTicks: number = DEFAULT_ACTIVE_SILENCE_TICKS,
	) {}

	/** While true this recovery owns the session's redials: any phase but
	 *  idle, or an idle episode it started. Other redial paths stand down. */
	get ownsRecovery(): boolean {
		if (this.stopped) return false;
		return this.st.phase !== 'idle' || this.st.origin === 'active-silence';
	}

	get phase(): RecoveryPhase {
		return this.st.phase;
	}

	stop(): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}

	// --- Feeds ---

	handleClientConnected(): void {
		this.clientEpochCounter += 1;
		this.dispatch({
			kind: 'clientAttached',
			clientEpoch: this.clientEpochCounter,
			at: this.deps.now(),
		});
	}

	handleClientDisconnected(): void {
		this.dispatch({
			kind: 'clientDetached',
			clientEpoch: this.clientEpochCounter,
			at: this.deps.now(),
		});
	}

	/** Transport truth: an activation (correlated to this recovery's dial by
	 *  the attempt id) or the close of a generation. */
	handleLifecycle(ev: ConnectionLifecycleEvent): void {
		if (ev.kind === 'setup-ok') {
			// A fresh connection is the baseline the model's silence counts from.
			this.lastModelOutputAt = this.deps.now();
			const dialGen = Number(ev.connectAttemptId.replace(/^att_/, ''));
			let reducerEpoch: number | null = null;
			for (const [rEpoch, dEpoch] of this.dialByReducerEpoch) {
				if (dEpoch === dialGen) reducerEpoch = rEpoch;
			}
			this.dispatch({
				kind: 'transportActive',
				transportEpoch: ev.transportGeneration,
				attemptEpoch: reducerEpoch,
				at: this.deps.now(),
			});
			return;
		}
		if (ev.kind === 'generation-close') {
			this.dispatch({
				kind: 'closedObserved',
				transportEpoch: ev.transportGeneration,
				attemptEpoch: null,
				at: this.deps.now(),
			});
		}
	}

	/** The user spoke (a completed, voiced segment). */
	noteSpeech(): void {
		this.dispatch({ kind: 'speechObserved', at: this.deps.now() });
	}

	/** A microphone frame arrived. */
	noteMicFrame(): void {
		this.micFramesSinceTick += 1;
	}

	/** The model started a turn: progress, which re-anchors the silence. */
	noteModelEvent(transportGeneration?: number): void {
		this.lastModelOutputAt = this.deps.now();
		const epoch = transportGeneration ?? this.st.currentTransportEpoch;
		if (epoch === null) return;
		this.dispatch({ kind: 'modelEvent', at: this.deps.now(), transportEpoch: epoch });
	}

	/** The model finished a turn: the user got an answer, which ends the episode. */
	noteResponse(): void {
		this.lastModelOutputAt = this.deps.now();
		const transportEpoch = this.st.currentTransportEpoch;
		const clientEpoch = this.st.currentClientEpoch;
		if (transportEpoch === null || clientEpoch === null) return;
		this.dispatch({
			kind: 'userVisibleResponse',
			at: this.deps.now(),
			transportEpoch,
			clientEpoch,
			channel: 'audio-egress',
		});
	}

	noteMeetingMode(active: boolean): void {
		if (active === this.meeting) return;
		this.meeting = active;
		this.dispatch({ kind: 'meetingModeChanged', active, at: this.deps.now() });
	}

	/** A foreground tool started: the model is working, not silent. */
	noteToolCall(toolCallId: string): void {
		this.pendingTools.set(
			`${this.st.currentTransportEpoch}:${toolCallId}`,
			this.st.currentTransportEpoch,
		);
	}

	noteToolSettled(toolCallId: string): void {
		// Resolve by the stored epoch, oldest first, so a late completion from
		// an old generation consumes its own entry, not the current one.
		let match: { key: string; epoch: number | null } | null = null;
		for (const [key, epoch] of this.pendingTools) {
			if (!key.endsWith(`:${toolCallId}`)) continue;
			if (match === null || (epoch ?? -1) < (match.epoch ?? -1)) match = { key, epoch };
		}
		if (match === null) return;
		this.pendingTools.delete(match.key);
		if (match.epoch !== null && match.epoch === this.st.currentTransportEpoch) {
			this.dispatch({ kind: 'toolOutcome', at: this.deps.now(), transportEpoch: match.epoch });
		}
	}

	handleFatalBackoff(until: number): void {
		this.dispatch({ kind: 'fatalBackoff', until });
	}

	handleFatalBackoffCleared(): void {
		this.dispatch({ kind: 'fatalBackoffCleared', at: this.deps.now() });
	}

	/** One health tick. */
	tick(sessionState: string): void {
		const at = this.deps.now();
		const ingressAdvanced = this.micFramesSinceTick > 0;
		this.micFramesSinceTick = 0;
		// No connection yet means no baseline: never silent.
		const modelSilentFor15s =
			this.lastModelOutputAt !== null && at - this.lastModelOutputAt >= MODEL_SILENT_MS;
		this.dispatch({
			kind: 'tick',
			at,
			state: sessionState,
			facts: {
				factsAvailable: true,
				speechInWindow: this.st.speechLatched,
				speechObservedAt: this.st.lastAboveFloorAt,
				ingressAdvanced,
				modelSilentFor15s,
			},
			pendingToolCount: this.pendingTools.size,
			requiredTicks: this.requiredTicks,
		});
	}

	/** A client command: returns true when it was a `voice.retryUpstream`
	 *  (handled here, not forwarded). */
	handleClientCommand(msg: Record<string, unknown>): boolean {
		if (msg?.type !== 'voice.retryUpstream') return false;
		if (this.stopped) return true;
		const cmd = parseRetryUpstreamCommand(msg);
		if (!cmd) {
			this.deps.log('[ActiveSilence] voice.retryUpstream rejected: schema');
			return true;
		}
		const cached = this.ackByRequestId.get(cmd.requestId);
		if (cached) {
			// A duplicate gets the original ack and never redials twice.
			this.deps.sendJsonToClient(cached);
			return true;
		}
		// A duplicate of the parked request has no ack yet.
		if (this.parkedRetry !== null && this.parkedRetry.requestId === cmd.requestId) return true;
		if (cmd.voiceSessionId !== this.deps.voiceSessionId) {
			this.sendAck(cmd, 'stale', null);
			return true;
		}
		if (this.st.phase !== 'terminal') {
			this.sendAck(cmd, 'not-terminal', null);
			return true;
		}
		const effect = this.dispatch({
			kind: 'retry',
			stalledAttemptEpoch: cmd.stalledAttemptEpoch,
			clientEpoch: cmd.clientEpoch,
			requestId: cmd.requestId,
			at: this.deps.now(),
		});
		if (effect === 'restart') {
			this.sendAck(cmd, 'accepted', this.st.attemptEpoch);
		} else if (effect === 'schedule-retry') {
			this.parkedRetry = {
				requestId: cmd.requestId,
				clientEpoch: cmd.clientEpoch,
				stalledAttemptEpoch: cmd.stalledAttemptEpoch,
			};
		} else {
			this.sendAck(cmd, 'stale', null);
		}
		return true;
	}

	// --- Effects ---

	private dispatch(ev: RecoveryEvent): RecoveryEffect {
		if (this.stopped) return 'none';
		const { state, effect } = reduceRecovery(this.st, ev);
		const prevPhase = this.st.phase;
		this.st = state;
		if (state.phase === 'terminal' && prevPhase !== 'terminal') {
			this.stalledEnteredAt = this.deps.now();
			this.parkedRetry = null;
		}
		// A successor generation strands the previous generation's tools.
		if (ev.kind === 'transportActive' && state.currentTransportEpoch !== this.prevTransportEpoch) {
			for (const [key, epoch] of this.pendingTools) {
				if (epoch !== state.currentTransportEpoch) this.pendingTools.delete(key);
			}
		}
		this.prevTransportEpoch = state.currentTransportEpoch;
		switch (effect) {
			case 'restart':
				this.executeRestart(ev.kind === 'retry' ? 'human-retry' : 'active-silence');
				break;
			case 'schedule-retry':
				this.armRetryTimer();
				break;
			case 'notify-stalled':
				this.pushStalled();
				break;
			default:
				break;
		}
		return effect;
	}

	private executeRestart(trigger: 'active-silence' | 'human-retry'): void {
		let reason = trigger;
		const reducerEpoch = this.st.attemptEpoch;
		const parked = this.parkedRetry;
		if (parked !== null) {
			reason = 'human-retry';
			this.parkedRetry = null;
			this.sendAck(parked, 'accepted', reducerEpoch);
		}
		let result: RecoverUpstreamResult;
		try {
			result = this.deps.recoverUpstream({
				reason,
				skipContextInjection: true,
				holdSyntheticUntilFreshSpeech: true,
			});
		} catch (err) {
			this.deps.log(
				`[ActiveSilence] recoverUpstream threw: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.dispatch({ kind: 'dialFailed', attemptEpoch: reducerEpoch, at: this.deps.now() });
			return;
		}
		this.dialByReducerEpoch.set(reducerEpoch, result.attemptEpoch);
		if (this.dialByReducerEpoch.size > 8) {
			const oldest = this.dialByReducerEpoch.keys().next().value;
			if (oldest !== undefined) this.dialByReducerEpoch.delete(oldest);
		}
		this.pendingTools.clear();
		result.activated.catch(() => {
			this.dispatch({ kind: 'dialFailed', attemptEpoch: reducerEpoch, at: this.deps.now() });
		});
		this.deps.log(
			`[ActiveSilence] redial (${reason}): attempt ${reducerEpoch}, dial ${result.attemptEpoch}`,
		);
	}

	private armRetryTimer(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		const epoch = this.st.attemptEpoch;
		const delay = Math.max(0, (this.st.retryNotBefore ?? 0) - this.deps.now());
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.dispatch({ kind: 'retryDue', attemptEpoch: epoch, at: this.deps.now() });
		}, delay);
	}

	private pushStalled(): void {
		if (!this.st.clientAttached) return;
		this.deps.sendJsonToClient({
			type: 'voice-stalled',
			version: 1,
			voiceSessionId: this.deps.voiceSessionId,
			clientEpoch: this.st.currentClientEpoch ?? 0,
			stalledAttemptEpoch: this.st.attemptEpoch,
			episodeAttempts: EPISODE_ATTEMPT_LIMIT,
			reason: 'active-silence-attempts-exhausted',
			enteredAtUnixMs: this.stalledEnteredAt ?? this.deps.now(),
		});
		this.deps.log(`[ActiveSilence] voice-stalled sent (attempt ${this.st.attemptEpoch})`);
	}

	private sendAck(
		cmd: { requestId: string; clientEpoch: number; stalledAttemptEpoch: number },
		disposition: 'accepted' | 'stale' | 'not-terminal',
		acceptedAttemptEpoch: number | null,
	): void {
		const ack: Record<string, unknown> = {
			type: 'voice.retryUpstream.ack',
			version: 1,
			voiceSessionId: this.deps.voiceSessionId,
			clientEpoch: cmd.clientEpoch,
			requestId: cmd.requestId,
			stalledAttemptEpoch: cmd.stalledAttemptEpoch,
			disposition,
			acceptedAttemptEpoch,
		};
		this.ackByRequestId.set(cmd.requestId, ack);
		if (this.ackByRequestId.size > ACK_CACHE_CAP) {
			for (const [key, cached] of this.ackByRequestId) {
				if (cached.disposition !== 'accepted') {
					this.ackByRequestId.delete(key);
					break;
				}
			}
		}
		this.deps.sendJsonToClient(ack);
	}
}
