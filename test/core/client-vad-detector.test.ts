// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type FrameEnergy, analyzeFrameInto } from '../../src/core/audio-frame-analyzer.js';
import {
	CLIENT_VAD_MIN_SPEECH_MS,
	CLIENT_VAD_SILENCE_MS,
	ClientVadDetector,
	type VadEvents,
} from '../../src/core/client-vad-detector.js';

/** PCM16 frame of `samples` identical samples at the given amplitude. */
function frame(amplitude: number, samples = 480): Buffer {
	const b = Buffer.alloc(samples * 2);
	for (let i = 0; i < b.length; i += 2) b.writeInt16LE(amplitude, i);
	return b;
}

const VOICED = frame(1500); // peak 1500 ≥ 1200 threshold
const SILENT = frame(0);

describe('analyzeFrameInto (pure energy)', () => {
	it('computes peak/mean/sample-count and writes into the reused out object', () => {
		const out: FrameEnergy = { maxAbs: 0, avgAbs: 0, samples: 0 };
		const ref = out;
		analyzeFrameInto(frame(1000, 3), out);
		expect(out).toEqual({ maxAbs: 1000, avgAbs: 1000, samples: 3 });
		expect(out).toBe(ref); // no allocation — same object mutated in place
	});

	it('reports zero energy for an empty frame', () => {
		const out: FrameEnergy = { maxAbs: 9, avgAbs: 9, samples: 9 };
		analyzeFrameInto(Buffer.alloc(0), out);
		expect(out).toEqual({ maxAbs: 0, avgAbs: 0, samples: 0 });
	});
});

describe('ClientVadDetector', () => {
	let now: number;
	let events: { [K in keyof VadEvents]: ReturnType<typeof vi.fn> };
	let detector: ClientVadDetector;

	beforeEach(() => {
		now = 0;
		events = {
			onSpeechStart: vi.fn(),
			onVoicedFrame: vi.fn(),
			onSegmentResolved: vi.fn(),
			onUserTurnCompleted: vi.fn(),
		};
		detector = new ClientVadDetector(events, vi.fn(), () => now);
	});

	it('starts a segment on the first voiced frame and emits onSpeechStart once', () => {
		detector.process(VOICED);
		expect(detector.isSpeechActive).toBe(true);
		expect(events.onSpeechStart).toHaveBeenCalledTimes(1);
		expect(events.onVoicedFrame).toHaveBeenCalledTimes(1);

		now += 30;
		detector.process(VOICED);
		expect(events.onSpeechStart).toHaveBeenCalledTimes(1); // not re-started
		expect(events.onVoicedFrame).toHaveBeenCalledTimes(2);
	});

	it('completes a long-enough segment after sustained silence', () => {
		detector.process(VOICED); // start at t=0
		now = 200;
		detector.process(VOICED); // last voice at t=200 (duration 200 ms)
		now = 200 + CLIENT_VAD_SILENCE_MS;
		detector.process(SILENT); // silence ≥ threshold → complete

		expect(detector.isSpeechActive).toBe(false);
		expect(events.onSegmentResolved).toHaveBeenCalledTimes(1);
		expect(events.onUserTurnCompleted).toHaveBeenCalledTimes(1); // fires on 'completed'
		expect(detector.lastSpeechCompletedMs).toBe(200);
		expect(detector.lastSpeechDurationMs).toBe(200);
	});

	it('ignores a too-short segment but still resolves the defer hook', () => {
		detector.process(VOICED); // start at t=0
		now = CLIENT_VAD_MIN_SPEECH_MS - 1; // duration just under the floor
		detector.process(VOICED);
		now += CLIENT_VAD_SILENCE_MS;
		detector.process(SILENT); // complete → 'ignored'

		expect(detector.isSpeechActive).toBe(false);
		expect(events.onSegmentResolved).toHaveBeenCalledTimes(1); // fires regardless
		expect(events.onUserTurnCompleted).not.toHaveBeenCalled(); // never on 'ignored'
		expect(detector.lastSpeechCompletedMs).toBe(0); // not recorded on 'ignored'
	});

	it('does not hold silence below the threshold open as a completion', () => {
		detector.process(VOICED);
		now = 200;
		detector.process(VOICED);
		now = 200 + CLIENT_VAD_SILENCE_MS - 1; // just under
		detector.process(SILENT);
		expect(detector.isSpeechActive).toBe(true);
		expect(events.onSegmentResolved).not.toHaveBeenCalled();
	});

	it('complete() on no active segment returns "none" and emits nothing', () => {
		expect(detector.complete('manual')).toBe('none');
		expect(events.onSegmentResolved).not.toHaveBeenCalled();
	});

	it('tracks the barge-in eligible/fired flags and clears them on a new segment', () => {
		detector.process(VOICED);
		expect(detector.isBargeInEligible).toBe(false);
		expect(detector.hasBargeInFired).toBe(false);

		detector.markBargeInEligible();
		detector.markBargeInFired();
		expect(detector.isBargeInEligible).toBe(true);
		expect(detector.hasBargeInFired).toBe(true);

		// A later voiced frame gives the segment a non-zero last-voice time so it
		// can complete (the `lastVoiceMs <= 0` guard mirrors the original code).
		now = 200;
		detector.process(VOICED);
		// End the segment, then start a fresh one — both flags reset.
		now = 200 + CLIENT_VAD_SILENCE_MS;
		detector.process(SILENT);
		now += 50;
		detector.process(VOICED);
		expect(detector.hasBargeInFired).toBe(false);
		expect(detector.isBargeInEligible).toBe(false);
	});

	it('resetSegment() drops a stale segment without emitting events', () => {
		detector.process(VOICED);
		detector.markBargeInEligible();
		detector.resetSegment();
		expect(detector.isSpeechActive).toBe(false);
		expect(detector.isBargeInEligible).toBe(false);
		expect(events.onSegmentResolved).not.toHaveBeenCalled();
	});
});
