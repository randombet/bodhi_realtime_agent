import { describe, expect, it } from 'vitest';
import { decideBargeIn } from '../../../src/core/policies/barge-in.policy.js';

/** A1-A6 barge-in decision extracted as a pure policy (parity-only,
 *  design-speech-evidence-architecture.md §2). The session keeps the ordered
 *  greeting-gate check (before marking fired) and all actuation/metrics. */

const cfg = {
	bargeInEnabled: true,
	bargeInConfirmMs: 200,
	bargeInTtsPeakThreshold: 2000,
	bargeInTtsAvgAbsThreshold: 450,
};

const loud = { maxAbs: 3000, avgAbs: 800 };

describe('decideBargeIn', () => {
	it('marks eligibility on any frame clearing the echo floor, even with no active playback', () => {
		const d = decideBargeIn(
			cfg,
			{ ...loud, elapsedMs: 0 },
			{ assistantAudioActive: false },
			{ fired: false },
		);
		expect(d.markEligible).toBe(true);
		expect(d.attempt).toBe(false); // A1: no active assistant audio
	});

	it('attempts only while assistant audio is active AND the confirm window elapsed', () => {
		expect(
			decideBargeIn(
				cfg,
				{ ...loud, elapsedMs: 100 },
				{ assistantAudioActive: true },
				{ fired: false },
			).attempt,
		).toBe(false); // A2: sustained < confirmMs
		expect(
			decideBargeIn(
				cfg,
				{ ...loud, elapsedMs: 250 },
				{ assistantAudioActive: true },
				{ fired: false },
			).attempt,
		).toBe(true);
	});

	it('echo-floor thresholds require BOTH peak and average', () => {
		expect(
			decideBargeIn(
				cfg,
				{ maxAbs: 3000, avgAbs: 100, elapsedMs: 300 },
				{ assistantAudioActive: true },
				{ fired: false },
			).attempt,
		).toBe(false);
		expect(
			decideBargeIn(
				cfg,
				{ maxAbs: 1000, avgAbs: 800, elapsedMs: 300 },
				{ assistantAudioActive: true },
				{ fired: false },
			).attempt,
		).toBe(false);
	});

	it('one fire per segment (A3): a fired segment never attempts again', () => {
		expect(
			decideBargeIn(
				cfg,
				{ ...loud, elapsedMs: 500 },
				{ assistantAudioActive: true },
				{ fired: true },
			).attempt,
		).toBe(false);
	});

	it('disabled barge-in never attempts but still marks eligibility', () => {
		const d = decideBargeIn(
			{ ...cfg, bargeInEnabled: false },
			{ ...loud, elapsedMs: 500 },
			{ assistantAudioActive: true },
			{ fired: false },
		);
		expect(d.attempt).toBe(false);
		expect(d.markEligible).toBe(true);
	});
});
