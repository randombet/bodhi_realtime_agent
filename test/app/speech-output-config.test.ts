import { describe, expect, it } from 'vitest';
import {
	parseSpeechOutputConfig,
	speechOutputRealtimeOverride,
	speechOutputToPersistedTtsConfig,
} from '../../app/agents/speech-output-config.js';

describe('speech output config', () => {
	it('parses native Gemini speech output into realtime overrides', () => {
		const parsed = parseSpeechOutputConfig({
			mode: 'native',
			provider: 'gemini',
			voiceName: 'Kore',
			model: 'gemini-live-2.5-flash-native-audio',
		});

		expect(parsed).toEqual({
			mode: 'native',
			provider: 'gemini',
			voiceName: 'Kore',
			model: 'gemini-live-2.5-flash-native-audio',
		});
		expect(speechOutputToPersistedTtsConfig(parsed)).toEqual({ provider: 'native' });
		expect(speechOutputRealtimeOverride(parsed)).toEqual({
			provider: 'gemini',
			geminiVoiceName: 'Kore',
			geminiRealtimeModel: 'gemini-live-2.5-flash-native-audio',
		});
	});

	it('supports native server/default mode without forcing Gemini or OpenAI', () => {
		const parsed = parseSpeechOutputConfig({ mode: 'native', provider: 'server' });

		expect(speechOutputToPersistedTtsConfig(parsed)).toEqual({ provider: 'native' });
		expect(speechOutputRealtimeOverride(parsed)).toBeUndefined();
	});

	it('parses external TTS into persisted provider config', () => {
		const parsed = parseSpeechOutputConfig({
			mode: 'tts',
			provider: 'elevenlabs',
			voiceId: '21m00Tcm4TlvDq8ikWAM',
			modelId: 'eleven_flash_v2_5',
			languageCode: 'en',
			apiKeyName: 'ELEVENLABS_API_KEY',
		});

		expect(speechOutputRealtimeOverride(parsed)).toBeUndefined();
		expect(speechOutputToPersistedTtsConfig(parsed)).toEqual({
			provider: 'elevenlabs',
			voiceId: '21m00Tcm4TlvDq8ikWAM',
			modelId: 'eleven_flash_v2_5',
			languageCode: 'en',
			apiKeyName: 'ELEVENLABS_API_KEY',
		});
	});

	it('resolves presetId-only TTS payloads into the shared preset config', () => {
		const parsed = parseSpeechOutputConfig({
			mode: 'tts',
			provider: 'cartesia',
			presetId: 'cartesia:jameson',
		});

		expect(speechOutputToPersistedTtsConfig(parsed)).toEqual({
			provider: 'cartesia',
			voiceId: 'a5136bf9-224c-4d76-b823-52bd5efcffcc',
			modelId: 'sonic-3.5',
			language: 'en',
			speed: 'normal',
		});
	});

	it('rejects unknown native voices', () => {
		expect(
			parseSpeechOutputConfig({
				mode: 'native',
				provider: 'gemini',
				voiceName: 'not-a-voice',
			}),
		).toBeUndefined();
	});
});
