import { describe, expect, it } from 'vitest';
import { decideRetention } from '../../../src/core/policies/retention.policy.js';
import type { SegmentEvidence } from '../../../src/core/user-turn-evidence.js';

/** Like Partial<SegmentEvidence>, but `routed` may be partial too (missing flags default to false). */
type EvidenceOverrides = Omit<Partial<SegmentEvidence>, 'routed'> & {
	routed?: Partial<SegmentEvidence['routed']>;
};

function ev(over: EvidenceOverrides = {}): SegmentEvidence {
	return {
		segmentId: 1,
		startedAtMs: 0,
		firstVoicedAtMs: 10,
		lastVoicedAtMs: 200,
		resolvedAtMs: 700,
		outcome: 'completed',
		terminalCause: 'silence',
		voicedFrames: 5,
		responseEpochAtStart: 0,
		responseEpochAtTerminal: 0,
		routed: { llm: false, external: false, stt: false },
		providerDetected: 'not-observable',
		recognized: 'not-observable',
		gateActiveAtSegmentStart: false,
		...over,
		...(over.routed ? { routed: { llm: false, external: false, stt: false, ...over.routed } } : {}),
	} as SegmentEvidence;
}

describe('decideRetention', () => {
	it('seals ONLY completed + routed.llm with replay recovery enabled', () => {
		expect(decideRetention(ev({ routed: { llm: true } as never }), { replayRecovery: true })).toBe(
			'seal',
		);
		expect(decideRetention(ev({ routed: { llm: true } as never }), { replayRecovery: false })).toBe(
			'abort',
		);
	});

	it('external/STT routing never seals (no LLM audio to replay)', () => {
		expect(
			decideRetention(ev({ routed: { external: true } as never }), { replayRecovery: true }),
		).toBe('abort');
		expect(decideRetention(ev({ routed: { stt: true } as never }), { replayRecovery: true })).toBe(
			'abort',
		);
	});

	it('fully gated → abort', () => {
		expect(decideRetention(ev(), { replayRecovery: true })).toBe('abort');
	});

	it('provider-forced routed segments abort (the Phase-2 expected divergence: never re-seal answered speech)', () => {
		expect(
			decideRetention(
				ev({ terminalCause: 'model-activity-forced', routed: { llm: true } as never }),
				{ replayRecovery: true },
			),
		).toBe('abort');
	});

	it('ignored / aborted → abort', () => {
		expect(
			decideRetention(ev({ outcome: 'aborted', routed: { llm: true } as never }), {
				replayRecovery: true,
			}),
		).toBe('abort');
	});
});
