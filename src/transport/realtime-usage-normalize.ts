// SPDX-License-Identifier: MIT

import type {
	RealtimeLLMUsageEvent,
	RealtimeUsageModalityBreakdown,
	RealtimeUsagePhase,
} from '../types/transport.js';

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
	}
	return undefined;
}

function modalityKey(m: unknown): string {
	if (typeof m === 'string') return m.toLowerCase();
	if (typeof m === 'number') return String(m);
	return '';
}

/** Sum token counts from Gemini-style ModalityTokenCount[] by modality substring. */
function aggregateGeminiModalityDetails(
	details: unknown,
	predicate: (mod: string) => boolean,
): number {
	if (!Array.isArray(details)) return 0;
	let sum = 0;
	for (const row of details) {
		if (!isRecord(row)) continue;
		const mod = modalityKey(row.modality ?? row.Modality);
		const count = readNumber(row, ['tokenCount', 'token_count']);
		if (count === undefined) continue;
		if (predicate(mod)) sum += count;
	}
	return sum;
}

function geminiModalityBreakdown(
	raw: Record<string, unknown>,
): RealtimeUsageModalityBreakdown | undefined {
	const promptDetails =
		raw.promptTokensDetails ?? raw.prompt_tokens_details ?? raw.promptTokensdetails;
	const responseDetails =
		raw.responseTokensDetails ?? raw.response_tokens_details ?? raw.responseTokensdetails;
	const cacheDetails = raw.cacheTokensDetails ?? raw.cache_tokens_details;

	const inputText = aggregateGeminiModalityDetails(promptDetails, (m) => m.includes('text'));
	const inputAudio = aggregateGeminiModalityDetails(promptDetails, (m) => m.includes('audio'));
	const inputImage = aggregateGeminiModalityDetails(promptDetails, (m) => m.includes('image'));

	const outputText = aggregateGeminiModalityDetails(responseDetails, (m) => m.includes('text'));
	const outputAudio = aggregateGeminiModalityDetails(responseDetails, (m) => m.includes('audio'));

	const cachedText = aggregateGeminiModalityDetails(cacheDetails, (m) => m.includes('text'));
	const cachedAudio = aggregateGeminiModalityDetails(cacheDetails, (m) => m.includes('audio'));
	const cachedImage = aggregateGeminiModalityDetails(cacheDetails, (m) => m.includes('image'));
	const cachedTokens = readNumber(raw, ['cachedContentTokenCount', 'cached_content_token_count']);

	const breakdown: RealtimeUsageModalityBreakdown = {};
	if (inputText) breakdown.inputTextTokens = inputText;
	if (inputAudio) breakdown.inputAudioTokens = inputAudio;
	if (inputImage) breakdown.inputImageTokens = inputImage;
	if (cachedTokens !== undefined) breakdown.cachedTokens = cachedTokens;
	if (cachedText) breakdown.cachedTextTokens = cachedText;
	if (cachedAudio) breakdown.cachedAudioTokens = cachedAudio;
	if (cachedImage) breakdown.cachedImageTokens = cachedImage;
	if (outputText) breakdown.outputTextTokens = outputText;
	if (outputAudio) breakdown.outputAudioTokens = outputAudio;

	return Object.keys(breakdown).length > 0 ? breakdown : undefined;
}

/**
 * Normalize Gemini Live `usageMetadata` (camelCase or snake_case) into a framework event.
 */
export function normalizeGeminiUsageMetadata(
	raw: unknown,
	phase: RealtimeUsagePhase,
): RealtimeLLMUsageEvent | null {
	if (!isRecord(raw)) return null;

	const input = readNumber(raw, ['promptTokenCount', 'prompt_token_count']);
	const output = readNumber(raw, ['responseTokenCount', 'response_token_count']);
	const total = readNumber(raw, ['totalTokenCount', 'total_token_count']);
	if (input === undefined && output === undefined && total === undefined) return null;

	return {
		provider: 'gemini_live',
		kind: 'response',
		phase,
		unit: 'tokens',
		inputTokens: input,
		outputTokens: output,
		totalTokens: total,
		modalityBreakdown: geminiModalityBreakdown(raw),
		providerRaw: raw,
	};
}

function openAIModalityFromInputDetails(
	d: Record<string, unknown>,
): RealtimeUsageModalityBreakdown {
	const breakdown: RealtimeUsageModalityBreakdown = {};
	const text = readNumber(d, ['text_tokens']);
	const audio = readNumber(d, ['audio_tokens']);
	const image = readNumber(d, ['image_tokens']);
	const cached = readNumber(d, ['cached_tokens']);
	if (text !== undefined) breakdown.inputTextTokens = text;
	if (audio !== undefined) breakdown.inputAudioTokens = audio;
	if (image !== undefined) breakdown.inputImageTokens = image;
	if (cached !== undefined) breakdown.cachedTokens = cached;

	const cachedDet = d.cached_tokens_details;
	if (isRecord(cachedDet)) {
		const ct = readNumber(cachedDet, ['text_tokens']);
		const ca = readNumber(cachedDet, ['audio_tokens']);
		const ci = readNumber(cachedDet, ['image_tokens']);
		if (ct !== undefined) breakdown.cachedTextTokens = ct;
		if (ca !== undefined) breakdown.cachedAudioTokens = ca;
		if (ci !== undefined) breakdown.cachedImageTokens = ci;
	}
	return breakdown;
}

function openAIModalityFromOutputDetails(
	d: Record<string, unknown>,
): RealtimeUsageModalityBreakdown {
	const breakdown: RealtimeUsageModalityBreakdown = {};
	const text = readNumber(d, ['text_tokens']);
	const audio = readNumber(d, ['audio_tokens']);
	if (text !== undefined) breakdown.outputTextTokens = text;
	if (audio !== undefined) breakdown.outputAudioTokens = audio;
	return breakdown;
}

function mergeBreakdown(
	a: RealtimeUsageModalityBreakdown,
	b: RealtimeUsageModalityBreakdown,
): RealtimeUsageModalityBreakdown {
	const out: RealtimeUsageModalityBreakdown = { ...a };
	for (const k of Object.keys(b) as (keyof RealtimeUsageModalityBreakdown)[]) {
		const bv = b[k];
		if (bv === undefined) continue;
		const av = out[k];
		out[k] = av === undefined ? bv : av + bv;
	}
	return out;
}

/**
 * Normalize OpenAI Realtime `response.usage` from `response.done`.
 */
export function normalizeOpenAIResponseUsage(
	raw: unknown,
	providerResponseId?: string,
): RealtimeLLMUsageEvent | null {
	if (!isRecord(raw)) return null;

	const input = readNumber(raw, ['input_tokens']);
	const output = readNumber(raw, ['output_tokens']);
	const total = readNumber(raw, ['total_tokens']);
	if (input === undefined && output === undefined && total === undefined) return null;

	let modality: RealtimeUsageModalityBreakdown | undefined;
	const inDet = raw.input_token_details;
	const outDet = raw.output_token_details;
	if (isRecord(inDet)) {
		modality = openAIModalityFromInputDetails(inDet);
	}
	if (isRecord(outDet)) {
		const ob = openAIModalityFromOutputDetails(outDet);
		modality = modality ? mergeBreakdown(modality, ob) : ob;
	}

	return {
		provider: 'openai_realtime',
		kind: 'response',
		phase: 'final',
		unit: 'tokens',
		inputTokens: input,
		outputTokens: output,
		totalTokens: total,
		modalityBreakdown:
			modality && Object.values(modality).some((v) => v !== undefined) ? modality : undefined,
		providerResponseId,
		providerRaw: raw,
	};
}

/**
 * Normalize OpenAI Realtime input transcription `usage` from
 * `conversation.item.input_audio_transcription.completed`.
 */
export function normalizeOpenAITranscriptionUsage(raw: unknown): RealtimeLLMUsageEvent | null {
	if (!isRecord(raw)) return null;

	const typ = raw.type;
	if (typ === 'duration') {
		const seconds = readNumber(raw, ['seconds']);
		if (seconds === undefined) return null;
		return {
			provider: 'openai_realtime',
			kind: 'input_transcription',
			phase: 'final',
			unit: 'duration_seconds',
			durationSeconds: seconds,
			providerRaw: raw,
		};
	}

	const input = readNumber(raw, ['input_tokens']);
	const output = readNumber(raw, ['output_tokens']);
	const total = readNumber(raw, ['total_tokens']);
	if (input === undefined && output === undefined && total === undefined) return null;

	let modality: RealtimeUsageModalityBreakdown | undefined;
	const inDet = raw.input_token_details;
	if (isRecord(inDet)) {
		modality = openAIModalityFromInputDetails(inDet);
	}

	return {
		provider: 'openai_realtime',
		kind: 'input_transcription',
		phase: 'final',
		unit: 'tokens',
		inputTokens: input,
		outputTokens: output,
		totalTokens: total,
		modalityBreakdown:
			modality && Object.values(modality).some((v) => v !== undefined) ? modality : undefined,
		providerRaw: raw,
	};
}
