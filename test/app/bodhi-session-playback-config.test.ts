import { describe, expect, it, vi } from 'vitest';
import { createBodhiSessionConfig } from '../../app/agents/bodhi-session.js';

/** The factory now returns { voiceSessionConfig, profileLifecycle }; these
 *  threading tests only inspect the config. */
async function createConfig(options: Parameters<typeof createBodhiSessionConfig>[0]) {
	return (await createBodhiSessionConfig(options)).voiceSessionConfig;
}

function baseOptions() {
	return {
		apiKey: 'test-key',
		memoryStore: {
			addFacts: vi.fn(),
			getAll: vi.fn(async () => []),
			replaceAll: vi.fn(),
			getDirectives: vi.fn(async () => ({})),
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
		const config = await createConfig({
			...baseOptions(),
			playbackStateProtocol: 'audio_done',
			ttsPlaybackFallbackMarginMs: 2000,
		});
		expect(config.playbackStateProtocol).toBe('audio_done');
		expect(config.ttsPlaybackFallbackMarginMs).toBe(2000);
	});

	it('leaves both undefined when the options are not provided', async () => {
		const config = await createConfig(baseOptions());
		expect(config.playbackStateProtocol).toBeUndefined();
		expect(config.ttsPlaybackFallbackMarginMs).toBeUndefined();
	});

	it('threads nativePlaybackGating into VoiceSessionConfig', async () => {
		const onConfig = await createConfig({
			...baseOptions(),
			nativePlaybackGating: true,
		});
		expect(onConfig.nativePlaybackGating).toBe(true);
		const offConfig = await createConfig(baseOptions());
		expect(offConfig.nativePlaybackGating).toBeUndefined();
	});

	it('threads explicit greetingInterruptGraceMs overrides into VoiceSessionConfig', async () => {
		const disabledConfig = await createConfig({
			...baseOptions(),
			greetingInterruptGraceMs: 0,
		});
		expect(disabledConfig.greetingInterruptGraceMs).toBe(0);

		const inheritedConfig = await createConfig(baseOptions());
		expect(inheritedConfig.greetingInterruptGraceMs).toBeUndefined();
	});

	it('threads explicit clientAudioInputRate overrides into VoiceSessionConfig', async () => {
		const config = await createConfig({
			...baseOptions(),
			clientAudioInputRate: 16000,
		});
		expect(config.clientAudioInputRate).toBe(16000);
	});
});

describe('createBodhiSessionConfig — watchdog replay recovery threading (H2)', () => {
	it('threads watchdogReplayRecovery for gemini sessions; absent by default', async () => {
		const on = await createConfig({
			...baseOptions(),
			watchdogReplayRecovery: true,
		});
		expect(on.watchdogReplayRecovery).toBe(true);

		const off = await createConfig(baseOptions());
		expect(off.watchdogReplayRecovery).toBeUndefined();
	});

	it('does NOT forward watchdogReplayRecovery for the openai provider (replay is Gemini-only)', async () => {
		const config = await createConfig({
			...baseOptions(),
			liveRealtimeProvider: 'openai' as const,
			openAiApiKey: 'test-openai-key',
			watchdogReplayRecovery: true,
		});
		expect(config.watchdogReplayRecovery).toBeUndefined();
	});

	it('threads an explicit responseWatchdogMs override verbatim', async () => {
		const config = await createConfig({
			...baseOptions(),
			responseWatchdogMs: 12_000,
		});
		expect(config.responseWatchdogMs).toBe(12_000);
	});

	it('no-override fallback is gemini-3.1 (fast model): no derived window', async () => {
		// The hosted fallback moved to the half-cascade live model — fast
		// first-token latency, so the framework 5 s default window applies.
		const config = await createConfig({
			...baseOptions(),
			watchdogReplayRecovery: true,
		});
		expect(config.geminiModel).toBe('gemini-3.1-flash-live-preview');
		expect(config.responseWatchdogMs).toBeUndefined();
	});

	it('derives the slow-model window for BOTH 2.5 native-audio catalog ids (override UI)', async () => {
		for (const liveRealtimeModel of [
			'gemini-2.5-flash-native-audio-preview-12-2025',
			'gemini-live-2.5-flash-native-audio',
		]) {
			const config = await createConfig({
				...baseOptions(),
				liveRealtimeModel,
				watchdogReplayRecovery: true,
			});
			expect(config.responseWatchdogMs).toBe(8000);
		}
	});

	it('keeps the framework default window on gemini-3.1-flash-live-preview', async () => {
		const config = await createConfig({
			...baseOptions(),
			liveRealtimeModel: 'gemini-3.1-flash-live-preview',
			watchdogReplayRecovery: true,
		});
		expect(config.responseWatchdogMs).toBeUndefined();
	});

	it('does not derive a window when replay recovery is off (two independent knobs)', async () => {
		const config = await createConfig(baseOptions());
		expect(config.responseWatchdogMs).toBeUndefined();
	});

	it('an explicit responseWatchdogMs wins over the derived slow-model window', async () => {
		const config = await createConfig({
			...baseOptions(),
			watchdogReplayRecovery: true,
			responseWatchdogMs: 9_500,
		});
		expect(config.responseWatchdogMs).toBe(9_500);
	});
});

describe('createBodhiSessionConfig — Gemini server-VAD default', () => {
	it('defaults hosted Gemini sessions to silenceDurationMs 300 (down from the framework 500)', async () => {
		const config = await createConfig(baseOptions());
		expect(config.realtimeInputConfig).toEqual({
			automaticActivityDetection: { silenceDurationMs: 300 },
		});
	});

	it('does not apply the Gemini VAD default to openai-provider sessions', async () => {
		const config = await createConfig({
			...baseOptions(),
			liveRealtimeProvider: 'openai' as const,
			openAiApiKey: 'test-openai-key',
		});
		expect(config.realtimeInputConfig).toBeUndefined();
	});
});
