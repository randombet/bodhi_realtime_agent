import { describe, expect, it } from 'vitest';
import { UserTurnEvidenceLedger } from '../../src/core/user-turn-evidence.js';
import type { ProviderEvidenceEvent } from '../../src/types/transport.js';

/**
 * Phase-1 step 1.4: provider-side evidence is advisory, deterministic, and
 * non-behavioral. Capability-declared kinds gate observability; causal
 * correlation requires the full acknowledged mapping chain
 * (providerInputId ↔ localInputBatchId ↔ segment); time-window matching is
 * always heuristic; duplicates are idempotent; unmatched evidence is dropped
 * and counted (design-speech-evidence-architecture.md §1).
 */

function openVoiced(ledger: UserTurnEvidenceLedger, segmentId: number, startMs: number) {
	ledger.beginSegment(segmentId, startMs, { gateActive: false, responseEpoch: 0 });
	ledger.noteVoicedFrame(startMs + 10);
	ledger.noteVoicedFrame(startMs + 200);
}

function finalize(ledger: UserTurnEvidenceLedger, segmentId: number, atMs: number) {
	ledger.finalizeSegment({
		segmentId,
		outcome: 'completed',
		terminalCause: 'silence',
		resolvedAtMs: atMs,
	});
}

const speechWindow = (start: number, end: number): ProviderEvidenceEvent => ({
	kind: 'speech-window',
	receiptAtMs: end + 50,
	windowStartAtMs: start,
	windowEndAtMs: end,
	provenance: 'test',
	correlation: 'heuristic',
});

describe('capability declarations', () => {
	it('with NO declaration, provider bits are not-observable (stated once, not per event)', () => {
		const ledger = new UserTurnEvidenceLedger();
		openVoiced(ledger, 1, 1000);
		expect(ledger.getActiveSnapshot()?.providerDetected).toBe('not-observable');
		expect(ledger.getActiveSnapshot()?.recognized).toBe('not-observable');
	});

	it('declared kinds make the corresponding bit unknown (observable, nothing correlated yet)', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['speech-window']);
		openVoiced(ledger, 1, 1000);
		expect(ledger.getActiveSnapshot()?.providerDetected).toBe('unknown');
		expect(ledger.getActiveSnapshot()?.recognized).toBe('not-observable');
	});
});

describe('heuristic window matching', () => {
	it('a speech-window overlapping the voiced interval marks providerDetected observed — never recognized', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['speech-window', 'input-transcription']);
		openVoiced(ledger, 1, 1000);
		finalize(ledger, 1, 1700);
		ledger.applyProviderEvidenceEvent(speechWindow(1050, 1150));
		expect(ledger.getTerminalSnapshot(1)?.providerDetected).toBe('observed');
		// input-transcription IS declared here, so recognized is observable-but-
		// uncorrelated: 'unknown' — a window match must never upgrade it.
		expect(ledger.getTerminalSnapshot(1)?.recognized).toBe('unknown');
	});

	it('window-overlap ties resolve to the larger voiced-interval overlap', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['speech-window']);
		openVoiced(ledger, 1, 1000); // voiced [1010, 1200]
		finalize(ledger, 1, 1700);
		ledger.beginSegment(2, 2000, { gateActive: false, responseEpoch: 0 });
		ledger.noteVoicedFrame(2010);
		ledger.noteVoicedFrame(2600);
		finalize(ledger, 2, 3200); // voiced [2010, 2600]
		// Window [1150, 2500]: overlaps seg1 by 50ms, seg2 by 490ms → seg2 wins.
		ledger.applyProviderEvidenceEvent(speechWindow(1150, 2500));
		expect(ledger.getTerminalSnapshot(1)?.providerDetected).toBe('unknown');
		expect(ledger.getTerminalSnapshot(2)?.providerDetected).toBe('observed');
	});

	it('an unmatched window is dropped and counted', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['speech-window']);
		openVoiced(ledger, 1, 1000);
		finalize(ledger, 1, 1700);
		ledger.applyProviderEvidenceEvent(speechWindow(5000, 5200)); // no overlap
		expect(ledger.getTerminalSnapshot(1)?.providerDetected).toBe('unknown');
		expect(ledger.lateEvidenceDropped).toBe(1);
	});

	it('duplicate events are idempotent (no double effects, no double counting)', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['speech-window']);
		openVoiced(ledger, 1, 1000);
		finalize(ledger, 1, 1700);
		const ev = speechWindow(1050, 1150);
		ledger.applyProviderEvidenceEvent(ev);
		ledger.applyProviderEvidenceEvent(ev);
		expect(ledger.getTerminalSnapshot(1)?.providerDetected).toBe('observed');
		expect(ledger.lateEvidenceDropped).toBe(0);
	});
});

describe('causal correlation (requires the full acknowledged mapping chain)', () => {
	it('input transcription resolves recognized=observed ONLY through providerInputId → batch → segment', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['input-transcription']);
		openVoiced(ledger, 1, 1000);
		ledger.registerInputBatch('batch-1', 1);
		finalize(ledger, 1, 1700);
		ledger.acknowledgeProviderInput('item-abc', 'batch-1');
		ledger.applyProviderEvidenceEvent({
			kind: 'input-transcription',
			receiptAtMs: 1900,
			providerInputId: 'item-abc',
			provenance: 'test',
			correlation: 'causal',
		});
		expect(ledger.getTerminalSnapshot(1)?.recognized).toBe('observed');
	});

	it('a causal-claimed event whose ID chain does not resolve is dropped, never guessed', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['input-transcription']);
		openVoiced(ledger, 1, 1000);
		finalize(ledger, 1, 1700);
		ledger.applyProviderEvidenceEvent({
			kind: 'input-transcription',
			receiptAtMs: 1900,
			providerInputId: 'item-unacknowledged',
			provenance: 'test',
			correlation: 'causal',
		});
		expect(ledger.getTerminalSnapshot(1)?.recognized).toBe('unknown');
		expect(ledger.lateEvidenceDropped).toBe(1);
	});

	it('a heuristic time-window transcription match never sets recognized (dashboard-only)', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.declareProviderCapability(['input-transcription']);
		openVoiced(ledger, 1, 1000);
		finalize(ledger, 1, 1700);
		ledger.applyProviderEvidenceEvent({
			kind: 'input-transcription',
			receiptAtMs: 1300,
			windowStartAtMs: 1050,
			windowEndAtMs: 1150,
			provenance: 'test',
			correlation: 'heuristic',
		});
		expect(ledger.getTerminalSnapshot(1)?.recognized).toBe('unknown');
	});
});
