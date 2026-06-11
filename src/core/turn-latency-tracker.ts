// SPDX-License-Identifier: MIT

import type { EventPayloadMap } from '../types/events.js';
import type { TurnLatencyDropReason, TurnLatencySegments } from '../types/hooks.js';
import type { IEventBus } from './event-bus.js';

/** Anchor candidate: a user-speech-end stamp awaiting attribution to a turn. */
interface Anchor {
	atMs: number;
	source: 'provider' | 'client-vad';
	/** Detected start edge of the same utterance (latest speech.user_started). */
	startAtMs: number | null;
}

/** Per-turn record, created by the turn's FIRST response.started. */
interface TurnRecord {
	turnId: string;
	origin: EventPayloadMap['response.started']['origin'];
	/** First response's start stamp (≈ provider processing end anchor). */
	startedAtMs: number;
	anchor: Anchor | null;
	/** First audio of the TURN (not re-stamped by follow-up responses). */
	firstAudioMs: number | null;
	interrupted: boolean;
}

interface RingEntry {
	topic: keyof EventPayloadMap;
	payload: unknown;
}

/** E2E samples outside [0, 10s] are dropped as implausible (design §11). */
const MAX_PLAUSIBLE_E2E_MS = 10_000;

/**
 * Correlates the raw latency facts published on the EventBus
 * (`speech.user_started/ended`, `response.started/first_audio`,
 * `turn.end`/`turn.interrupted`, `session.reset`) into per-turn latency
 * segments — the §11 observability design.
 *
 * **Async edge:** the synchronous bus handlers only append to a bounded ring
 * buffer (~ns on the emitting tick); the state machine runs on a `setImmediate`
 * drain, so metric processing never sits on the audio path. A single ring
 * preserves cross-topic ordering, which the sequence/epoch join depends on.
 *
 * Join rules (see the design doc for rationale):
 * - `speech.user_ended` carries no turnId (the turn is not born yet); the next
 *   `response.started` in ring order claims the pending anchor.
 * - Epoch tick = `turn.end` ONLY (`turn.interrupted` is metadata — interrupted
 *   turns publish both).
 * - An anchor whose speech START came after the active turn's
 *   `response.started` is a barge-in/next utterance: it becomes the pending
 *   anchor for the next epoch (promoted across the tick, never attached to the
 *   active turn, never stale-dropped).
 * - An anchor whose start preceded the active `response.started` may attach
 *   late to the active turn until its `turn.end` (provider replaces any
 *   client-VAD anchor; client-VAD never downgrades a provider anchor). This is
 *   slightly wider than the design's "client-VAD freezes at response start":
 *   client-VAD completion fires a silence-window AFTER the detected end edge,
 *   so the completion event often arrives post-response-start carrying a
 *   pre-response edge — the start guard (not arrival time) is what excludes
 *   echo/back-channel contamination.
 * - Ring overflow fails closed: counter + clear all state + suppress samples
 *   until the next `turn.end`/`session.reset` resync boundary.
 */
export class TurnLatencyTracker {
	private readonly ring: RingEntry[] = [];
	private drainScheduled = false;
	/** Permanently quiesced after session.reset(reason: 'close'). */
	private quiesced = false;
	/** Set on ring overflow; cleared at the next resync boundary. */
	private suppressUntilResync = false;

	private lastSpeechStart: { atMs: number; source: Anchor['source'] } | null = null;
	/** Anchor awaiting the next response.started. */
	private pendingAnchor: Anchor | null = null;
	/** Barge-in/next-utterance anchor, promoted across the next turn.end. */
	private nextTurnPendingAnchor: Anchor | null = null;
	/** True when an unclaimed pending anchor was discarded at the last tick —
	 *  distinguishes `stale_anchor` from `no_anchor` on the next finalize. */
	private anchorDiscardedAtTick = false;
	private current: TurnRecord | null = null;

	private readonly unsubscribes: Array<() => void> = [];

	constructor(
		private readonly deps: {
			sessionId: string;
			bus: IEventBus;
			/** Emit the computed segments (wired to the onTurnLatency hook). */
			emitLatency: (turnId: string, segments: TurnLatencySegments) => void;
			/** Emit a drop (wired to the onTurnLatencyDropped hook). */
			emitDrop: (reason: TurnLatencyDropReason, turnId?: string) => void;
			log: (msg: string) => void;
			ringCapacity?: number;
		},
	) {
		const sub = <T extends keyof EventPayloadMap>(topic: T) =>
			this.unsubscribes.push(deps.bus.subscribe(topic, (payload) => this.append(topic, payload)));
		sub('speech.user_started');
		sub('speech.user_ended');
		sub('response.started');
		sub('response.first_audio');
		sub('turn.interrupted');
		sub('turn.end');
		sub('session.reset');
	}

	/** Sync side of the async edge: bounded append + drain scheduling. */
	private append(topic: keyof EventPayloadMap, payload: unknown): void {
		if (this.quiesced) return;
		const cap = this.deps.ringCapacity ?? 256;
		if (this.ring.length >= cap) {
			// Fail closed: a gap in an ordered correlation stream could shift
			// epoch/turn state and produce a WRONG sample — never correlate
			// across a gap (design §11.3).
			this.ring.length = 0;
			this.clearInFlight();
			this.suppressUntilResync = true;
			this.deps.log('[TurnLatencyTracker] ring overflow — suppressing until resync');
			this.deps.emitDrop('overflow');
			return;
		}
		this.ring.push({ topic, payload });
		if (!this.drainScheduled) {
			this.drainScheduled = true;
			setImmediate(() => this.drain());
		}
	}

	/** Synchronously process everything buffered (used at session close). */
	flush(): void {
		this.drain();
	}

	/** Unsubscribe from the bus (session teardown). */
	dispose(): void {
		for (const u of this.unsubscribes) u();
		this.unsubscribes.length = 0;
		this.quiesced = true;
	}

	private drain(): void {
		this.drainScheduled = false;
		// Process a snapshot; events appended during processing get the next drain.
		while (this.ring.length > 0) {
			const entry = this.ring.shift();
			if (entry) this.process(entry);
		}
	}

	private clearInFlight(): void {
		this.current = null;
		this.pendingAnchor = null;
		this.nextTurnPendingAnchor = null;
		this.lastSpeechStart = null;
	}

	private process(entry: RingEntry): void {
		if (this.quiesced) return;
		switch (entry.topic) {
			case 'speech.user_started': {
				const p = entry.payload as EventPayloadMap['speech.user_started'];
				this.lastSpeechStart = { atMs: p.atMs, source: p.source };
				return;
			}
			case 'speech.user_ended': {
				if (this.suppressUntilResync) return;
				const p = entry.payload as EventPayloadMap['speech.user_ended'];
				this.onSpeechEnded({
					atMs: p.atMs,
					source: p.source,
					startAtMs: this.lastSpeechStart?.atMs ?? null,
				});
				return;
			}
			case 'response.started': {
				if (this.suppressUntilResync) return;
				const p = entry.payload as EventPayloadMap['response.started'];
				if (this.current === null) {
					// FIRST response of the turn claims the pending anchor.
					this.current = {
						turnId: p.turnId,
						origin: p.origin,
						startedAtMs: p.atMs,
						anchor: this.pendingAnchor,
						firstAudioMs: null,
						interrupted: false,
					};
					this.pendingAnchor = null;
					this.anchorDiscardedAtTick = false;
				}
				// Follow-up responses in the same turn: no re-stamping (first-
				// response-only; E2E includes tool time by definition).
				return;
			}
			case 'response.first_audio': {
				if (this.suppressUntilResync) return;
				const p = entry.payload as EventPayloadMap['response.first_audio'];
				if (this.current && this.current.firstAudioMs === null) {
					this.current.firstAudioMs = p.atMs;
				}
				return;
			}
			case 'turn.interrupted': {
				// Metadata only — NOT an epoch tick (interrupted turns also
				// publish turn.end; ticking on both would double-advance).
				if (this.current) this.current.interrupted = true;
				return;
			}
			case 'turn.end': {
				if (this.suppressUntilResync) {
					// Resync boundary after an overflow: state is already clear.
					this.suppressUntilResync = false;
					return;
				}
				this.finalizeTurn();
				return;
			}
			case 'session.reset': {
				const p = entry.payload as EventPayloadMap['session.reset'];
				const hadInFlight =
					this.current !== null ||
					this.pendingAnchor !== null ||
					this.nextTurnPendingAnchor !== null;
				if (hadInFlight) this.deps.emitDrop('reset', this.current?.turnId);
				this.clearInFlight();
				this.suppressUntilResync = false;
				if (p.reason === 'close') this.quiesced = true;
				return;
			}
			default:
				return;
		}
	}

	private onSpeechEnded(anchor: Anchor): void {
		const cur = this.current;
		// Barge-in / next utterance: speech STARTED after the active response
		// began → next-turn pending (the late-attach guard + promotion rule).
		if (cur && anchor.startAtMs !== null && anchor.startAtMs > cur.startedAtMs) {
			this.nextTurnPendingAnchor = this.preferAnchor(this.nextTurnPendingAnchor, anchor);
			return;
		}
		if (cur) {
			// Late attach to the ACTIVE turn (start guard passed or start unknown
			// with a pre-response end edge).
			if (
				anchor.startAtMs === null &&
				anchor.atMs > cur.startedAtMs &&
				anchor.source === 'client-vad'
			) {
				// Unknown start and the END edge itself is post-response-start:
				// cannot rule out echo — treat as next-turn pending.
				this.nextTurnPendingAnchor = this.preferAnchor(this.nextTurnPendingAnchor, anchor);
				return;
			}
			cur.anchor = this.preferAnchor(cur.anchor, anchor);
			return;
		}
		// No active response: pending for the next response.started.
		this.pendingAnchor = this.preferAnchor(this.pendingAnchor, anchor);
	}

	/** Anchor precedence: provider replaces anything; client-VAD never
	 *  downgrades a provider anchor; newer wins within the same source. */
	private preferAnchor(existing: Anchor | null, candidate: Anchor): Anchor {
		if (existing === null) return candidate;
		if (candidate.source === 'provider') return candidate;
		if (existing.source === 'provider') return existing;
		return candidate;
	}

	private finalizeTurn(): void {
		const cur = this.current;
		if (cur !== null) {
			this.emitForTurn(cur);
		}
		// Epoch tick: discard an unclaimed pre-response anchor; promote the
		// barge-in/next-utterance anchor into the new epoch.
		this.anchorDiscardedAtTick = this.pendingAnchor !== null;
		this.pendingAnchor = this.nextTurnPendingAnchor;
		this.nextTurnPendingAnchor = null;
		this.current = null;
	}

	private emitForTurn(cur: TurnRecord): void {
		// Tool-only / no-audio turns are NOT latency-eligible: no sample, no drop.
		if (cur.firstAudioMs === null) return;
		if (cur.anchor === null) {
			// Only user-audio turns can incur a missing-anchor drop — greetings,
			// text input, and continuations are not voice-latency-eligible.
			if (cur.origin === 'user_audio') {
				this.deps.emitDrop(this.anchorDiscardedAtTick ? 'stale_anchor' : 'no_anchor', cur.turnId);
			}
			return;
		}
		const e2e = cur.firstAudioMs - cur.anchor.atMs;
		if (e2e < 0 || e2e > MAX_PLAUSIBLE_E2E_MS) {
			this.deps.emitDrop('implausible', cur.turnId);
			return;
		}
		// Per-segment guards: a late provider anchor can make provider-processing
		// negative while E2E is still valid — omit the segment, keep the sample.
		const segments: TurnLatencySegments = { totalE2EMs: e2e };
		const providerProcessing = cur.startedAtMs - cur.anchor.atMs;
		if (providerProcessing >= 0) segments.geminiProcessingMs = providerProcessing;
		const backendToClient = cur.firstAudioMs - cur.startedAtMs;
		if (backendToClient >= 0) segments.backendToClientMs = backendToClient;

		this.deps.emitLatency(cur.turnId, segments);
		this.deps.bus.publish('turn.latency', {
			sessionId: this.deps.sessionId,
			turnId: cur.turnId,
			segments,
		});
	}
}
