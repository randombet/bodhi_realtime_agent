import { describe, expect, it } from 'vitest';
import { UserTurnEvidenceLedger } from '../../src/core/user-turn-evidence.js';

/**
 * Phase-1 ledger contract (design-speech-evidence-architecture.md §1):
 * one mutable ACTIVE record (allocation-free field writes), a private
 * fixed-capacity terminal ring holding EVERY outcome, snapshot-only reads
 * with generation checks, and drop-and-count for late/unmatched evidence.
 */

function openSegment(
	ledger: UserTurnEvidenceLedger,
	segmentId: number,
	atMs: number,
	opts: { gateActive?: boolean; responseEpoch?: number } = {},
) {
	ledger.beginSegment(segmentId, atMs, {
		gateActive: opts.gateActive ?? false,
		responseEpoch: opts.responseEpoch ?? 0,
	});
}

function finalize(
	ledger: UserTurnEvidenceLedger,
	segmentId: number,
	outcome: 'completed' | 'ignored' | 'aborted',
	atMs: number,
) {
	ledger.finalizeSegment({
		segmentId,
		outcome,
		terminalCause: outcome === 'completed' ? 'silence' : 'forced-reset',
		resolvedAtMs: atMs,
	});
}

describe('UserTurnEvidenceLedger — active record', () => {
	it('a live record starts open with monotonic id, epoch, unrouted bits, tri-state provider evidence', () => {
		const ledger = new UserTurnEvidenceLedger();
		openSegment(ledger, 1, 1000, { gateActive: true, responseEpoch: 3 });
		const snap = ledger.getActiveSnapshot();
		expect(snap).not.toBeNull();
		expect(snap?.segmentId).toBe(1);
		expect(snap?.outcome).toBe('open');
		expect(snap?.startedAtMs).toBe(1000);
		expect(snap?.responseEpochAtStart).toBe(3);
		expect(snap?.routed).toEqual({ llm: false, external: false, stt: false });
		// No capability declared → provider bits are not-observable (stated once).
		expect(snap?.providerDetected).toBe('not-observable');
		expect(snap?.recognized).toBe('not-observable');
		expect(snap?.gateActiveAtSegmentStart).toBe(true);
		expect(snap?.voicedFrames).toBe(0);
	});

	it('voiced/routed field writes accumulate on the live record', () => {
		const ledger = new UserTurnEvidenceLedger();
		openSegment(ledger, 1, 1000);
		ledger.noteVoicedFrame(1010);
		ledger.noteVoicedFrame(1040);
		ledger.noteRouted('llm');
		const snap = ledger.getActiveSnapshot();
		expect(snap?.voicedFrames).toBe(2);
		expect(snap?.firstVoicedAtMs).toBe(1010);
		expect(snap?.lastVoicedAtMs).toBe(1040);
		expect(snap?.routed.llm).toBe(true);
		expect(snap?.routed.external).toBe(false);
	});
});

describe('UserTurnEvidenceLedger — terminal ring', () => {
	it('completed, ignored, AND aborted terminals all enter the ring', () => {
		const ledger = new UserTurnEvidenceLedger();
		openSegment(ledger, 1, 1000);
		finalize(ledger, 1, 'completed', 1500);
		openSegment(ledger, 2, 2000);
		finalize(ledger, 2, 'ignored', 2100);
		openSegment(ledger, 3, 3000);
		finalize(ledger, 3, 'aborted', 3100);

		expect(ledger.getTerminalSnapshot(1)?.outcome).toBe('completed');
		expect(ledger.getTerminalSnapshot(2)?.outcome).toBe('ignored');
		expect(ledger.getTerminalSnapshot(3)?.outcome).toBe('aborted');
		expect(ledger.getActiveSnapshot()).toBeNull();
	});

	it('recycled ring slots are a MISS for the evicted segmentId, never a misattribution', () => {
		const ledger = new UserTurnEvidenceLedger({ ringCapacity: 2 });
		for (let id = 1; id <= 3; id++) {
			openSegment(ledger, id, id * 1000);
			finalize(ledger, id, 'completed', id * 1000 + 500);
		}
		expect(ledger.getTerminalSnapshot(1)).toBeNull(); // evicted
		expect(ledger.getTerminalSnapshot(2)?.segmentId).toBe(2);
		expect(ledger.getTerminalSnapshot(3)?.segmentId).toBe(3);
	});

	it('snapshots are copies — mutating one cannot corrupt ring state', () => {
		const ledger = new UserTurnEvidenceLedger();
		openSegment(ledger, 1, 1000);
		ledger.noteRouted('llm');
		finalize(ledger, 1, 'completed', 1500);
		const snap = ledger.getTerminalSnapshot(1);
		if (snap) {
			(snap as { routed: { llm: boolean } }).routed.llm = false;
			(snap as { outcome: string }).outcome = 'aborted';
		}
		expect(ledger.getTerminalSnapshot(1)?.routed.llm).toBe(true);
		expect(ledger.getTerminalSnapshot(1)?.outcome).toBe('completed');
	});

	it('the terminal observer fires once per finalization with the terminal evidence', () => {
		const ledger = new UserTurnEvidenceLedger();
		const seen: Array<{ segmentId: number; outcome: string }> = [];
		ledger.observeTerminal((ev) => seen.push({ segmentId: ev.segmentId, outcome: ev.outcome }));
		openSegment(ledger, 1, 1000);
		finalize(ledger, 1, 'completed', 1500);
		openSegment(ledger, 2, 2000);
		finalize(ledger, 2, 'aborted', 2100);
		expect(seen).toEqual([
			{ segmentId: 1, outcome: 'completed' },
			{ segmentId: 2, outcome: 'aborted' },
		]);
	});
});

describe('UserTurnEvidenceLedger — late evidence', () => {
	it('late unmatched evidence increments lateEvidenceDropped instead of attaching', () => {
		const ledger = new UserTurnEvidenceLedger({ ringCapacity: 2 });
		openSegment(ledger, 1, 1000);
		finalize(ledger, 1, 'completed', 1500);
		// Evict segment 1 out of the ring.
		for (let id = 2; id <= 3; id++) {
			openSegment(ledger, id, id * 1000);
			finalize(ledger, id, 'completed', id * 1000 + 500);
		}
		expect(ledger.lateEvidenceDropped).toBe(0);
		ledger.applyProviderEvidence(1, { providerDetected: 'observed' });
		expect(ledger.lateEvidenceDropped).toBe(1);
		expect(ledger.getTerminalSnapshot(2)?.providerDetected).toBe('not-observable');
		expect(ledger.getTerminalSnapshot(3)?.providerDetected).toBe('not-observable');
	});

	it('evidence for a ring-resident segment applies to exactly that segment', () => {
		const ledger = new UserTurnEvidenceLedger();
		openSegment(ledger, 1, 1000);
		finalize(ledger, 1, 'completed', 1500);
		openSegment(ledger, 2, 2000);
		ledger.applyProviderEvidence(1, { recognized: 'observed' });
		expect(ledger.getTerminalSnapshot(1)?.recognized).toBe('observed');
		expect(ledger.getActiveSnapshot()?.recognized).toBe('not-observable');
	});
});

describe('responseEpochAtTerminal', () => {
	it('a noted terminal epoch survives finalizeSegment (forced-path ordering fact)', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.beginSegment(1, 1000, { gateActive: false, responseEpoch: 0 });
		ledger.noteVoicedFrame(1010);
		// Forced terminal path: the session notes the CURRENT epoch (2 model
		// turns started since segment start) just before finalizing.
		ledger.noteResponseEpochAtTerminal(2);
		ledger.finalizeSegment({
			segmentId: 1,
			outcome: 'completed',
			terminalCause: 'model-activity-forced',
			resolvedAtMs: 1200,
		});
		expect(ledger.getTerminalSnapshot(1)?.responseEpochAtTerminal).toBe(2);
	});

	it('an un-noted terminal epoch falls back to the start epoch', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.beginSegment(1, 1000, { gateActive: false, responseEpoch: 3 });
		ledger.noteVoicedFrame(1010);
		ledger.finalizeSegment({
			segmentId: 1,
			outcome: 'completed',
			terminalCause: 'silence',
			resolvedAtMs: 1600,
		});
		expect(ledger.getTerminalSnapshot(1)?.responseEpochAtTerminal).toBe(3);
	});
});
