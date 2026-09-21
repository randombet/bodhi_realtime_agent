import { afterEach, describe, expect, it } from 'vitest';
import { resolveTtsForSession } from '../../app/lib/media/tts-config.js';

const OLD_CARTESIA = process.env.CARTESIA_API_KEY;
const OLD_ELEVENLABS = process.env.ELEVENLABS_API_KEY;
const OLD_HUME = process.env.HUME_API_KEY;
const OLD_OVERRIDE = process.env.BODHI_TTS_EMERGENCY_OVERRIDE;

function restoreEnv(name: string, oldValue: string | undefined): void {
	if (oldValue === undefined) Reflect.deleteProperty(process.env, name);
	else process.env[name] = oldValue;
}

function clearEnv(name: string): void {
	Reflect.deleteProperty(process.env, name);
}

afterEach(() => {
	restoreEnv('CARTESIA_API_KEY', OLD_CARTESIA);
	restoreEnv('ELEVENLABS_API_KEY', OLD_ELEVENLABS);
	restoreEnv('HUME_API_KEY', OLD_HUME);
	restoreEnv('BODHI_TTS_EMERGENCY_OVERRIDE', OLD_OVERRIDE);
});

describe('TTS config resolver', () => {
	it('uses per-session override before saved agent config', () => {
		process.env.CARTESIA_API_KEY = 'car-key';
		process.env.ELEVENLABS_API_KEY = 'el-key';
		clearEnv('BODHI_TTS_EMERGENCY_OVERRIDE');

		const resolved = resolveTtsForSession({
			overrideConfig: {
				provider: 'elevenlabs',
				voiceId: 'voice-el',
				modelId: 'eleven_flash_v2_5',
			},
			savedConfig: {
				provider: 'cartesia',
				voiceId: 'voice-car',
				modelId: 'sonic-3.5',
			},
		});

		expect(resolved).toMatchObject({
			provider: 'elevenlabs',
			apiKey: 'el-key',
			voiceId: 'voice-el',
			modelId: 'eleven_flash_v2_5',
		});
	});

	it('keeps query override ahead of mobile/phone override', () => {
		process.env.CARTESIA_API_KEY = 'car-key';
		process.env.ELEVENLABS_API_KEY = 'el-key';
		clearEnv('BODHI_TTS_EMERGENCY_OVERRIDE');

		const resolved = resolveTtsForSession({
			query: new URLSearchParams({
				ttsProvider: 'cartesia',
				ttsVoiceId: 'voice-car-query',
				ttsModelId: 'sonic-3.5',
			}),
			overrideConfig: {
				provider: 'elevenlabs',
				voiceId: 'voice-el',
			},
		});

		expect(resolved).toMatchObject({
			provider: 'cartesia',
			apiKey: 'car-key',
			voiceId: 'voice-car-query',
		});
	});

	it('lets native override disable saved external TTS', () => {
		process.env.CARTESIA_API_KEY = 'car-key';
		clearEnv('BODHI_TTS_EMERGENCY_OVERRIDE');

		const resolved = resolveTtsForSession({
			overrideConfig: { provider: 'native' },
			savedConfig: {
				provider: 'cartesia',
				voiceId: 'voice-car',
			},
		});

		expect(resolved).toBeUndefined();
	});

	it('resolves Hume from user BYOK before server fallback env', () => {
		process.env.HUME_API_KEY = 'server-hume-key';
		clearEnv('BODHI_TTS_EMERGENCY_OVERRIDE');

		const resolved = resolveTtsForSession({
			overrideConfig: {
				provider: 'hume',
				voiceName: 'Ava Song',
				voiceProvider: 'HUME_AI',
				version: '2',
			},
			userKeyMap: new Map([['HUME_API_KEY', 'user-hume-key']]),
		});

		expect(resolved).toMatchObject({
			provider: 'hume',
			apiKey: 'user-hume-key',
			voiceName: 'Ava Song',
			voiceProvider: 'HUME_AI',
			version: '2',
		});
	});
});
