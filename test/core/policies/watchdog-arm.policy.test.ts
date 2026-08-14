import { describe, expect, it } from 'vitest';
import { decideWatchdogArm } from '../../../src/core/policies/watchdog-arm.policy.js';
import type { SegmentEvidence } from '../../../src/core/user-turn-evidence.js';

/** Phase-2 truth-table rows as pure policy tests (Phase 1 ships arm /
 *  skip-no-eligible-route / skip-non-agent; skip-already-answered stays
 *  inactive until the transport correlation-ID contract exists). */

function ev(over: Partial<SegmentEvidence> = {}): SegmentEvidence {
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

describe('decideWatchdogArm', () => {
	it('completed + routed.llm → arm (agent mode)', () => {
		expect(decideWatchdogArm(ev({ routed: { llm: true } as never }), { agentMode: true })).toBe(
			'arm',
		);
	});

	it('completed + routed.external only → arm (agent mode, as today)', () => {
		expect(
			decideWatchdogArm(ev({ routed: { external: true } as never }), { agentMode: true }),
		).toBe('arm');
	});

	it('completed + routed.stt only in non-agent mode → skip-non-agent', () => {
		expect(decideWatchdogArm(ev({ routed: { stt: true } as never }), { agentMode: false })).toBe(
			'skip-non-agent',
		);
	});

	it('completed + fully gated → skip-no-eligible-route', () => {
		expect(decideWatchdogArm(ev(), { agentMode: true })).toBe('skip-no-eligible-route');
	});

	it('completed + routed + provider-forced → arm (parity with today; epochs are advisory)', () => {
		expect(
			decideWatchdogArm(
				ev({ terminalCause: 'model-activity-forced', routed: { llm: true } as never }),
				{ agentMode: true },
			),
		).toBe('arm');
	});

	it('ignored / aborted → skip-no-eligible-route', () => {
		expect(
			decideWatchdogArm(ev({ outcome: 'ignored', routed: { llm: true } as never }), {
				agentMode: true,
			}),
		).toBe('skip-no-eligible-route');
		expect(
			decideWatchdogArm(ev({ outcome: 'aborted', routed: { llm: true } as never }), {
				agentMode: true,
			}),
		).toBe('skip-no-eligible-route');
	});
});
