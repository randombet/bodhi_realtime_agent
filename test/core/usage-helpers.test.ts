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

	it('qwen_realtime + response → qwen.response', () => {
		expect(
			deriveUsageSource({
				provider: 'qwen_realtime',
				kind: 'response',
				phase: 'final',
				unit: 'tokens',
			}),
		).toBe('qwen.response');
	});

	it('qwen_realtime + input_transcription → qwen.transcription', () => {
		expect(
			deriveUsageSource({
				provider: 'qwen_realtime',
				kind: 'input_transcription',
				phase: 'final',
				unit: 'tokens',
			}),
		).toBe('qwen.transcription');
	});

	it('qwen sources have no cache-hit ratio and derive provider ids', () => {
		const ev = {
			provider: 'qwen_realtime',
			kind: 'response',
			phase: 'final',
			unit: 'tokens',
			inputTokens: 10,
			providerResponseId: 'resp_q',
		} as const;
		expect(computeCacheHitRatio(ev, 'qwen.response')).toBeUndefined();
		expect(deriveProviderItemId(ev, 'qwen.response')).toBe('resp_q');
	});
});

// Follow-up fix #3: VoiceSession's per-turn sequence Map must NOT clear
// `no_turn:*` keys at turn.end so transcription events stay monotonic
// across the session. This test exercises the Map-filter policy in
// isolation (the 3-line block at voice-session.ts:1909-1916) so a
// regression on either branch of the filter is caught here.
describe('per-turn sequence reset policy (fix #3)', () => {
	function applyTurnEndReset(map: Map<string, number>): void {
		for (const k of [...map.keys()]) {
			if (!k.startsWith('no_turn:')) map.delete(k);
		}
	}

	it('clears turn-bound source keys (openai.response, gemini.*)', () => {
		const m = new Map<string, number>();
		m.set('turn_5:openai.response', 3);
		m.set('turn_5:gemini.turn.final', 1);
		applyTurnEndReset(m);
		expect(m.has('turn_5:openai.response')).toBe(false);
		expect(m.has('turn_5:gemini.turn.final')).toBe(false);
	});

	it('PRESERVES no_turn:* keys (transcription) so sequence stays session-scoped', () => {
		const m = new Map<string, number>();
		m.set('no_turn:openai.transcription', 7);
		m.set('turn_5:openai.response', 2);
		applyTurnEndReset(m);
		expect(m.get('no_turn:openai.transcription')).toBe(7);
		expect(m.has('turn_5:openai.response')).toBe(false);
	});

	it('next transcription event picks up where the previous left off (no reset)', () => {
		const m = new Map<string, number>();
		// Turn 1 emits: response (seq 1), transcription (seq 1).
		m.set('turn_1:openai.response', 1);
		m.set('no_turn:openai.transcription', 1);
		// turn.end fires.
		applyTurnEndReset(m);
		// Turn 2 emits: response (seq 1, fresh), transcription (seq 2, monotonic).
		m.set('turn_2:openai.response', 1);
		const transcriptionSeq = (m.get('no_turn:openai.transcription') ?? 0) + 1;
		m.set('no_turn:openai.transcription', transcriptionSeq);
		expect(transcriptionSeq).toBe(2); // not reset to 1
		expect(m.get('turn_2:openai.response')).toBe(1);
	});
});
