import { describe, expect, it } from 'vitest';
import { UserTurnEvidenceLedger } from '../../src/core/user-turn-evidence.js';

/** H2: drained buffered-inbound audio is a discriminated ledger variant —
 *  never SegmentEvidence — and only reconnect/goaway drains with admitted
 *  voiced audio move the candidate-wide replay-freshness anchor. */

describe('BufferedInboundEvidence', () => {
	it('reconnect drains with admitted voiced audio move the freshness anchor', () => {
		const ledger = new UserTurnEvidenceLedger();
		expect(ledger.lastDrainedSpeechAtMs).toBeNull();
		ledger.recordBufferedInbound({
			reason: 'reconnect',
			voicedFrameCount: 3,
			admittedCount: 3,
			destination: 'llm',
			recordedAtMs: 5000,
		});
		expect(ledger.lastDrainedSpeechAtMs).toBe(5000);
	});

	it('transfer and external-agent drains are dial-gap paths — they never move the anchor', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.recordBufferedInbound({
			reason: 'transfer',
			voicedFrameCount: 5,
			admittedCount: 5,
			destination: 'llm',
			recordedAtMs: 5000,
		});
		ledger.recordBufferedInbound({
			reason: 'external-agent',
			voicedFrameCount: 5,
			admittedCount: 5,
			destination: 'external',
			recordedAtMs: 6000,
		});
		expect(ledger.lastDrainedSpeechAtMs).toBeNull();
	});

	it('a fully-gated drain (voiced but nothing admitted) does not move the anchor', () => {
		const ledger = new UserTurnEvidenceLedger();
		ledger.recordBufferedInbound({
			reason: 'reconnect',
			voicedFrameCount: 4,
			admittedCount: 0,
			destination: 'llm',
			recordedAtMs: 5000,
		});
		expect(ledger.lastDrainedSpeechAtMs).toBeNull();
	});
});
