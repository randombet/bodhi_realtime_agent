// SPDX-License-Identifier: MIT

/**
 * Per-model feature gating for OpenAIRealtimeTransport.
 *
 * Coarse "is this gpt-realtime-2?" gating would wrongly strip features from
 * older models that happen to support them (e.g. MCP, when it is later
 * re-introduced). Each gated feature has its own column here, and
 * `buildSessionConfig()` consults the table per field. Adding a new model is
 * a single row; adding a new feature is a single column.
 */

import type { ReasoningEffort } from '../types/transport.js';

/** Model IDs the framework recognises. Unknown strings still work — they
 *  simply opt out of every gated feature (`supports()` returns false). */
export type OpenAIRealtimeModel =
	| 'gpt-realtime' // legacy GA
	| 'gpt-realtime-1.5' // legacy GA
	| 'gpt-realtime-2' // current default
	| (string & {}); // forward-compat for unknown model IDs (no special chars in `& {}` — common pattern)

/** Gated feature names. Stays small — re-introducing MCP later adds an
 *  `mcpTools` column here and one branch in `buildSessionConfig()`. */
export type OpenAIRealtimeFeature = 'reasoning' | 'parallelToolCalls';

/** Static per-model capability table. Source of truth for feature gating. */
export const FEATURES: Record<string, Record<OpenAIRealtimeFeature, boolean>> = {
	'gpt-realtime': { reasoning: false, parallelToolCalls: false },
	'gpt-realtime-1.5': { reasoning: false, parallelToolCalls: false },
	'gpt-realtime-2': { reasoning: true, parallelToolCalls: true },
};

/** Returns true if `model` is documented to support `feature`. Unknown
 *  models opt out of every feature by default. */
export function supports(model: string, feature: OpenAIRealtimeFeature): boolean {
	return FEATURES[model]?.[feature] ?? false;
}

/** Audio format on the OpenAI Realtime wire. */
export interface OpenAIRealtimeAudioFormat {
	/** `'audio/pcm'` is signed 16-bit linear; `'audio/pcmu'` is G.711 μ-law
	 *  for telephony bridges. A-law (`'audio/pcma'`) is future work —
	 *  `src/telephony/audio-codec.ts` only ships μ-law encode/decode today. */
	type: 'audio/pcm' | 'audio/pcmu';
	/** Sample rate in Hz. Constrained at runtime:
	 *  - For `audio/pcm`, OpenAI Realtime only accepts 24000. Other values
	 *    throw `FrameworkError('UNSUPPORTED_SAMPLE_RATE')` from
	 *    `buildSessionConfig()`.
	 *  - For `audio/pcmu`, always 8000 — `rate` is ignored if supplied.
	 *  Defaults: 24000 (pcm) / 8000 (pcmu). */
	rate?: number;
}

/** Reasoning-summary verbosity. Off by default unless explicitly requested. */
export type ReasoningSummary = 'auto' | 'concise' | 'detailed';

export type { ReasoningEffort };
