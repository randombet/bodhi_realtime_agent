// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { createBodhiSessionConfig } from '../../app/agents/bodhi-session.js';

function baseOptions() {
	return {
		apiKey: 'test-key',
		memoryStore: {
			addFacts: vi.fn(),
			getAll: vi.fn(async () => []),
			replaceAll: vi.fn(),
			getDirectives: vi.fn(async () => null),
			setDirectives: vi.fn(),
		},
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		sessionId: 'sess_test',
		userId: 'user_test',
		getSessionRef: () => null,
	};
}

describe('createBodhiSessionConfig — playback-state config threading', () => {
	it('threads playbackStateProtocol and ttsPlaybackFallbackMarginMs into VoiceSessionConfig', async () => {
		const config = await createBodhiSessionConfig({
			...baseOptions(),
			playbackStateProtocol: 'audio_done',
			ttsPlaybackFallbackMarginMs: 2000,
		});
		expect(config.playbackStateProtocol).toBe('audio_done');
		expect(config.ttsPlaybackFallbackMarginMs).toBe(2000);
	});

	it('leaves both undefined when the options are not provided', async () => {
		const config = await createBodhiSessionConfig(baseOptions());
		expect(config.playbackStateProtocol).toBeUndefined();
		expect(config.ttsPlaybackFallbackMarginMs).toBeUndefined();
	});

	it('threads nativePlaybackGating into VoiceSessionConfig', async () => {
		const onConfig = await createBodhiSessionConfig({
			...baseOptions(),
			nativePlaybackGating: true,
		});
		expect(onConfig.nativePlaybackGating).toBe(true);
		const offConfig = await createBodhiSessionConfig(baseOptions());
		expect(offConfig.nativePlaybackGating).toBeUndefined();
	});

	it('threads explicit greetingInterruptGraceMs overrides into VoiceSessionConfig', async () => {
		const disabledConfig = await createBodhiSessionConfig({
			...baseOptions(),
			greetingInterruptGraceMs: 0,
		});
		expect(disabledConfig.greetingInterruptGraceMs).toBe(0);

		const inheritedConfig = await createBodhiSessionConfig(baseOptions());
		expect(inheritedConfig.greetingInterruptGraceMs).toBeUndefined();
	});
});
