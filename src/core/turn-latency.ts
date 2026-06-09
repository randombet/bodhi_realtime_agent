// SPDX-License-Identifier: MIT

/**
 * Pure latency-segment math for `FrameworkHooks.onTurnLatency`, extracted so it
 * can be unit-tested without the VoiceSession harness.
 *
 * All inputs are timestamps from the session metric clock (`VoiceSessionConfig.nowMs`)
 * — never mix clocks (see design §9 "clock discipline"). The public segment field
 * names are Gemini-flavored (`backendToGeminiMs`, `geminiProcessingMs`) but their
 * meaning is transport-agnostic; renaming the published `FrameworkHooks` type is a
 * Non-Goal, so the mapping is documented here instead.
 */

/** Segment breakdown matching the `onTurnLatency` event's `segments` shape. */
export interface TurnLatencySegments {
	clientToBackendMs?: number;
	backendToGeminiMs?: number;
	geminiProcessingMs?: number;
	geminiToBackendMs?: number;
	backendToClientMs?: number;
	totalE2EMs: number;
}

/** Raw per-turn timestamps (metric clock); `null` when the edge was not observed. */
export interface TurnLatencyStamps {
	/** End of user speech (VAD end) — the stop-to-first-audio anchor. */
	userSpeechEndMs: number | null;
	/** Provider began the response (`onModelTurnStart`). */
	modelStartMs: number | null;
	/** First audio chunk delivered to the client (`onFirstAudioChunk`). */
	firstAudioMs: number | null;
}

/**
 * Compute the latency segments from per-turn stamps, or `null` when the headline
 * number cannot be formed (no user-speech-end or no audio was produced — e.g. a
 * tool-only turn). Negative spans are clamped to 0 to absorb minor clock/order skew.
 *
 * Mapping (transport-agnostic):
 * - `totalE2EMs`        = firstAudio − userSpeechEnd   (stop-to-first-audio, the headline)
 * - `geminiProcessingMs`= modelStart − userSpeechEnd   (user stop → provider response start ≈ TTFT)
 * - `backendToClientMs` = firstAudio − modelStart      (provider start → first audio out)
 */
export function computeTurnLatencySegments(stamps: TurnLatencyStamps): TurnLatencySegments | null {
	const { userSpeechEndMs, modelStartMs, firstAudioMs } = stamps;
	if (userSpeechEndMs === null || firstAudioMs === null) return null;

	const segments: TurnLatencySegments = {
		totalE2EMs: Math.max(0, firstAudioMs - userSpeechEndMs),
	};
	if (modelStartMs !== null) {
		segments.geminiProcessingMs = Math.max(0, modelStartMs - userSpeechEndMs);
		segments.backendToClientMs = Math.max(0, firstAudioMs - modelStartMs);
	}
	return segments;
}
