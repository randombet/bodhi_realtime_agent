import type { RealtimeLLMUsageEvent } from '../types/transport.js';

/** Source identifier for a published `realtime.usage` EventBus event.
 *  Provider-prefixed so consumers never have to disambiguate by inspecting
 *  other fields. */
export type RealtimeUsageSource =
	| 'openai.response'
	| 'openai.transcription'
	| 'gemini.usage.update'
	| 'gemini.turn.final'
	| 'qwen.response'
	| 'qwen.transcription';

/**
 * Provider-aware cache hit ratio. Returns `cachedTokens / inputTokens` ONLY
 * when caching is known to be reported by that provider+source AND
 * `inputTokens > 0`. In every other case (transcription, Gemini Live today,
 * missing breakdown), returns `undefined`.
 *
 * This avoids mislabeling "no signal" as a 0% cache hit. Dashboards can
 * safely filter on `cacheHitRatio !== undefined`.
 */
export function computeCacheHitRatio(
	usage: RealtimeLLMUsageEvent,
	source: RealtimeUsageSource,
): number | undefined {
	switch (source) {
		case 'openai.response': {
			// Caching is real on OpenAI Realtime responses. Return ratio when both
			// inputs are present; explicit zero is meaningful (= cache miss).
			const cached = usage.modalityBreakdown?.cachedTokens;
			const input = usage.inputTokens;
			if (cached === undefined || input === undefined || input <= 0) return undefined;
			return cached / input;
		}
		case 'openai.transcription':
			// Transcription is not cache-eligible.
			return undefined;
		case 'gemini.usage.update':
		case 'gemini.turn.final':
			// Gemini Live does not currently support context caching (per Google
			// staffer in discuss.ai.google.dev #108063, Dec 2025). cachedContent-
			// TokenCount: 0 is "no signal," not a 0% hit. When/if Google enables
			// Live caching, this branch flips to return the ratio.
			return undefined;
		case 'qwen.response':
		case 'qwen.transcription':
			// Qwen Omni Realtime exposes no cache-token signal — no cache ratio.
			return undefined;
	}
}

/** Derive the provider-supplied opaque id for a usage event. Source-aware:
 *   - openai.response   → providerResponseId (response.id)
 *   - openai.transcription → providerItemId (transcription item_id)
 *   - gemini.*          → null (Gemini events are turn-bound, not item-bound)
 *
 *  Used by VoiceSession to populate `RealtimeUsagePublished.providerItemId`
 *  so consumers have one canonical key field per source. */
export function deriveProviderItemId(
	usage: RealtimeLLMUsageEvent,
	source: RealtimeUsageSource,
): string | null {
	switch (source) {
		case 'openai.response':
			return usage.providerResponseId ?? null;
		case 'openai.transcription':
			return usage.providerItemId ?? null;
		case 'qwen.response':
			return usage.providerResponseId ?? null;
		case 'qwen.transcription':
			return usage.providerItemId ?? null;
		case 'gemini.usage.update':
		case 'gemini.turn.final':
			return null;
	}
}

/** Map a `RealtimeLLMUsageEvent` to its `RealtimeUsageSource`. Internal
 *  helper used by VoiceSession when bridging provider callbacks to the
 *  EventBus event. */
export function deriveUsageSource(usage: RealtimeLLMUsageEvent): RealtimeUsageSource {
	if (usage.provider === 'openai_realtime') {
		return usage.kind === 'input_transcription' ? 'openai.transcription' : 'openai.response';
	}
	if (usage.provider === 'qwen_realtime') {
		return usage.kind === 'input_transcription' ? 'qwen.transcription' : 'qwen.response';
	}
	// gemini_live
	return usage.phase === 'final' ? 'gemini.turn.final' : 'gemini.usage.update';
}
