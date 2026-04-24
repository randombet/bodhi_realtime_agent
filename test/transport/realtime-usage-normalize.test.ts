// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	normalizeGeminiUsageMetadata,
	normalizeOpenAIResponseUsage,
	normalizeOpenAITranscriptionUsage,
} from '../../src/transport/realtime-usage-normalize.js';

describe('normalizeGeminiUsageMetadata', () => {
	it('maps camelCase usageMetadata to a response update event', () => {
		const raw = {
			promptTokenCount: 10,
			responseTokenCount: 5,
			totalTokenCount: 15,
			responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 5 }],
		};
		const ev = normalizeGeminiUsageMetadata(raw, 'update');
		expect(ev).toEqual({
			provider: 'gemini_live',
			kind: 'response',
			phase: 'update',
			unit: 'tokens',
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
			modalityBreakdown: { outputAudioTokens: 5 },
			providerRaw: raw,
		});
	});

	it('accepts snake_case fields', () => {
		const raw = { prompt_token_count: 3, response_token_count: 2, total_token_count: 5 };
		const ev = normalizeGeminiUsageMetadata(raw, 'final');
		expect(ev?.inputTokens).toBe(3);
		expect(ev?.outputTokens).toBe(2);
		expect(ev?.totalTokens).toBe(5);
		expect(ev?.phase).toBe('final');
	});

	it('returns null when no token fields are present', () => {
		expect(normalizeGeminiUsageMetadata({}, 'update')).toBeNull();
		expect(normalizeGeminiUsageMetadata(null, 'update')).toBeNull();
	});
});

describe('normalizeOpenAIResponseUsage', () => {
	it('maps response.usage with modality details', () => {
		const raw = {
			input_tokens: 132,
			output_tokens: 121,
			total_tokens: 253,
			input_token_details: {
				text_tokens: 119,
				audio_tokens: 13,
				cached_tokens: 64,
				cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 },
			},
			output_token_details: { text_tokens: 30, audio_tokens: 91 },
		};
		const ev = normalizeOpenAIResponseUsage(raw, 'resp_1');
		expect(ev).toMatchObject({
			provider: 'openai_realtime',
			kind: 'response',
			phase: 'final',
			unit: 'tokens',
			inputTokens: 132,
			outputTokens: 121,
			totalTokens: 253,
			providerResponseId: 'resp_1',
		});
		expect(ev?.modalityBreakdown).toMatchObject({
			inputTextTokens: 119,
			inputAudioTokens: 13,
			cachedTokens: 64,
			cachedTextTokens: 64,
			outputTextTokens: 30,
			outputAudioTokens: 91,
		});
	});

	it('returns null when usage is empty', () => {
		expect(normalizeOpenAIResponseUsage({}, undefined)).toBeNull();
	});
});

describe('normalizeOpenAITranscriptionUsage', () => {
	it('maps token-based transcription usage', () => {
		const raw = {
			type: 'tokens',
			total_tokens: 26,
			input_tokens: 17,
			output_tokens: 9,
			input_token_details: { text_tokens: 0, audio_tokens: 17 },
		};
		const ev = normalizeOpenAITranscriptionUsage(raw);
		expect(ev).toMatchObject({
			provider: 'openai_realtime',
			kind: 'input_transcription',
			phase: 'final',
			unit: 'tokens',
			inputTokens: 17,
			outputTokens: 9,
			totalTokens: 26,
		});
	});

	it('maps duration-based transcription usage', () => {
		const raw = { type: 'duration', seconds: 2.5 };
		const ev = normalizeOpenAITranscriptionUsage(raw);
		expect(ev).toMatchObject({
			provider: 'openai_realtime',
			kind: 'input_transcription',
			phase: 'final',
			unit: 'duration_seconds',
			durationSeconds: 2.5,
		});
	});
});
