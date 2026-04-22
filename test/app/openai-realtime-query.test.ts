// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	parseGeminiRealtimeModelQuery,
	parseOpenAiRealtimeModelQuery,
	parseOpenAiRealtimeVoiceQuery,
} from '../../app/server/openai-realtime-query.js';

describe('parseGeminiRealtimeModelQuery', () => {
	it('accepts known Gemini realtime models', () => {
		expect(parseGeminiRealtimeModelQuery('gemini-2.5-flash-native-audio-preview-12-2025')).toBe(
			'gemini-2.5-flash-native-audio-preview-12-2025',
		);
		expect(parseGeminiRealtimeModelQuery('gemini-3.1-flash-live-preview')).toBe(
			'gemini-3.1-flash-live-preview',
		);
	});

	it('rejects unknown Gemini models', () => {
		expect(parseGeminiRealtimeModelQuery('gemini-1.5-pro')).toBeUndefined();
	});
});

describe('parseOpenAiRealtimeModelQuery', () => {
	it('accepts known OpenAI realtime model ids', () => {
		expect(parseOpenAiRealtimeModelQuery('gpt-4o-realtime-preview')).toBe(
			'gpt-4o-realtime-preview',
		);
		expect(parseOpenAiRealtimeModelQuery('gpt-4o-mini-realtime-preview')).toBe(
			'gpt-4o-mini-realtime-preview',
		);
	});

	it('rejects unknown model ids', () => {
		expect(parseOpenAiRealtimeModelQuery('gpt-4o;drop')).toBeUndefined();
		expect(parseOpenAiRealtimeModelQuery('')).toBeUndefined();
	});
});

describe('parseOpenAiRealtimeVoiceQuery', () => {
	it('accepts known voices', () => {
		expect(parseOpenAiRealtimeVoiceQuery('coral')).toBe('coral');
	});

	it('rejects unknown', () => {
		expect(parseOpenAiRealtimeVoiceQuery('fake-voice')).toBeUndefined();
	});
});
