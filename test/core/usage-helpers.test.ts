// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	computeCacheHitRatio,
	deriveProviderItemId,
	deriveUsageSource,
} from '../../src/core/usage-helpers.js';
import type { RealtimeLLMUsageEvent } from '../../src/types/transport.js';

function openAIResponse(overrides: Partial<RealtimeLLMUsageEvent> = {}): RealtimeLLMUsageEvent {
	return {
		provider: 'openai_realtime',
		kind: 'response',
		phase: 'final',
		unit: 'tokens',
		inputTokens: 1000,
		outputTokens: 500,
		modalityBreakdown: { cachedTokens: 800 },
		providerResponseId: 'resp_test_001',
		...overrides,
	};
}

function openAITranscription(
	overrides: Partial<RealtimeLLMUsageEvent> = {},
): RealtimeLLMUsageEvent {
	return {
		provider: 'openai_realtime',
		kind: 'input_transcription',
		phase: 'final',
		unit: 'tokens',
		inputTokens: 100,
		providerItemId: 'item_test_001',
		...overrides,
	};
}

function geminiFinal(overrides: Partial<RealtimeLLMUsageEvent> = {}): RealtimeLLMUsageEvent {
	return {
		provider: 'gemini_live',
		kind: 'response',
		phase: 'final',
		unit: 'tokens',
		inputTokens: 1000,
		outputTokens: 500,
		modalityBreakdown: { cachedTokens: 0 },
		...overrides,
	};
}

describe('computeCacheHitRatio (P4)', () => {
	it('openai.response: returns ratio when cachedTokens and inputTokens are present', () => {
		expect(computeCacheHitRatio(openAIResponse(), 'openai.response')).toBe(0.8);
	});

	it('openai.response: explicit zero cached returns 0 (cache miss)', () => {
		const u = openAIResponse({ modalityBreakdown: { cachedTokens: 0 } });
		expect(computeCacheHitRatio(u, 'openai.response')).toBe(0);
	});

	it('openai.response: missing modalityBreakdown returns undefined', () => {
		const u = openAIResponse({ modalityBreakdown: undefined });
		expect(computeCacheHitRatio(u, 'openai.response')).toBeUndefined();
	});

	it('openai.response: missing cachedTokens returns undefined', () => {
		const u = openAIResponse({ modalityBreakdown: {} });
		expect(computeCacheHitRatio(u, 'openai.response')).toBeUndefined();
	});

	it('openai.response: zero inputTokens returns undefined (avoid divide-by-zero)', () => {
		const u = openAIResponse({ inputTokens: 0 });
		expect(computeCacheHitRatio(u, 'openai.response')).toBeUndefined();
	});

	it('openai.transcription: returns undefined regardless of payload (not cache-eligible)', () => {
		expect(computeCacheHitRatio(openAITranscription(), 'openai.transcription')).toBeUndefined();
	});

	it('gemini.turn.final: returns undefined even when cachedContentTokenCount is reported', () => {
		// Gemini Live does not currently support context caching; treat
		// cachedContentTokenCount: 0 as "no signal", not as 0%.
		expect(computeCacheHitRatio(geminiFinal(), 'gemini.turn.final')).toBeUndefined();
	});

	it('gemini.usage.update: returns undefined (interim, no cache signal)', () => {
		const u = geminiFinal({ phase: 'update' });
		expect(computeCacheHitRatio(u, 'gemini.usage.update')).toBeUndefined();
	});
});

describe('deriveProviderItemId (P4)', () => {
	it('openai.response → providerResponseId', () => {
		expect(deriveProviderItemId(openAIResponse(), 'openai.response')).toBe('resp_test_001');
	});

	it('openai.transcription → providerItemId', () => {
		expect(deriveProviderItemId(openAITranscription(), 'openai.transcription')).toBe(
			'item_test_001',
		);
	});

	it('openai.response with no providerResponseId → null', () => {
		const u = openAIResponse({ providerResponseId: undefined });
		expect(deriveProviderItemId(u, 'openai.response')).toBeNull();
	});

	it('gemini sources → null (turn-bound, not item-bound)', () => {
		expect(deriveProviderItemId(geminiFinal(), 'gemini.turn.final')).toBeNull();
		expect(deriveProviderItemId(geminiFinal(), 'gemini.usage.update')).toBeNull();
	});
});

describe('deriveUsageSource (P4)', () => {
	it('openai_realtime + response → openai.response', () => {
		expect(deriveUsageSource(openAIResponse())).toBe('openai.response');
	});

	it('openai_realtime + input_transcription → openai.transcription', () => {
		expect(deriveUsageSource(openAITranscription())).toBe('openai.transcription');
	});

	it('gemini_live + final → gemini.turn.final', () => {
		expect(deriveUsageSource(geminiFinal())).toBe('gemini.turn.final');
	});

	it('gemini_live + interim phase → gemini.usage.update', () => {
		expect(deriveUsageSource(geminiFinal({ phase: 'update' }))).toBe('gemini.usage.update');
	});
});
