// SPDX-License-Identifier: MIT

/**
 * Live voice LLM transport selection for a session (Gemini Live vs OpenAI Realtime).
 * Persisted on user agents; optional on built-in profile catalog entries.
 */

export const REALTIME_LLM_PROVIDERS = ['gemini', 'openai'] as const;

export type RealtimeLlmProvider = (typeof REALTIME_LLM_PROVIDERS)[number];

export function parseRealtimeLlmProvider(raw: unknown): RealtimeLlmProvider | null {
	if (raw === 'gemini' || raw === 'openai') return raw;
	return null;
}

export function normalizeRealtimeLlmProvider(
	raw: unknown,
	fallback: RealtimeLlmProvider,
): RealtimeLlmProvider {
	return parseRealtimeLlmProvider(raw) ?? fallback;
}
