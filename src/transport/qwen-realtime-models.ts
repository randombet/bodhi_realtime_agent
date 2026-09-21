/**
 * Per-model registry for QwenRealtimeTransport (Qwen Omni Realtime via Alibaba
 * DashScope). Mirrors `openai-realtime-models.ts`: one row per model, one column
 * per gated feature. Unknown model IDs still work — they opt out of gated
 * features (`supports()` returns false).
 *
 * See dev_docs/framework/design-qwen-realtime-transport.md (Phase 0 results).
 */

/** Default Singapore (international) realtime endpoint. */
export const DEFAULT_QWEN_REALTIME_URL = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime';

/** Default model. */
export const DEFAULT_QWEN_REALTIME_MODEL = 'qwen3.5-omni-plus-realtime';

/** Model IDs the framework recognises. Unknown strings still work. */
export type QwenRealtimeModel =
	| 'qwen3.5-omni-plus-realtime'
	| 'qwen3-omni-flash-realtime'
	| (string & {});

/** Gated feature names. */
export type QwenRealtimeFeature = 'tools';

/** Static per-model capability table. Phase 0 (2026-05-28) confirmed tool
 *  calling on `qwen3.5-omni-plus-realtime`. */
export const FEATURES: Record<string, Record<QwenRealtimeFeature, boolean>> = {
	'qwen3.5-omni-plus-realtime': { tools: true },
	'qwen3-omni-flash-realtime': { tools: true },
};

/** Returns true if `model` is documented to support `feature`. Unknown models
 *  default to `true` for `tools` (the realtime family supports it); this keeps
 *  forward-compat models working. Override per-row above to disable. */
export function supports(model: string, feature: QwenRealtimeFeature): boolean {
	return FEATURES[model]?.[feature] ?? true;
}

/**
 * Voices accepted by `qwen3.5-omni-plus-realtime` at `session.update` ack time
 * (Phase 0 probe 0.9). The server's default voice is `Tina`. NOTE: `session.update`
 * does not fully validate the voice — an unlisted/invalid voice can still be
 * rejected at *generation* time (the earlier smoke test saw `Cherry` rejected
 * mid-turn). Prefer omitting `voice` (server default) unless a specific voice has
 * been validated end-to-end for this model+region+account.
 */
export const QWEN_VOICES = [
	'Tina',
	'Cherry',
	'Ethan',
	'Chelsie',
	'Serena',
	'Jada',
	'Dylan',
	'Sunny',
	'Kiki',
	'Eric',
	'Nofish',
] as const;

/** The server-default voice (used when `voice` is omitted). */
export const DEFAULT_QWEN_VOICE = 'Tina';
