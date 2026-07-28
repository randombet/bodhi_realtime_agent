import { describe, expect, it } from 'vitest';
import { decideFinalizationPath } from '../../../src/core/policies/finalization.policy.js';

describe('decideFinalizationPath (C1 parity)', () => {
	it('TTS sessions always defer to the tts-gate — including no-text turns (handled inside the gate)', () => {
		expect(
			decideFinalizationPath(
				{ nativePlaybackGatingActive: false },
				{ ttsEnabled: true },
				{ hasAudio: false, dispatchedToolCall: true },
			),
		).toBe('tts-gate');
	});

	it('native gating defers only audio-bearing, non-tool-continuation responses', () => {
		const caps = { nativePlaybackGatingActive: true };
		expect(
			decideFinalizationPath(
				caps,
				{ ttsEnabled: false },
				{ hasAudio: true, dispatchedToolCall: false },
			),
		).toBe('native-gate');
		expect(
			decideFinalizationPath(
				caps,
				{ ttsEnabled: false },
				{ hasAudio: false, dispatchedToolCall: false },
			),
		).toBe('immediate'); // native no-audio
		expect(
			decideFinalizationPath(
				caps,
				{ ttsEnabled: false },
				{ hasAudio: true, dispatchedToolCall: true },
			),
		).toBe('immediate'); // tool continuation
	});

	it('no gates → immediate', () => {
		expect(
			decideFinalizationPath(
				{ nativePlaybackGatingActive: false },
				{ ttsEnabled: false },
				{ hasAudio: true, dispatchedToolCall: false },
			),
		).toBe('immediate');
	});
});
