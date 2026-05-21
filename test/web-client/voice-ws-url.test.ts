// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildVoiceWebSocketUrl } from '../../app/web-client/src/voice-ws-url.js';

describe('buildVoiceWebSocketUrl', () => {
	it('appends userId and agentProfile', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://localhost:9900',
			clientUserId: 'u1',
			agentProfile: 'standard',
		});
		expect(u).toContain('userId=u1');
		expect(u).toContain('agentProfile=standard');
	});

	it('forceClientMedia direct_rtc adds rtcAudio', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h/ws',
			clientUserId: 'x',
			agentProfile: 'standard',
			forceClientMedia: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
		});
		expect(u).toContain('clientMedia=direct_rtc');
		expect(u).toContain('rtcAudio=werift_opus');
	});

	it('forceClientMedia websocket does not add rtcAudio', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			forceClientMedia: { kind: 'websocket' },
		});
		expect(u).toContain('clientMedia=websocket');
		expect(u).not.toContain('rtcAudio=');
	});

	it('prefers forceClientMedia over clientMediaOverrideKind', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			clientMediaOverrideKind: 'websocket',
			forceClientMedia: { kind: 'direct_rtc', rtcAudio: 'none' },
		});
		expect(u).toContain('clientMedia=direct_rtc');
		expect(u).toContain('rtcAudio=none');
		expect(u).not.toMatch(/clientMedia=websocket/);
	});

	it('omits TTS params for agent default', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			talkTtsConfig: { provider: 'agent_default' },
		});
		expect(u).not.toContain('ttsProvider=');
	});

	it('adds explicit native TTS override', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			talkTtsConfig: {
				provider: 'native',
				nativeVoiceProvider: 'gemini',
				geminiVoiceName: 'Puck',
			},
		});
		expect(u).toContain('ttsProvider=native');
		expect(u).toContain('realtimeProvider=gemini');
		expect(u).toContain('geminiRealtimeVoice=Puck');
	});

	it('adds explicit OpenAI native voice override from speech output', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			talkTtsConfig: {
				provider: 'native',
				nativeVoiceProvider: 'openai',
				openaiVoice: 'marin',
			},
		});
		expect(u).toContain('ttsProvider=native');
		expect(u).toContain('realtimeProvider=openai');
		expect(u).toContain('openaiRealtimeVoice=marin');
	});

	it('does not duplicate realtime voice params when speech output selects native voice', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			talkTtsConfig: {
				provider: 'native',
				nativeVoiceProvider: 'openai',
				openaiVoice: 'marin',
			},
			openaiRealtimeVoice: 'sage',
		});
		expect(u.match(/openaiRealtimeVoice=/g)).toHaveLength(1);
		expect(u).toContain('openaiRealtimeVoice=marin');
		expect(u).not.toContain('openaiRealtimeVoice=sage');
	});

	it('adds external TTS provider params', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			talkTtsConfig: {
				provider: 'cartesia',
				voiceId: 'voice-1',
				modelId: 'sonic-3.5',
				speed: 'fast',
				emotion: 'happy, curious',
				apiKeyName: 'CARTESIA_API_KEY',
			},
		});
		expect(u).toContain('ttsProvider=cartesia');
		expect(u).toContain('ttsVoiceId=voice-1');
		expect(u).toContain('ttsModelId=sonic-3.5');
		expect(u).toContain('ttsSpeed=fast');
		expect(u).toContain('ttsEmotion=happy%2C%20curious');
		expect(u).toContain('ttsApiKeyName=CARTESIA_API_KEY');
	});

	it('adds guided ElevenLabs tuning params', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			talkTtsConfig: {
				provider: 'elevenlabs',
				voiceId: 'voice-2',
				modelId: 'eleven_flash_v2_5',
				languageCode: 'en',
				stability: 0.7,
				similarityBoost: 0.8,
				style: 0.2,
				useSpeakerBoost: true,
			},
		});
		expect(u).toContain('ttsProvider=elevenlabs');
		expect(u).toContain('ttsModelId=eleven_flash_v2_5');
		expect(u).toContain('ttsLanguage=en');
		expect(u).toContain('ttsStability=0.7');
		expect(u).toContain('ttsSimilarityBoost=0.8');
		expect(u).toContain('ttsStyle=0.2');
		expect(u).toContain('ttsUseSpeakerBoost=true');
	});

	it('adds guided Hume Octave params', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			talkTtsConfig: {
				provider: 'hume',
				voiceName: 'Ava Song',
				voiceProvider: 'HUME_AI',
				version: '2',
				speed: 1.15,
				description: 'Warm and patient',
			},
		});
		expect(u).toContain('ttsProvider=hume');
		expect(u).toContain('ttsVoiceName=Ava%20Song');
		expect(u).toContain('ttsVoiceProvider=HUME_AI');
		expect(u).toContain('ttsVersion=2');
		expect(u).toContain('ttsSpeed=1.15');
		expect(u).toContain('ttsDescription=Warm%20and%20patient');
	});
});
