// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	configForSpeechOutputPreset,
	nativeVoiceForSpeechOutputPreset,
	presetIdForPersistedTtsConfig,
	presetIdForStudioSpeechOutput,
	presetIdForTalkTtsConfig,
} from '../../app/web-client/src/tts-presets.js';

describe('TTS speech output presets', () => {
	it('maps Cartesia featured voices to human-readable preset configs', () => {
		const config = configForSpeechOutputPreset('cartesia:katie');

		expect(config).toMatchObject({
			provider: 'cartesia',
			voiceId: 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
			modelId: 'sonic-3.5',
			language: 'en',
			speed: 'normal',
		});
	});

	it('derives the featured preset from saved ttsConfig', () => {
		expect(
			presetIdForPersistedTtsConfig({
				provider: 'cartesia',
				voiceId: 'a5136bf9-224c-4d76-b823-52bd5efcffcc',
				modelId: 'sonic-3.5',
				language: 'en',
				speed: 'normal',
			}),
		).toBe('cartesia:jameson');
	});

	it('maps ElevenLabs featured voices to guided model configs', () => {
		expect(configForSpeechOutputPreset('elevenlabs:alita')).toMatchObject({
			provider: 'elevenlabs',
			voiceId: 'sB1b5zUrxQVAFl2PhZFp',
			modelId: 'eleven_flash_v2_5',
			languageCode: 'en',
		});
	});

	it('keeps Hume Octave feature presets distinct', () => {
		expect(
			presetIdForPersistedTtsConfig({
				provider: 'hume',
				voiceName: 'Ava Song',
				voiceProvider: 'HUME_AI',
				version: '2',
				speed: 1,
			}),
		).toBe('hume:ava_octave2');
	});

	it('routes unknown provider configs to the custom path', () => {
		expect(
			presetIdForPersistedTtsConfig({
				provider: 'cartesia',
				voiceId: 'custom-voice',
				modelId: 'sonic-3.5',
			}),
		).toBe('custom:cartesia');
	});

	it('keeps Talk agent default distinct from native audio', () => {
		expect(presetIdForTalkTtsConfig({ provider: 'agent_default' })).toBe('agent_default');
		expect(presetIdForTalkTtsConfig({ provider: 'native' })).toBe('native:server');
		expect(
			presetIdForTalkTtsConfig({
				provider: 'native',
				nativeVoiceProvider: 'gemini',
				geminiVoiceName: 'Puck',
			}),
		).toBe('native:gemini:Puck');
	});

	it('maps saved native speech output to the active realtime provider voice', () => {
		expect(
			presetIdForStudioSpeechOutput({
				ttsConfig: { provider: 'native' },
				realtimeProvider: 'openai',
				openaiVoice: 'marin',
			}),
		).toBe('native:openai:marin');
		expect(nativeVoiceForSpeechOutputPreset('native:gemini:Kore')).toEqual({
			provider: 'gemini',
			voice: 'Kore',
		});
	});
});
