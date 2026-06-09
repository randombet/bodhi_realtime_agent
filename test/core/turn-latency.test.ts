// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { computeTurnLatencySegments } from '../../src/core/turn-latency.js';

describe('computeTurnLatencySegments', () => {
	it('computes total + sub-segments from a full set of stamps', () => {
		// user stops at 1000; provider starts at 1300; first audio at 1450.
		const segments = computeTurnLatencySegments({
			userSpeechEndMs: 1000,
			modelStartMs: 1300,
			firstAudioMs: 1450,
		});
		expect(segments).toEqual({
			totalE2EMs: 450, // 1450 - 1000 (stop-to-first-audio)
			geminiProcessingMs: 300, // 1300 - 1000 (user stop -> provider start)
			backendToClientMs: 150, // 1450 - 1300 (provider start -> first audio)
		});
	});

	it('returns only totalE2EMs when modelStart is missing', () => {
		const segments = computeTurnLatencySegments({
			userSpeechEndMs: 1000,
			modelStartMs: null,
			firstAudioMs: 1400,
		});
		expect(segments).toEqual({ totalE2EMs: 400 });
	});

	it('returns null when no user-speech-end anchor (cannot form the headline)', () => {
		expect(
			computeTurnLatencySegments({ userSpeechEndMs: null, modelStartMs: 1300, firstAudioMs: 1450 }),
		).toBeNull();
	});

	it('returns null for a tool-only turn (no audio produced)', () => {
		expect(
			computeTurnLatencySegments({ userSpeechEndMs: 1000, modelStartMs: 1300, firstAudioMs: null }),
		).toBeNull();
	});

	it('clamps negative spans to 0 (clock/order skew)', () => {
		const segments = computeTurnLatencySegments({
			userSpeechEndMs: 1000,
			modelStartMs: 980, // earlier than user-speech-end (skew)
			firstAudioMs: 1100,
		});
		expect(segments).toEqual({
			totalE2EMs: 100,
			geminiProcessingMs: 0, // clamped
			backendToClientMs: 120,
		});
	});
});
