/**
 * Barge-in decision policy (appendix A1-A6) — pure and parity-only
 * (design-speech-evidence-architecture.md §2): the decision rules move out of
 * `VoiceSession.runClientVadBargeInPolicy`; the session keeps the ORDERED
 * greeting-gate check (`requestInterrupt` before marking fired — A4), the
 * one-shot missed/fired marking, actuation, logs, and metrics. The 400 ms
 * native echo-skip (A5) and playback-gate eligibility (A1) reach this policy
 * through the `assistantAudioActive` input, which the session computes.
 *
 * Internal — not exported from the package index.
 */

import {
	type ResolvedClientAudioVadConfig,
	clientVadBargeInAllowed,
	clientVadBargeInEnergyEligible,
} from '../voice-session.js';

export interface BargeInDecision {
	/** The frame cleared the in-TTS echo floor — mark the segment a potential
	 *  barge-in UNCONDITIONALLY (even before a playback gate arms), so
	 *  `finishOrDeferForVad` can key on it. */
	markEligible: boolean;
	/** Thresholds + eligibility passed — the session may now consult the
	 *  greeting gate (ordered BEFORE marking fired) and actuate. */
	attempt: boolean;
}

export function decideBargeIn(
	cfg: ResolvedClientAudioVadConfig,
	frame: { maxAbs: number; avgAbs: number; elapsedMs: number },
	playback: { assistantAudioActive: boolean },
	segment: { fired: boolean },
): BargeInDecision {
	const markEligible = clientVadBargeInEnergyEligible(cfg, frame.maxAbs, frame.avgAbs);
	const attempt =
		playback.assistantAudioActive &&
		!segment.fired &&
		clientVadBargeInAllowed(cfg, frame.elapsedMs, frame.maxAbs, frame.avgAbs);
	return { markEligible, attempt };
}
