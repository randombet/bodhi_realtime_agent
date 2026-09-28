// SPDX-License-Identifier: MIT

/**
 * Shadow-STT divergence detection — the pure half of the dual-transcription
 * feature.
 *
 * Motivation: the Live model's built-in inputAudioTranscription reports what
 * the MODEL heard — when it mishears ("what's this" → "what's the news"), the
 * transcript and the answer are consistent with each other and the error is
 * invisible. A second, batch STT pass over the same audio is structurally
 * better placed (it sees the complete utterance) and disagreement between the
 * two is the only reliable tell.
 *
 * This module owns normalization + comparison only. The session wires a
 * `shadowSttProvider` (e.g. GeminiBatchSTTProvider) whose transcript is
 * compared against the accumulated built-in transcription for the turn.
 * V1 is observation-only: divergence is logged / surfaced via a hook, and
 * NOTHING about what the model heard, said, or stored changes.
 */

/** Lowercase, strip punctuation (keep letters/digits incl. CJK), collapse
 *  whitespace — so "Hi, Lucy!" vs "hi lucy" is NOT a divergence. */
export function normalizeTranscript(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export interface DivergenceResult {
	diverged: boolean;
	/** Why not / why so — one of: 'match' | 'diverged' | 'empty-live' | 'empty-shadow' | 'both-empty' */
	reason: 'match' | 'diverged' | 'empty-live' | 'empty-shadow' | 'both-empty';
	normalizedLive: string;
	normalizedShadow: string;
}

/**
 * Compare the built-in (live) transcript against the shadow transcript.
 * Empty sides never count as divergence — a missing transcript is a
 * coverage gap, not evidence of a mishear (and the shadow provider skips
 * sub-threshold audio by design, e.g. GeminiBatchSTTProvider's RMS gate).
 */
export function compareTranscripts(liveText: string, shadowText: string): DivergenceResult {
	const live = normalizeTranscript(liveText);
	const shadow = normalizeTranscript(shadowText);
	if (!live && !shadow)
		return {
			diverged: false,
			reason: 'both-empty',
			normalizedLive: live,
			normalizedShadow: shadow,
		};
	if (!live)
		return {
			diverged: false,
			reason: 'empty-live',
			normalizedLive: live,
			normalizedShadow: shadow,
		};
	if (!shadow)
		return {
			diverged: false,
			reason: 'empty-shadow',
			normalizedLive: live,
			normalizedShadow: shadow,
		};
	if (live === shadow) {
		return { diverged: false, reason: 'match', normalizedLive: live, normalizedShadow: shadow };
	}
	// Containment: only a FRAGMENT (one side much shorter than the other) is a
	// streaming-truncation artifact, not a mishear — streaming transcription
	// often reports just part of an utterance, a common source of raw
	// divergences. But containment with SIMILAR lengths is a real edge-word
	// mishear: "what is this" heard when "what is this news" was said is a
	// strict prefix, and blanket containment would silently swallow it.
	// Fragment iff shorter/longer ≤ 0.6 (truncation example "what should i" vs
	// "um yeah what should i look at first" = 0.37 → match; the prefix mishear
	// above = 0.71 → diverged).
	if (live.includes(shadow) || shadow.includes(live)) {
		const ratio = Math.min(live.length, shadow.length) / Math.max(live.length, shadow.length);
		if (ratio <= 0.6) {
			return { diverged: false, reason: 'match', normalizedLive: live, normalizedShadow: shadow };
		}
	}
	return { diverged: true, reason: 'diverged', normalizedLive: live, normalizedShadow: shadow };
}

/** Filler tokens that carry no meaning — a divergence made ONLY of these must
 *  not interrupt anyone: muting on every inexact match would interrupt far too
 *  often over hesitations and greetings. Tunable; multilingual on purpose. */
const FILLERS = new Set([
	'uh',
	'um',
	'ah',
	'oh',
	'eh',
	'mm',
	'hmm',
	'yeah',
	'yes',
	'ok',
	'okay',
	'hi',
	'hey',
	'hello',
	'like',
	'so',
	'well',
	'just',
	'呃',
	'嗯',
	'啊',
	'哦',
	'就是',
	'那个',
	'这个',
	'就',
]);

/**
 * Is a detected divergence MEANING-BEARING — worth muting the live answer and
 * speaking a correction? Two-tier design: `compareTranscripts` stays sensitive
 * (log everything → data), this gate keeps the INTERRUPTION rare:
 *  - strip filler tokens from both sides;
 *  - if the filler-stripped sequences are identical → not substantive;
 *  - otherwise substantive only if the symmetric difference contains at least
 *    one content-ish token (≥3 chars, or any digit) — a stray short artifact
 *    ("it", "a", a single kana) never mutes.
 * Examples of transcript pairs: "whats the news"/"whats this" →
 * substantive (news/this differ, "news" ≥3); "yeah makes sense"/"makes sense"
 * → filler-only → NO mute; "it can you hear me"/"can you hear me" → "it" <3
 * chars → NO mute; "alucir can you hear me"/"hi lucy can you hear me" →
 * substantive (wake-name substitution).
 */
export function isSubstantiveDivergence(liveText: string, shadowText: string): boolean {
	const strip = (s: string): string[] =>
		normalizeTranscript(s)
			.split(' ')
			.filter((w) => w && !FILLERS.has(w));
	const a = strip(liveText);
	const b = strip(shadowText);
	if (a.join(' ') === b.join(' ')) return false;
	// SET-based symmetric difference, not counts: a stutter — "what's what's"
	// vs "what's" — is a COUNT difference of a ≥3-char word, and counting it
	// would fire a false spoken correction mid-session. A word present on BOTH
	// sides at any count is never evidence of a mishear; only words exclusive
	// to one side are.
	const setA = new Set(a);
	const setB = new Set(b);
	const diff: string[] = [];
	for (const w of setA) if (!setB.has(w)) diff.push(w);
	for (const w of setB) if (!setA.has(w)) diff.push(w);
	return diff.some((w) => w.length >= 3 || /\d/.test(w));
}
