import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTtsForSession } from '../../app/lib/media/tts-config.js';

const ENV_KEYS = [
	'CARTESIA_API_KEY',
	'ELEVENLABS_API_KEY',
	'HUME_API_KEY',
	'BODHI_TTS_EMERGENCY_OVERRIDE',
	'BODHI_TTS_PROVIDER',
	'CARTESIA_TTS_ENABLED',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	savedEnv.clear();
});

describe('resolveTtsForSession', () => {
	it('does not select external TTS from provider API key presence alone', () => {
		process.env.CARTESIA_API_KEY = 'env-cartesia-key';

		expect(resolveTtsForSession({})).toBeUndefined();
	});

	it('ignores legacy/default provider env selectors on the normal path', () => {
		process.env.CARTESIA_API_KEY = 'env-cartesia-key';
		process.env.CARTESIA_TTS_ENABLED = 'true';
		process.env.BODHI_TTS_PROVIDER = 'cartesia';

		expect(resolveTtsForSession({})).toBeUndefined();
	});

	it('resolves a saved provider selection using the matching env fallback key', () => {
		process.env.CARTESIA_API_KEY = 'env-cartesia-key';

		const resolved = resolveTtsForSession({
			savedConfig: {
				provider: 'cartesia',
				voiceId: 'voice-1',
				speed: 'fast',
			},
		});

		expect(resolved).toMatchObject({
			provider: 'cartesia',
			apiKey: 'env-cartesia-key',
			voiceId: 'voice-1',
			speed: 'fast',
		});
	});

	it('resolves explicit query provider selection using generic TTS params', () => {
		process.env.CARTESIA_API_KEY = 'env-cartesia-key';
		const query = new URLSearchParams({
			ttsProvider: 'cartesia',
			ttsVoiceId: 'voice-query',
			ttsModelId: 'sonic-3.5',
			ttsSpeed: 'fast',
			ttsEmotion: 'happy, curious',
		});

		const resolved = resolveTtsForSession({ query });

		expect(resolved).toMatchObject({
			provider: 'cartesia',
			apiKey: 'env-cartesia-key',
			voiceId: 'voice-query',
			modelId: 'sonic-3.5',
			speed: 'fast',
			emotion: ['happy', 'curious'],
		});
	});

	it('does not treat legacy Cartesia-only query fields as provider selection', () => {
		process.env.CARTESIA_API_KEY = 'env-cartesia-key';
		const query = new URLSearchParams({
			cartesiaVoiceId: 'voice-legacy',
			cartesiaSpeed: 'fast',
		});

		expect(resolveTtsForSession({ query })).toBeUndefined();
	});

	it('prefers user BYOK keys over env fallback keys', () => {
		process.env.ELEVENLABS_API_KEY = 'env-eleven-key';
		const userKeyMap = new Map([['ELEVENLABS_API_KEY', 'user-eleven-key']]);

		const resolved = resolveTtsForSession({
			savedConfig: {
				provider: 'elevenlabs',
				voiceId: 'voice-2',
			},
			userKeyMap,
		});

		expect(resolved).toMatchObject({
			provider: 'elevenlabs',
			apiKey: 'user-eleven-key',
			voiceId: 'voice-2',
		});
	});

	it('resolves ElevenLabs query model and voice settings', () => {
		process.env.ELEVENLABS_API_KEY = 'env-eleven-key';
		const query = new URLSearchParams({
			ttsProvider: 'elevenlabs',
			ttsVoiceId: 'voice-2',
			ttsModelId: 'eleven_flash_v2_5',
			ttsLanguage: 'en',
			ttsStability: '0.7',
			ttsSimilarityBoost: '0.8',
			ttsStyle: '0.2',
			ttsUseSpeakerBoost: 'true',
		});

		const resolved = resolveTtsForSession({ query });

		expect(resolved).toMatchObject({
			provider: 'elevenlabs',
			apiKey: 'env-eleven-key',
			voiceId: 'voice-2',
			modelId: 'eleven_flash_v2_5',
			languageCode: 'en',
			stability: 0.7,
			similarityBoost: 0.8,
			style: 0.2,
			useSpeakerBoost: true,
		});
	});

	it('resolves Hume query Octave settings', () => {
		process.env.HUME_API_KEY = 'env-hume-key';
		const query = new URLSearchParams({
			ttsProvider: 'hume',
			ttsVoiceName: 'Ava Song',
			ttsVoiceProvider: 'HUME_AI',
			ttsVersion: '2',
			ttsSpeed: '1.15',
			ttsDescription: 'Warm and patient',
		});

		const resolved = resolveTtsForSession({ query });

		expect(resolved).toMatchObject({
			provider: 'hume',
			apiKey: 'env-hume-key',
			voiceName: 'Ava Song',
			voiceProvider: 'HUME_AI',
			version: '2',
			speed: 1.15,
			description: 'Warm and patient',
		});
	});

	it('allows emergency override to force native audio', () => {
		process.env.CARTESIA_API_KEY = 'env-cartesia-key';
		process.env.BODHI_TTS_EMERGENCY_OVERRIDE = JSON.stringify({ provider: 'native' });

		const resolved = resolveTtsForSession({
			savedConfig: {
				provider: 'cartesia',
				voiceId: 'voice-1',
			},
		});

		expect(resolved).toBeUndefined();
	});

	it('allows emergency override to force a provider selection globally', () => {
		process.env.HUME_API_KEY = 'env-hume-key';
		process.env.BODHI_TTS_EMERGENCY_OVERRIDE = JSON.stringify({
			provider: 'hume',
			voiceName: 'Override voice',
		});

		const resolved = resolveTtsForSession({
			savedConfig: {
				provider: 'cartesia',
				voiceId: 'voice-1',
			},
			userKeyMap: new Map([['CARTESIA_API_KEY', 'user-cartesia-key']]),
		});

		expect(resolved).toMatchObject({
			provider: 'hume',
			apiKey: 'env-hume-key',
			voiceName: 'Override voice',
		});
	});
});
