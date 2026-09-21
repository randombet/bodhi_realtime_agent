import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CLIENT_VAD_MIN_SPEECH_MS,
	CLIENT_VAD_SILENCE_MS,
	ClientVadDetector,
	VAD_FRAME,
	type VadEvents,
} from '../../src/core/client-vad-detector.js';
import { CLIENT_VAD_SEMANTICS_VERSION } from '../../src/core/client-vad-semantics.js';

/**
 * Versioned detector-semantics contract (G4,
 * design-speech-evidence-architecture.md §1). STRUCTURAL compatibility
 * (bitflag lifecycle, terminal descriptors, monotonic segment ids, dual-track
 * ordering) is mandatory for ANY detector implementation. CALIBRATION
 * behavior (which frames are voiced, where boundaries fall) is pinned by the
 * baseline fixtures and changes only through reviewed detector-version
 * deltas.
 */

function frame(amplitude: number, samples = 480): Buffer {
	const b = Buffer.alloc(samples * 2);
	for (let i = 0; i < b.length; i += 2) b.writeInt16LE(amplitude, i);
	return b;
}
const VOICED = frame(1500);
const SILENT = frame(0);

function makeDetector() {
	let now = 0;
	const events: { [K in keyof VadEvents]: ReturnType<typeof vi.fn> } = {
		onSpeechStart: vi.fn(),
		onVoicedFrame: vi.fn(),
		onSegmentResolved: vi.fn(),
		onUserTurnCompleted: vi.fn(),
		onSegmentAborted: vi.fn(),
	};
	const detector = new ClientVadDetector(events, vi.fn(), () => now);
	return {
		detector,
		events,
		advance: (ms: number) => {
			now += ms;
		},
		setNow: (ms: number) => {
			now = ms;
		},
	};
}

describe('structural contract — segment identity', () => {
	it('activeSegmentId is monotonic, valid through trailing silence, null when closed', () => {
		const d = makeDetector();
		expect(d.detector.activeSegmentId).toBeNull();
		d.detector.process(VOICED);
		const first = d.detector.activeSegmentId;
		expect(first).not.toBeNull();
		d.advance(CLIENT_VAD_MIN_SPEECH_MS + 30);
		d.detector.process(VOICED);
		d.advance(100); // trailing silence — segment still open
		d.detector.process(SILENT);
		expect(d.detector.activeSegmentId).toBe(first);
		d.advance(CLIENT_VAD_SILENCE_MS);
		d.detector.process(SILENT); // silence completion
		expect(d.detector.activeSegmentId).toBeNull();
		d.advance(30);
		d.detector.process(VOICED);
		expect(d.detector.activeSegmentId).toBe((first as number) + 1);
	});
});

describe('structural contract — dual-track terminals', () => {
	it('silence completion sets TERMINAL on that frame; takeTerminal() is valid exactly once', () => {
		const d = makeDetector();
		d.detector.process(VOICED);
		const segId = d.detector.activeSegmentId;
		d.advance(CLIENT_VAD_MIN_SPEECH_MS + 30);
		d.detector.process(VOICED);
		d.advance(CLIENT_VAD_SILENCE_MS);
		const flags = d.detector.process(SILENT);
		expect(flags & VAD_FRAME.TERMINAL).toBeTruthy();
		// Legacy callbacks already fired synchronously (dual-track ordering).
		expect(d.detector.isSpeechActive).toBe(false);

		const desc = d.detector.takeTerminal();
		expect(desc).not.toBeNull();
		expect(desc?.segmentId).toBe(segId);
		expect(desc?.outcome).toBe('completed');
		expect(desc?.terminalCause).toBe('silence');
		expect(desc?.startedAtMs).toBe(0);
		expect(desc?.firstVoicedAtMs).toBe(0);
		expect(desc?.lastVoicedAtMs).toBe(CLIENT_VAD_MIN_SPEECH_MS + 30);
		expect(desc?.resolvedAtMs).toBe(CLIENT_VAD_MIN_SPEECH_MS + 30 + CLIENT_VAD_SILENCE_MS);
		expect(d.detector.takeTerminal()).toBeNull(); // exactly once
	});

	it('an ignored blip is a TERMINAL frame with outcome ignored', () => {
		const d = makeDetector();
		d.advance(10); // epoch-zero lastVoiceMs means "unset" — start past 0
		d.detector.process(VOICED);
		d.advance(CLIENT_VAD_SILENCE_MS + 10); // blip < min speech, then silence
		const flags = d.detector.process(SILENT);
		expect(flags & VAD_FRAME.TERMINAL).toBeTruthy();
		const desc = d.detector.takeTerminal();
		expect(desc?.outcome).toBe('ignored');
		expect(desc?.terminalCause).toBe('silence');
	});

	it('forced complete() returns the descriptor directly (model-activity-forced) and does not arm takeTerminal', () => {
		const d = makeDetector();
		d.detector.process(VOICED);
		d.advance(CLIENT_VAD_MIN_SPEECH_MS + 30);
		d.detector.process(VOICED);
		const desc = d.detector.complete('provider-recognition');
		expect(desc?.outcome).toBe('completed');
		expect(desc?.terminalCause).toBe('model-activity-forced');
		expect(d.detector.takeTerminal()).toBeNull(); // forced path returns, never arms
	});

	it('complete() with no open segment returns null', () => {
		const d = makeDetector();
		expect(d.detector.complete('provider-recognition')).toBeNull();
	});

	it('resetSegment() returns an aborted/forced-reset descriptor when a segment was open, else null', () => {
		const d = makeDetector();
		expect(d.detector.resetSegment()).toBeNull();
		d.detector.process(VOICED);
		const desc = d.detector.resetSegment();
		expect(desc?.outcome).toBe('aborted');
		expect(desc?.terminalCause).toBe('forced-reset');
		expect(d.detector.takeTerminal()).toBeNull();
	});

	it('the descriptor record is reused (allocation-free), so callers must consume before the next terminal', () => {
		const d = makeDetector();
		d.detector.process(VOICED);
		d.advance(CLIENT_VAD_MIN_SPEECH_MS + 30);
		d.detector.process(VOICED);
		const a = d.detector.complete('provider-recognition');
		d.advance(30);
		d.detector.process(VOICED);
		const b = d.detector.resetSegment();
		expect(b).toBe(a); // same mutable record, new values
		expect(b?.terminalCause).toBe('forced-reset');
	});
});

describe('calibration baseline (fixture-pinned; changes require a reviewed detector-version delta)', () => {
	interface Scenario {
		name: string;
		steps: Array<[number, number]>;
		expectVoiced: boolean[];
		expectSegmentStartIndex: number;
		expectOutcome: 'completed' | 'ignored' | 'none';
	}
	const fixture = JSON.parse(
		readFileSync(join(__dirname, '../fixtures/client-vad/baseline-segments.json'), 'utf8'),
	) as { version: number; scenarios: Scenario[] };

	it('fixture version matches the semantics contract version', () => {
		expect(fixture.version).toBe(CLIENT_VAD_SEMANTICS_VERSION);
	});

	for (const s of fixture.scenarios) {
		it(`baseline: ${s.name}`, () => {
			const d = makeDetector();
			const voiced: boolean[] = [];
			let segmentStartIndex = -1;
			let outcome: 'completed' | 'ignored' | 'none' = 'none';
			s.steps.forEach(([amp, advanceMs], i) => {
				d.advance(advanceMs);
				const flags = d.detector.process(frame(amp));
				voiced.push((flags & VAD_FRAME.VOICED) !== 0);
				if (flags & VAD_FRAME.SEGMENT_STARTED && segmentStartIndex === -1) segmentStartIndex = i;
				if (flags & VAD_FRAME.TERMINAL) {
					const desc = d.detector.takeTerminal();
					if (desc && desc.outcome !== 'aborted') outcome = desc.outcome;
				}
			});
			expect(voiced).toEqual(s.expectVoiced);
			expect(segmentStartIndex).toBe(s.expectSegmentStartIndex);
			expect(outcome).toBe(s.expectOutcome);
		});
	}
});
