import { describe, expect, it } from 'vitest';
import { LastUtteranceRetainer } from '../../src/core/last-utterance-retainer.js';

// 16 kHz 16-bit mono: 32 bytes/ms. Frames of 160 B = 5 ms.
const RATE = 16_000;

function frame(fill: number, bytes = 160): Buffer {
	return Buffer.alloc(bytes, fill);
}

function makeRetainer(opts?: {
	preRollMs?: number;
	maxSegmentMs?: number;
	clock?: () => number;
}) {
	return new LastUtteranceRetainer({
		sampleRateHz: RATE,
		preRollMs: opts?.preRollMs ?? 10, // 320 B budget
		maxSegmentMs: opts?.maxSegmentMs ?? 1_000,
		clock: opts?.clock,
	});
}

describe('LastUtteranceRetainer', () => {
	it('includes the pre-roll tail before speech start in the sealed segment', () => {
		const r = makeRetainer(); // pre-roll budget 320 B = 2 frames
		r.feed(frame(1));
		r.feed(frame(2));
		r.feed(frame(3));
		r.feed(frame(4)); // ring now holds frames 3,4
		r.markSpeechStart();
		r.feed(frame(5));
		r.feed(frame(6));
		expect(r.seal()).toBe(true);

		const turn = r.peek(30_000);
		expect(turn).not.toBeNull();
		expect(turn?.pcm.length).toBe(4 * 160);
		// Content order: pre-roll tail (3,4) then speech (5,6).
		expect(turn?.pcm[0]).toBe(3);
		expect(turn?.pcm[160]).toBe(4);
		expect(turn?.pcm[320]).toBe(5);
		expect(turn?.pcm[480]).toBe(6);
		expect(turn?.sampleRateHz).toBe(RATE);
	});

	it('caps the segment and keeps the most recent audio (tail)', () => {
		// maxSegmentMs 25 ms = 800 B = 5 frames.
		const r = makeRetainer({ preRollMs: 0, maxSegmentMs: 25 });
		r.markSpeechStart();
		for (let i = 1; i <= 8; i++) r.feed(frame(i));
		expect(r.seal()).toBe(true);
		const turn = r.peek(30_000);
		expect(turn?.pcm.length).toBe(5 * 160);
		// Oldest (1,2,3) evicted; tail 4..8 kept.
		expect(turn?.pcm[0]).toBe(4);
		expect(turn?.pcm[4 * 160]).toBe(8);
	});

	it('seal() returns false for a segment with no retained frames', () => {
		const r = makeRetainer();
		// VAD fired but no frames were ever routed (greeting grace / dictation /
		// external audio) — nothing to retain.
		r.markSpeechStart();
		expect(r.seal()).toBe(false);
		expect(r.peek(30_000)).toBeNull();
	});

	it('seal() without markSpeechStart returns false', () => {
		const r = makeRetainer();
		r.feed(frame(1));
		expect(r.seal()).toBe(false);
		expect(r.peek(30_000)).toBeNull();
	});

	it('peek is non-consuming and respects the freshness window', () => {
		let now = 1_000;
		const r = makeRetainer({ clock: () => now });
		r.markSpeechStart();
		r.feed(frame(1));
		expect(r.seal()).toBe(true);

		now = 2_000;
		const first = r.peek(30_000);
		expect(first).not.toBeNull();
		// Non-consuming: a second peek returns the same utterance.
		expect(r.peek(30_000)?.utteranceId).toBe(first?.utteranceId);

		now = 1_000 + 30_001;
		expect(r.peek(30_000)).toBeNull(); // stale — never replay old speech
	});

	it('utteranceId increments per seal and a new seal replaces the previous one', () => {
		const r = makeRetainer();
		r.markSpeechStart();
		r.feed(frame(1));
		expect(r.seal()).toBe(true);
		const firstId = r.peek(30_000)?.utteranceId;

		r.markSpeechStart();
		r.feed(frame(2));
		expect(r.seal()).toBe(true);
		const second = r.peek(30_000);
		expect(second?.utteranceId).toBe((firstId ?? 0) + 1);
		expect(second?.pcm[0]).toBe(2); // previous utterance replaced
	});

	it('clearAnswered() drops the sealed utterance but keeps an in-progress segment', () => {
		const r = makeRetainer();
		r.markSpeechStart();
		r.feed(frame(1));
		expect(r.seal()).toBe(true);

		// User is mid-utterance (barge-in on the new response) when correlated
		// model activity clears the answered utterance — the in-progress segment
		// is the NEXT utterance and must survive.
		r.markSpeechStart();
		r.feed(frame(9));
		r.clearAnswered();
		expect(r.peek(30_000)).toBeNull();
		expect(r.seal()).toBe(true);
		expect(r.peek(30_000)?.pcm[0]).toBe(9);
	});

	it('abortSegment() drops the in-progress segment without clearing the sealed candidate', () => {
		const r = makeRetainer();
		r.markSpeechStart();
		r.feed(frame(1));
		expect(r.seal()).toBe(true);
		const sealedId = r.peek(30_000)?.utteranceId;

		// A VAD blip opens a segment, then resolves as ignored / force-reset.
		r.markSpeechStart();
		r.feed(frame(7));
		r.abortSegment();

		// Sealed replay candidate survives; the aborted segment can never seal.
		expect(r.peek(30_000)?.utteranceId).toBe(sealedId);
		expect(r.seal()).toBe(false);
	});

	it('after abortSegment() future routed audio returns to the pre-roll ring', () => {
		const r = makeRetainer(); // pre-roll budget 320 B = 2 frames
		r.markSpeechStart();
		r.feed(frame(1));
		r.abortSegment();

		// These frames must land in pre-roll (segment is gone), so the next real
		// utterance is sealed WITH its pre-roll tail.
		r.feed(frame(3));
		r.feed(frame(4));
		r.markSpeechStart();
		r.feed(frame(5));
		expect(r.seal()).toBe(true);
		const turn = r.peek(30_000);
		expect(turn?.pcm.length).toBe(3 * 160);
		expect(turn?.pcm[0]).toBe(3);
		expect(turn?.pcm[320]).toBe(5);
	});

	it('clearAll() drops sealed, pre-roll, and in-progress audio', () => {
		const r = makeRetainer();
		r.markSpeechStart();
		r.feed(frame(1));
		expect(r.seal()).toBe(true);
		r.feed(frame(2)); // pre-roll
		r.markSpeechStart(); // in-progress, seeded from pre-roll
		r.feed(frame(3));

		r.clearAll();
		expect(r.peek(30_000)).toBeNull();
		// In-progress segment gone — nothing seals.
		expect(r.seal()).toBe(false);
		// Pre-roll gone — a fresh segment seeds empty.
		r.markSpeechStart();
		r.feed(frame(9));
		expect(r.seal()).toBe(true);
		expect(r.peek(30_000)?.pcm.length).toBe(160);
		expect(r.peek(30_000)?.pcm[0]).toBe(9);
	});

	it('records sealedAtMs from the injected clock', () => {
		let now = 42_000;
		const r = makeRetainer({ clock: () => now });
		r.markSpeechStart();
		r.feed(frame(1));
		now = 43_500;
		r.seal();
		expect(r.peek(30_000)?.sealedAtMs).toBe(43_500);
	});
});
