/**
 * Finalization-path selector (appendix C1) — pure, parity-only extraction
 * (design-speech-evidence-architecture.md §2). Response-specific inputs are
 * required, not optional: native deferral applies only to audio-bearing,
 * non-tool-continuation responses, and TTS keeps its own no-text completion
 * path INSIDE the tts-gate branch (a caps-only selector would wrongly defer
 * tool-only and no-audio responses). All effect ordering stays in
 * `VoiceSession.handleTurnComplete` / `finalizeTurn` (C2 sequencing).
 *
 * Internal — not exported from the package index.
 */

export type FinalizationPath = 'tts-gate' | 'native-gate' | 'immediate';

export function decideFinalizationPath(
	caps: { nativePlaybackGatingActive: boolean },
	mode: { ttsEnabled: boolean },
	response: { hasAudio: boolean; dispatchedToolCall: boolean },
): FinalizationPath {
	if (mode.ttsEnabled) return 'tts-gate';
	if (caps.nativePlaybackGatingActive && response.hasAudio && !response.dispatchedToolCall) {
		return 'native-gate';
	}
	return 'immediate';
}
