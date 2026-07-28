/**
 * UserTurnEvidenceLedger — session-scoped, three-level user-speech evidence
 * (DETECTED / ROUTED / RECOGNIZED). Phase 1 of
 * dev_docs/framework/design-speech-evidence-architecture.md: one mutable
 * ACTIVE record updated with allocation-free field writes on the audio fast
 * path, plus a private preallocated terminal ring holding EVERY outcome
 * (completed, ignored, aborted — all can carry routed audio and receive late
 * provider callbacks). Reads are snapshot copies only; ring lookups are
 * generation-checked by `segmentId` so a recycled slot is a miss, never a
 * misattribution. Late/unmatched evidence is dropped and counted.
 *
 * NOT exported from the package index — internal to the session (§2, SDK
 * stance). Consumers attach through private observers, never the EventBus.
 */

import type { ProviderEvidenceEvent, ProviderEvidenceKind } from '../types/transport.js';

export type SegmentOutcome = 'open' | 'completed' | 'ignored' | 'aborted';
/** Named for what the signal IS: today's `complete('provider-recognition')`
 *  fires from generic model-turn/tool activity, not proven recognition — the
 *  ledger vocabulary must not imply recognition (§1). */
export type TerminalCause = 'silence' | 'model-activity-forced' | 'forced-reset';
/** Tri-state: a boolean would conflate "provider ignored it" with "provider
 *  can't tell us" (§1). */
export type ProviderObservation = 'observed' | 'not-observable' | 'unknown';

export interface SegmentEvidence {
	segmentId: number;
	startedAtMs: number;
	firstVoicedAtMs: number | null;
	lastVoicedAtMs: number | null;
	resolvedAtMs: number | null;
	outcome: SegmentOutcome;
	terminalCause: TerminalCause | null;
	voicedFrames: number;
	/** ADVISORY ordering facts (not causal proof — §2 Phase-2 truth table). */
	responseEpochAtStart: number;
	responseEpochAtTerminal: number | null;
	/** ROUTED — ADMISSION onto a route, not receipt. Only the LLM route
	 *  consults the greeting gate; see the §1 route-outcome table. */
	routed: { llm: boolean; external: boolean; stt: boolean };
	providerDetected: ProviderObservation;
	recognized: ProviderObservation;
	/** DIAGNOSTICS ONLY — segments can straddle gate transitions; the
	 *  per-frame routed bits are the truth. */
	gateActiveAtSegmentStart: boolean;
}

export interface FinalizeDescriptor {
	segmentId: number;
	outcome: Exclude<SegmentOutcome, 'open'>;
	terminalCause: TerminalCause;
	resolvedAtMs: number;
}

export type TerminalObserver = (ev: Readonly<SegmentEvidence>) => void;

/** H2: drained buffered-inbound audio is a DISCRIMINATED variant, never a
 *  `SegmentEvidence` — buffered frames bypass live VAD (no segment id,
 *  boundaries, outcome, or cause), so watchdog/retention policies must not
 *  consume it. Recovery verdict logic consumes `reconnect`/`goaway` records
 *  ONLY; transfer and external-agent drains are dial-gap paths. */
export interface BufferedInboundEvidence {
	reason: 'reconnect' | 'goaway' | 'transfer' | 'external-agent';
	voicedFrameCount: number;
	admittedCount: number;
	destination: 'llm' | 'external';
	recordedAtMs: number;
}

const DEFAULT_RING_CAPACITY = 8;
/** Correlation horizon for heuristic window matching (Open Questions: the
 *  default is validated or restated before Phase 1 exits shadow mode). */
const DEFAULT_CORRELATION_HORIZON_MS = 30_000;

function blankRecord(): SegmentEvidence {
	return {
		segmentId: -1,
		startedAtMs: 0,
		firstVoicedAtMs: null,
		lastVoicedAtMs: null,
		resolvedAtMs: null,
		outcome: 'open',
		terminalCause: null,
		voicedFrames: 0,
		responseEpochAtStart: 0,
		responseEpochAtTerminal: null,
		routed: { llm: false, external: false, stt: false },
		providerDetected: 'unknown',
		recognized: 'unknown',
		gateActiveAtSegmentStart: false,
	};
}

function copyInto(dst: SegmentEvidence, src: SegmentEvidence): void {
	dst.segmentId = src.segmentId;
	dst.startedAtMs = src.startedAtMs;
	dst.firstVoicedAtMs = src.firstVoicedAtMs;
	dst.lastVoicedAtMs = src.lastVoicedAtMs;
	dst.resolvedAtMs = src.resolvedAtMs;
	dst.outcome = src.outcome;
	dst.terminalCause = src.terminalCause;
	dst.voicedFrames = src.voicedFrames;
	dst.responseEpochAtStart = src.responseEpochAtStart;
	dst.responseEpochAtTerminal = src.responseEpochAtTerminal;
	dst.routed.llm = src.routed.llm;
	dst.routed.external = src.routed.external;
	dst.routed.stt = src.routed.stt;
	dst.providerDetected = src.providerDetected;
	dst.recognized = src.recognized;
	dst.gateActiveAtSegmentStart = src.gateActiveAtSegmentStart;
}

function snapshot(src: SegmentEvidence): SegmentEvidence {
	const s = blankRecord();
	copyInto(s, src);
	return s;
}

export class UserTurnEvidenceLedger {
	/** Preallocated live slot — field writes only on the hot path. */
	private readonly active: SegmentEvidence = blankRecord();
	private hasActive = false;
	/** Preallocated terminal ring; slots recycled, never handed out. */
	private readonly ring: SegmentEvidence[];
	private ringNext = 0;
	private readonly observers: TerminalObserver[] = [];
	/** Late/unmatched evidence counter (never applied to the wrong segment). */
	lateEvidenceDropped = 0;
	/** Capability-declared provider-evidence kinds (undeclared ⇒ the
	 *  corresponding bit is 'not-observable', stated once). */
	private readonly declaredKinds = new Set<ProviderEvidenceKind>();
	/** Causal chain: localInputBatchId → segmentId, providerInputId → batchId. */
	private readonly batchToSegment = new Map<string, number>();
	private readonly providerToBatch = new Map<string, string>();
	/** Idempotency keys for applied provider events. */
	private readonly appliedEvidence = new Set<string>();
	/** H2 drain-freshness anchor: newest reconnect/goaway drain that carried
	 *  admitted voiced speech. Candidates sealed BEFORE it are not replayable
	 *  at ANY recovery stage ("fresh speech wins" — candidate-wide rule). */
	private _lastDrainedSpeechAtMs: number | null = null;

	constructor(opts: { ringCapacity?: number } = {}) {
		const cap = opts.ringCapacity ?? DEFAULT_RING_CAPACITY;
		this.ring = Array.from({ length: cap }, blankRecord);
	}

	/** H2: record a buffered-inbound drain. Only reconnect/goaway drains with
	 *  admitted voiced audio move the freshness anchor. */
	recordBufferedInbound(ev: BufferedInboundEvidence): void {
		if (
			(ev.reason === 'reconnect' || ev.reason === 'goaway') &&
			ev.voicedFrameCount > 0 &&
			ev.admittedCount > 0
		) {
			this._lastDrainedSpeechAtMs = ev.recordedAtMs;
		}
	}

	get lastDrainedSpeechAtMs(): number | null {
		return this._lastDrainedSpeechAtMs;
	}

	/** Declare which evidence kinds the transport's adapter can ever emit. */
	declareProviderCapability(kinds: ProviderEvidenceKind[]): void {
		for (const k of kinds) this.declaredKinds.add(k);
	}

	beginSegment(
		segmentId: number,
		startedAtMs: number,
		opts: { gateActive: boolean; responseEpoch: number },
	): void {
		const a = this.active;
		a.segmentId = segmentId;
		a.startedAtMs = startedAtMs;
		a.firstVoicedAtMs = null;
		a.lastVoicedAtMs = null;
		a.resolvedAtMs = null;
		a.outcome = 'open';
		a.terminalCause = null;
		a.voicedFrames = 0;
		a.responseEpochAtStart = opts.responseEpoch;
		a.responseEpochAtTerminal = null;
		a.routed.llm = false;
		a.routed.external = false;
		a.routed.stt = false;
		a.providerDetected = this.declaredKinds.has('speech-window') ? 'unknown' : 'not-observable';
		a.recognized =
			this.declaredKinds.has('input-transcription') || this.declaredKinds.has('model-output')
				? 'unknown'
				: 'not-observable';
		a.gateActiveAtSegmentStart = opts.gateActive;
		this.hasActive = true;
	}

	/** Hot path: a voiced frame of the active segment (field writes only). */
	noteVoicedFrame(atMs: number): void {
		if (!this.hasActive) return;
		if (this.active.firstVoicedAtMs === null) this.active.firstVoicedAtMs = atMs;
		this.active.lastVoicedAtMs = atMs;
		this.active.voicedFrames++;
	}

	/** Hot path: a voiced frame was admitted onto `route` (admission ≠ receipt). */
	noteRouted(route: 'llm' | 'external' | 'stt'): void {
		if (!this.hasActive) return;
		this.active.routed[route] = true;
	}

	/** Terminal transition — copies the active record into the next ring slot
	 *  (off the per-frame hot path) and notifies observers with a read-only
	 *  view of the RING slot's snapshot copy. */
	finalizeSegment(desc: FinalizeDescriptor): void {
		if (!this.hasActive || this.active.segmentId !== desc.segmentId) return;
		this.active.outcome = desc.outcome;
		this.active.terminalCause = desc.terminalCause;
		this.active.resolvedAtMs = desc.resolvedAtMs;
		this.active.responseEpochAtTerminal = this.active.responseEpochAtStart;
		const slot = this.ring[this.ringNext];
		copyInto(slot, this.active);
		this.ringNext = (this.ringNext + 1) % this.ring.length;
		this.hasActive = false;
		const terminal = snapshot(slot);
		for (const cb of this.observers) cb(terminal);
	}

	/** Record the terminal-time response epoch (advisory ordering fact). */
	noteResponseEpochAtTerminal(epoch: number): void {
		if (this.hasActive) this.active.responseEpochAtTerminal = epoch;
	}

	/** Diagnostics: the router's single gate read on the segment-starting frame
	 *  said DROP (the gate was active when the segment opened). */
	noteGateActiveAtSegmentStart(): void {
		if (this.hasActive) this.active.gateActiveAtSegmentStart = true;
	}

	observeTerminal(cb: TerminalObserver): void {
		this.observers.push(cb);
	}

	getActiveSnapshot(): SegmentEvidence | null {
		return this.hasActive ? snapshot(this.active) : null;
	}

	/** Generation-checked ring lookup: a recycled slot whose `segmentId` no
	 *  longer matches is a miss. Returns a copy, never the slot. */
	getTerminalSnapshot(segmentId: number): SegmentEvidence | null {
		const slot = this.findSlot(segmentId);
		return slot ? snapshot(slot) : null;
	}

	/** Provider evidence lands by segmentId against the active record or the
	 *  ring; anything that misses is dropped and counted. */
	applyProviderEvidence(
		segmentId: number,
		ev: { providerDetected?: ProviderObservation; recognized?: ProviderObservation },
	): void {
		const target =
			this.hasActive && this.active.segmentId === segmentId
				? this.active
				: this.findSlot(segmentId);
		if (!target) {
			this.lateEvidenceDropped++;
			return;
		}
		if (ev.providerDetected !== undefined) target.providerDetected = ev.providerDetected;
		if (ev.recognized !== undefined) target.recognized = ev.recognized;
	}

	/** Route admissions carry a local input-batch id (causal-chain anchor). */
	registerInputBatch(batchId: string, segmentId: number): void {
		this.batchToSegment.set(batchId, segmentId);
	}

	/** Provider acknowledged an input batch (e.g. buffer-commit ack). */
	acknowledgeProviderInput(providerInputId: string, batchId: string): void {
		this.providerToBatch.set(providerInputId, batchId);
	}

	/** Normalized provider-evidence intake (deterministic, testable — §1).
	 *  Causal events resolve through BOTH mappings or are dropped-and-counted;
	 *  window events match heuristically against the voiced interval of the
	 *  active record and the terminal ring, with larger-overlap tie-breaks.
	 *  `speech-window` feeds providerDetected ONLY; `recognized` requires a
	 *  causal `input-transcription`/`model-output`. Duplicates are idempotent. */
	applyProviderEvidenceEvent(ev: ProviderEvidenceEvent): void {
		const dupKey = `${ev.kind}:${ev.providerInputId ?? `${ev.windowStartAtMs}-${ev.windowEndAtMs}`}`;
		if (this.appliedEvidence.has(dupKey)) return;

		let target: SegmentEvidence | null = null;
		let causal = false;
		if (ev.correlation === 'causal' && ev.providerInputId !== undefined) {
			const batch = this.providerToBatch.get(ev.providerInputId);
			const segId = batch !== undefined ? this.batchToSegment.get(batch) : undefined;
			if (segId !== undefined) {
				target =
					this.hasActive && this.active.segmentId === segId ? this.active : this.findSlot(segId);
				causal = target !== null;
			}
		} else if (ev.windowStartAtMs !== undefined && ev.windowEndAtMs !== undefined) {
			target = this.bestWindowMatch(ev.windowStartAtMs, ev.windowEndAtMs, ev.receiptAtMs);
		}

		if (!target) {
			this.lateEvidenceDropped++;
			return;
		}
		this.appliedEvidence.add(dupKey);
		if (ev.kind === 'speech-window') {
			if (target.providerDetected !== 'not-observable') target.providerDetected = 'observed';
			return;
		}
		// input-transcription / model-output: recognition strictly causal.
		if (causal && target.recognized !== 'not-observable') target.recognized = 'observed';
		// Heuristic recognition matches are dashboard-only: applied key is
		// recorded (idempotency) but the bit stays as-is.
	}

	/** Larger voiced-interval overlap wins; tie-less events return null. */
	private bestWindowMatch(
		startMs: number,
		endMs: number,
		receiptAtMs: number,
	): SegmentEvidence | null {
		let best: SegmentEvidence | null = null;
		let bestOverlap = 0;
		const consider = (rec: SegmentEvidence) => {
			if (rec.firstVoicedAtMs === null || rec.lastVoicedAtMs === null) return;
			if (receiptAtMs - rec.lastVoicedAtMs > DEFAULT_CORRELATION_HORIZON_MS) return;
			const overlap = Math.min(endMs, rec.lastVoicedAtMs) - Math.max(startMs, rec.firstVoicedAtMs);
			if (overlap > 0 && overlap > bestOverlap) {
				bestOverlap = overlap;
				best = rec;
			}
		};
		if (this.hasActive) consider(this.active);
		for (const slot of this.ring) {
			if (slot.segmentId >= 0 && slot.outcome !== 'open') consider(slot);
		}
		return best;
	}

	private findSlot(segmentId: number): SegmentEvidence | null {
		for (const slot of this.ring) {
			if (slot.segmentId === segmentId && slot.outcome !== 'open') return slot;
		}
		return null;
	}
}
