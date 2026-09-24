// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	compareTranscripts,
	isSubstantiveDivergence,
	normalizeTranscript,
} from '../../src/core/shadow-stt.js';

describe('normalizeTranscript', () => {
	it('lowercases, strips punctuation, collapses whitespace', () => {
		expect(normalizeTranscript('  Hi,   Lucy!  ')).toBe('hi lucy');
		expect(normalizeTranscript("Hello, what's this?")).toBe('hello whats this');
	});
	it('keeps CJK', () => {
		expect(normalizeTranscript('你好,Lucy!')).toBe('你好lucy');
	});
});

describe('compareTranscripts', () => {
	it('a one-word substitution: "what\'s the news" vs "what\'s this" DIVERGES', () => {
		// The live model heard "the news" where the batch STT heard "this".
		const r = compareTranscripts("Hello, what's the news?", "Hello, what's this?");
		expect(r.diverged).toBe(true);
		expect(r.reason).toBe('diverged');
	});

	it('wake-name substitution diverges (Lucy → Siri)', () => {
		expect(
			compareTranscripts(
				'Hello, Siri. Switch to meeting mode.',
				'Oh hi Lucy, switch to meeting mode.',
			).diverged,
		).toBe(true);
	});

	it('identical after normalization is a match', () => {
		expect(compareTranscripts("HI, what's this?", 'hi whats this').diverged).toBe(false);
	});

	it('containment = streaming truncation, NOT a mishear', () => {
		// Streaming transcription often reports only a fragment of the utterance.
		const r = compareTranscripts('what should i', 'Um yeah, what should I look at first?');
		expect(r.diverged).toBe(false);
		expect(r.reason).toBe('match');
	});

	it('empty sides never diverge (coverage gap ≠ mishear)', () => {
		expect(compareTranscripts('', 'hi lucy').reason).toBe('empty-live');
		expect(compareTranscripts('hi lucy', '').reason).toBe('empty-shadow');
		expect(compareTranscripts('', '').reason).toBe('both-empty');
		for (const pair of [
			['', 'x'],
			['x', ''],
			['', ''],
		] as const) {
			expect(compareTranscripts(pair[0], pair[1]).diverged).toBe(false);
		}
	});

	it('a prefix mishear with similar length DIVERGES', () => {
		// "what is this" heard when "what is this news" was said — strict prefix,
		// ratio 0.71: a real edge-word mishear that blanket containment would swallow.
		const r = compareTranscripts('What is this news', 'What is this');
		expect(r.diverged).toBe(true);
		// and the symmetric direction
		expect(compareTranscripts('What is this', 'What is this news').diverged).toBe(true);
	});

	it('punctuation-only differences are a match (comma vs period)', () => {
		expect(compareTranscripts('Hello. What’s this?', 'Hello, what’s this?').diverged).toBe(false);
	});
});

describe('isSubstantiveDivergence (mute gate — keeps interruptions rare)', () => {
	it('a one-word substitution is substantive → mutes', () => {
		expect(isSubstantiveDivergence("Hello, what's the news?", "Hello, what's this?")).toBe(true);
	});
	it('wake-name substitution is substantive', () => {
		expect(isSubstantiveDivergence('Alucir, can you hear me?', 'Hi Lucy, can you hear me?')).toBe(
			true,
		);
	});
	it('filler-only difference never mutes', () => {
		expect(isSubstantiveDivergence('Yeah, makes sense.', 'Makes sense.')).toBe(false);
	});
	it('short leading artifact never mutes', () => {
		expect(isSubstantiveDivergence('it Can you hear me?', 'Can you hear me?')).toBe(false);
	});
	it('digit differences are substantive even when short', () => {
		expect(isSubstantiveDivergence('go to slide 3', 'go to slide 8')).toBe(true);
	});
});

describe('isSubstantiveDivergence — stutter repeats never trigger a correction', () => {
	it('repeat-count differences of the same word never mute', () => {
		expect(
			isSubstantiveDivergence(
				"What's What What What should I get How should I get started besides the video?",
				"Uh what's what's a what what uh should I get how should I get started besides the video?",
			),
		).toBe(false);
	});
	it('true word substitutions still mute at set level', () => {
		expect(isSubstantiveDivergence("what's the news", "what's this")).toBe(true);
	});
});
