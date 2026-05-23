// SPDX-License-Identifier: MIT

import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type {
	RealtimeClientEvent,
	RealtimeSessionCreateRequest,
} from 'openai/resources/realtime/realtime';
import { CachePrefixMutationError, TransportError, ValidationError } from '../core/errors.js';
import type { ToolDefinition } from '../types/tool.js';
import type {
	AudioFormatSpec,
	CacheConfigCommon,
	CancelResponseOptions,
	ContentTurn,
	LLMTransport,
	LLMTransportConfig,
	LLMTransportError,
	RealtimeLLMUsageEvent,
	ReasoningEffort,
	ReconnectState,
	ReplayItem,
	SessionUpdate,
	TransportCapabilities,
	TransportToolCall,
	TransportToolResult,
} from '../types/transport.js';
import {
	type OpenAIRealtimeAudioFormat,
	type OpenAIRealtimeModel,
	type ReasoningSummary,
	supports,
} from './openai-realtime-models.js';
import {
	normalizeOpenAIResponseUsage,
	normalizeOpenAITranscriptionUsage,
} from './realtime-usage-normalize.js';
import { zodToJsonSchema } from './zod-to-schema.js';

/** Configuration for constructing an OpenAIRealtimeTransport. */
/**
 * OpenAI Realtime cache configuration. Lives on `OpenAIRealtimeConfig.cacheConfig`.
 *
 * P3 lands `truncation` (the documented cache-preservation lever); P5 wires
 * `enforcePrefixStability`; P6 adds `experimental.promptCacheKey`. See
 * dev_docs/framework/design-context-caching.md for the full design.
 */
export interface OpenAIRealtimeCacheConfig extends CacheConfigCommon {
	/**
	 * Maps to `RealtimeSessionCreateRequest.truncation`. Drives whether and
	 * how the server truncates conversation history when the model input
	 * limit fills. (Limits vary by model — `gpt-realtime` is 32k input,
	 * `gpt-realtime-2` is 128k.) Use the `retention_ratio` object form to
	 * preserve more of the cached prefix.
	 *
	 * Per the OpenAI SDK documentation: "Truncation will reduce the number
	 * of cached tokens on the next turn (busting the cache), since messages
	 * are dropped from the beginning of the context. However, clients can
	 * also configure truncation to retain messages up to a fraction of the
	 * maximum context size, which will reduce the need for future
	 * truncations and thus improve the cache rate."
	 *
	 * Default: undefined (server default applies — currently 'auto').
	 */
	truncation?:
		| 'auto'
		| 'disabled'
		| {
				type: 'retention_ratio';
				/** In [0, 1]. Validated at connect time before opening the WS. */
				retentionRatio: number;
				/** Optional fixed token-limit cap. */
				tokenLimits?: { postInstructions?: number };
		  };
	/**
	 * EXPERIMENTAL — sent on every `session.update` for a given probe scope
	 * `(baseURL, organization, project, model, promptCacheKey)`. The first
	 * send for a new scope races `session.updated` (success) against an
	 * `error` event referencing `prompt_cache_key` or `unknown_parameter`
	 * (rejection). On rejection: probe state for that scope flips to
	 * `'rejected'`, the field is stripped from subsequent sends, and the
	 * rejection error is suppressed from the user-facing `transport.onError`.
	 *
	 * Documented for Responses/Chat; community-reported but officially
	 * undocumented for Realtime. Combines with the prefix hash for routing
	 * affinity (~15 RPM per key per backend host before spillover); over-
	 * sharing degrades hit rate. Scope per agent + region.
	 *
	 * Not present in the local OpenAI SDK type as of v6.x; emitted via narrow
	 * cast in `applyOpenAICacheConfig`.
	 */
	experimental?: {
		promptCacheKey?: string;
	};
}

export interface OpenAIRealtimeConfig {
	/** OpenAI API key. */
	apiKey: string;
	/** OpenAI organization ID. Pass-through to the SDK client constructor.
	 *  Used by the P6 promptCacheKey probe to scope rejections per org. */
	organization?: string;
	/** OpenAI project ID. Pass-through to the SDK client constructor.
	 *  Used by the P6 promptCacheKey probe to scope rejections per project. */
	project?: string;
	/** Override the OpenAI base URL (e.g. for compatible third-party gateways).
	 *  Pass-through to the SDK client constructor; the P6 promptCacheKey probe
	 *  also scopes rejections per baseURL so a 4xx on one deployment does not
	 *  poison the probe state for another. */
	baseURL?: string;
	/** Model identifier (default: 'gpt-realtime-2'). */
	model?: OpenAIRealtimeModel;
	/** Voice name (default: 'coral'). */
	voice?: string;
	/** Transcription model (default: 'gpt-4o-mini-transcribe'). Set to null to disable input transcription. */
	transcriptionModel?: string | null;
	/** Turn detection configuration. Pass `null` to disable VAD entirely
	 *  (manual turn control via `commitAudio()` — `frameworkOwnsInterrupt`
	 *  capability is forced `false` and `greetingInterruptGraceMs` to `0` in
	 *  this mode). When omitted, the framework's defaults are merged in
	 *  type-aware fashion — see `resolveTurnDetectionConfig`. */
	turnDetection?: Record<string, unknown> | null;
	/** Noise reduction configuration. */
	noiseReduction?: Record<string, unknown>;
	/** Reasoning effort + optional summary verbosity. Only honoured when the
	 *  active model supports reasoning (gated via the FEATURES table). Dropped
	 *  with a warn — or thrown under `strict: true` — on older models. */
	reasoning?: { effort?: ReasoningEffort; summary?: ReasoningSummary };
	/** Wire-level input audio format. Default `{ type: 'audio/pcm', rate: 24000 }`.
	 *  Telephony bridges set this to `{ type: 'audio/pcmu' }` (rate is always 8000
	 *  for G.711). PCM rates other than 24000 are rejected at build-config time. */
	audioInputFormat?: OpenAIRealtimeAudioFormat;
	/** Wire-level output audio format. Default `{ type: 'audio/pcm', rate: 24000 }`.
	 *  Same constraints as `audioInputFormat`. */
	audioOutputFormat?: OpenAIRealtimeAudioFormat;
	/** When `true`, supplying a feature unsupported for the active model throws
	 *  `FrameworkError('UNSUPPORTED_FEATURE')` from `buildSessionConfig()`.
	 *  When `false`/omitted (production default), the feature is dropped and a
	 *  `warn` is logged. Framework Vitest suites set `strict: true`. */
	strict?: boolean;
	/** Cache control. Truncation lands in P3; enforcePrefixStability in P5;
	 *  experimental.promptCacheKey in P6. See OpenAIRealtimeCacheConfig. */
	cacheConfig?: OpenAIRealtimeCacheConfig;
}

/** Recursively sort object keys so structurally-identical payloads with
 *  different key order produce identical JSON strings. Arrays preserve
 *  declaration order. Used by P5 enforcePrefixStability to compare canonical
 *  prefix snapshots ({ instructions, tools }). */
function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const sorted: Record<string, unknown> = {};
	for (const k of Object.keys(value as Record<string, unknown>).sort()) {
		sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
	}
	return sorted;
}

/** Probe state for the experimental prompt-cache-key path. */
export type CacheKeyProbeState = 'unknown' | 'accepted' | 'rejected';

/** P6: module-level probe state Map. Keyed by
 *  `${baseURL}|${organization}|${project}|${model}|${promptCacheKey}` so a
 *  rejection in one deployment/key does not poison the probe for others. */
const promptCacheKeyProbeState: Map<string, CacheKeyProbeState> = new Map();

/** P6: derive the probe scope key from a transport instance + cache key. */
export function derivePromptCacheKeyProbeScope(
	baseURL: string | undefined,
	organization: string | undefined,
	project: string | undefined,
	model: string | undefined,
	promptCacheKey: string,
): string {
	return [
		baseURL ?? 'default',
		organization ?? 'default',
		project ?? 'default',
		model ?? 'default',
		promptCacheKey,
	].join('|');
}

/** P6: consult the probe Map. Returns `'unknown'` if no entry exists. */
export function getPromptCacheKeyProbeState(scope: string): CacheKeyProbeState {
	return promptCacheKeyProbeState.get(scope) ?? 'unknown';
}

/** P6: set the probe state for a scope. Used by the in-transport probe
 *  rejection handler. Exposed for testing. */
export function setPromptCacheKeyProbeState(scope: string, state: CacheKeyProbeState): void {
	promptCacheKeyProbeState.set(scope, state);
}

/** P6 (test only): clear all probe state. */
export function _clearPromptCacheKeyProbeStateForTesting(): void {
	promptCacheKeyProbeState.clear();
}

/** Validate a cacheConfig payload BEFORE opening the WebSocket. Throws
 *  `ValidationError` for invalid values; the caller (connect()) wraps the
 *  whole pre-flight so no socket is leaked on failure. */
export function validateOpenAICacheConfig(cfg: OpenAIRealtimeCacheConfig | undefined): void {
	if (!cfg || cfg.truncation === undefined || typeof cfg.truncation === 'string') return;
	const r = cfg.truncation.retentionRatio;
	if (typeof r !== 'number' || r < 0 || r > 1 || Number.isNaN(r)) {
		throw new ValidationError(
			'cacheConfig.truncation.retentionRatio must be in [0, 1] (per OpenAI Realtime API)',
		);
	}
	const post = cfg.truncation.tokenLimits?.postInstructions;
	if (post !== undefined && (!Number.isInteger(post) || post < 0)) {
		throw new ValidationError(
			'cacheConfig.truncation.tokenLimits.postInstructions must be a non-negative integer',
		);
	}
}

/** Mutate a `session.update` payload in-place to add `truncation` and (P6)
 *  `prompt_cache_key`. Single insertion point used by `buildSessionConfig()`,
 *  `updateSession()`, and `transferSession()` so the field never gets dropped
 *  on agent handoff. Validation must have run separately (validateOpenAICacheConfig).
 *
 *  @param probeState When `cfg.experimental?.promptCacheKey` is present:
 *    `'rejected'` → omit the field; `'unknown'` or `'accepted'` → include.
 */
export function applyOpenAICacheConfig(
	payload: Record<string, unknown>,
	cfg: OpenAIRealtimeCacheConfig | undefined,
	probeState: CacheKeyProbeState,
): void {
	if (!cfg) return;
	if (cfg.truncation !== undefined) {
		if (typeof cfg.truncation === 'string') {
			payload.truncation = cfg.truncation; // 'auto' | 'disabled'
		} else {
			const r = cfg.truncation.retentionRatio;
			const post = cfg.truncation.tokenLimits?.postInstructions;
			payload.truncation = {
				type: 'retention_ratio',
				retention_ratio: r,
				...(post !== undefined ? { token_limits: { post_instructions: post } } : {}),
			};
		}
	}
	// P6: experimental.promptCacheKey. Field is not in the OpenAI SDK's
	// RealtimeSessionCreateRequest type (as of v6.x); attach as a raw
	// property. Omit when the probe has confirmed rejection for this scope.
	if (cfg.experimental?.promptCacheKey && probeState !== 'rejected') {
		(payload as { prompt_cache_key?: string }).prompt_cache_key = cfg.experimental.promptCacheKey;
	}
}

/** Convert a framework ToolDefinition to OpenAI function tool format. */
function toolToOpenAIFunction(tool: ToolDefinition): Record<string, unknown> {
	return {
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: zodToJsonSchema(tool.parameters, 'standard'),
	};
}

/**
 * LLMTransport implementation for the OpenAI Realtime API.
 *
 * Uses the `openai` SDK's WebSocket transport (`OpenAIRealtimeWS`) for
 * bidirectional audio streaming with function calling support.
 *
 * Key differences from Gemini:
 * - In-place session updates (no reconnect for agent transfers)
 * - Streamed function call arguments (accumulated before dispatch)
 * - Client-managed interruption (truncate + cancel)
 * - 24kHz audio (vs Gemini's 16kHz)
 * - Explicit `response.create` required after tool results
 */
export class OpenAIRealtimeTransport implements LLMTransport {
	/** Construction-time snapshot. Re-resolved at end of `connect()` after
	 *  `applyTransportConfig()` may have changed the model. Once `connect()`
	 *  resolves, immutable for the lifetime of the connection. */
	private _capabilities: TransportCapabilities;

	get capabilities(): TransportCapabilities {
		return this._capabilities;
	}

	/** Construction-time snapshot. Re-resolved alongside `_capabilities` when
	 *  `applyTransportConfig()` finalises the audio format. */
	private _audioFormat: AudioFormatSpec;

	get audioFormat(): AudioFormatSpec {
		return this._audioFormat;
	}

	private staticCapabilities: TransportCapabilities = {
		messageTruncation: true,
		turnDetection: true,
		userTranscription: true,
		inPlaceSessionUpdate: true,
		sessionResumption: false,
		contextCompression: false,
		groundingMetadata: false,
		textResponseModality: true,
		// `response.done` fires at generation end, not playback end — the native
		// playback-end gate engages for OpenAI native audio.
		playbackGatedTurnComplete: false,
	};

	// --- LLMTransport callback properties ---
	onAudioOutput?: (base64Data: string) => void;
	onToolCall?: (calls: TransportToolCall[]) => void;
	onToolCallCancel?: (ids: string[]) => void;
	onTurnComplete?: () => void;
	onInterrupted?: () => void;
	onInputTranscription?: (text: string) => void;
	onOutputTranscription?: (text: string) => void;
	onSessionReady?: (sessionId: string) => void;
	onError?: (error: LLMTransportError) => void;
	onClose?: (code?: number, reason?: string) => void;
	onModelTurnStart?: () => void;
	onGoAway?: (timeLeft: string) => void;
	onResumptionUpdate?: (handle: string, resumable: boolean) => void;
	onGroundingMetadata?: (metadata: Record<string, unknown>) => void;
	onTextOutput?: (text: string) => void;
	onTextDone?: () => void;
	onSpeechStarted?: () => void;
	onRealtimeLLMUsage?: (usage: RealtimeLLMUsageEvent) => void;
	onReasoningStart?: () => void;
	onReasoningDone?: (info: { durationMs: number; reasoningTokens?: number }) => void;
	onReasoningSummary?: (text: string) => void;
	onCacheBust?: (reason: 'instructions_changed' | 'tools_changed') => void;

	// --- Private state ---
	private client: OpenAI;
	private rt: OpenAIRealtimeWS | null = null;
	private _isConnected = false;
	private config: OpenAIRealtimeConfig;

	// Stored session config (applied at connect or via updateSession)
	private instructions?: string;
	private tools?: ToolDefinition[];
	private voice: string;

	/** P5: canonicalized snapshot of the prefix that the server has
	 *  acknowledged ({ instructions, tools } as wire JSON). Captured after
	 *  the initial connect-time session.update is acknowledged and updated
	 *  after every successful prefix-mutating wire send. Compared against
	 *  the canonicalization of incoming SessionUpdate.{instructions, tools}
	 *  to decide whether enforcePrefixStability should throw. */
	private prefixBaselineCanonical: string | null = null;

	/** Follow-up fix #1: serial queue for post-connect session.update sends.
	 *  Ensures sendSessionUpdateAndWait calls are single-flight (one wire
	 *  send + one ack at a time), so session.updated events can be correlated
	 *  to the call that produced them. */
	private _sessionUpdateQueue: Promise<unknown> = Promise.resolve();

	/** Follow-up fix #1: monotonic event_id counter for session.update payloads.
	 *  OpenAI errors echo event_id; success acks (session.updated) do not, but
	 *  single-flight queueing makes the next session.updated unambiguous. */
	private _sessionUpdateEventIdCounter = 0;

	/** Follow-up fix #2: scope of any prompt_cache_key probe currently in
	 *  flight. The generic error listener consults this to suppress an
	 *  expected probe rejection from `transport.onError` (the probe handler
	 *  will surface it only if the retry-without-key also fails). */
	private _inFlightProbeScope: string | null = null;

	// Interruption tracking
	private lastAssistantItemId: string | null = null;
	private audioOutputMs = 0;

	// Tool call argument accumulation (OpenAI streams args incrementally)
	private pendingFunctionCalls = new Map<string, string>();

	// Batched tool-call dispatch: completed function_call items from the
	// current response, flushed in one onToolCall(calls[]) on response.done.
	// Required for gpt-realtime-2's parallel tool calls; a no-op when only
	// one call lands per response.
	private completedToolCallsThisResponse: TransportToolCall[] = [];

	// Reasoning lifecycle: track start time + token count for the current response.
	private _reasoningStartedAt: number | null = null;
	private _reasoningTokensThisResponse: number | undefined = undefined;

	// when_idle scheduling: buffer tool results while model is generating
	private _isModelGenerating = false;
	private _pendingWhenIdle: TransportToolResult[] = [];

	// Text mode: whether the transport is configured for text-mode responses (for TTS)
	private _textMode = false;

	// Audio suppression: stop forwarding audio deltas after interruption.
	// Cleared on response.created. Distinct from _quiesced (which persists
	// across responses until unquiesce()).
	private _suppressAudio = false;

	// Active-response waiter — see dev_docs/framework/design-greeting-interrupt-grace.md §2.
	// Resolved when the in-flight response terminates (`response.done` any status,
	// disconnect, or transport error). `cancelResponse({ waitForDone: true })`
	// returns a promise that races this waiter against a 2000 ms timeout so
	// callers can sequence cancel → next response.create without
	// `conversation_already_has_active_response` races. When no response is
	// in flight, the waiter is already resolved.
	private _activeResponseDone: Promise<void> = Promise.resolve();
	private _resolveActiveResponseDone: (() => void) | null = null;
	// Durable suppression: set by quiesce(), cleared by unquiesce(). Audio
	// is dropped at the wire-event handlers while this is true regardless of
	// response lifecycle.
	private _quiesced = false;

	constructor(config: OpenAIRealtimeConfig) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			...(config.organization !== undefined ? { organization: config.organization } : {}),
			...(config.project !== undefined ? { project: config.project } : {}),
			...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
		});
		this.voice = config.voice ?? 'coral';
		this._capabilities = this.resolveCapabilities();
		this._audioFormat = this.resolveAudioFormat();
	}

	/** Compute capability flags from the configured model. */
	private resolveCapabilities(): TransportCapabilities {
		const model = this.config.model ?? 'gpt-realtime-2';
		// Compute framework-owned-interrupt + grace from the single
		// turn-detection resolver — wire config and capabilities cannot
		// disagree because they are computed together from one source.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §3.
		const { wire, effective } = this.resolveTurnDetectionConfig();
		// VAD-disabled mode (`turn_detection: null`) means no speech-driven
		// interrupt machinery runs at all — neither provider nor framework
		// has anything to actuate from. `frameworkOwnsInterrupt` is forced
		// false so the grace window does not arm pointlessly.
		const frameworkOwnsInterrupt = wire !== null && effective.interrupt_response === false;
		return {
			...this.staticCapabilities,
			parallelToolCalls: supports(model, 'parallelToolCalls'),
			reasoningEffort: supports(model, 'reasoning'),
			// gpt-realtime-2 emits automatic preambles; gating on reasoning is the
			// proxy because the two ship together on the same model line.
			automaticPreambles: supports(model, 'reasoning'),
			quiescible: true,
			frameworkOwnsInterrupt,
			// Recommend 1000 ms of greeting interrupt grace ONLY when we own
			// interruption — provider auto-cancel would defeat the grace, so
			// advertising > 0 there would mislead VoiceSession's validation.
			greetingInterruptGraceMs: frameworkOwnsInterrupt ? 1000 : 0,
		};
	}

	/** Compute the wire audio format from `audioInputFormat` / `audioOutputFormat`.
	 *  Carries both input and output encodings / bit-depths so consumers that
	 *  decode output audio (handleAudioOutput) and compute interruption ms
	 *  (audioOutputMs) use the right side. */
	private resolveAudioFormat(): AudioFormatSpec {
		const inFmt = this.config.audioInputFormat ?? { type: 'audio/pcm', rate: 24000 };
		const outFmt = this.config.audioOutputFormat ?? { type: 'audio/pcm', rate: 24000 };
		const inEnc: 'pcm' | 'pcmu' = inFmt.type === 'audio/pcmu' ? 'pcmu' : 'pcm';
		const outEnc: 'pcm' | 'pcmu' = outFmt.type === 'audio/pcmu' ? 'pcmu' : 'pcm';
		const inRate = inEnc === 'pcmu' ? 8000 : (inFmt.rate ?? 24000);
		const outRate = outEnc === 'pcmu' ? 8000 : (outFmt.rate ?? 24000);
		return {
			inputSampleRate: inRate,
			outputSampleRate: outRate,
			channels: 1,
			bitDepth: inEnc === 'pcmu' ? 8 : 16,
			encoding: inEnc,
			outputBitDepth: outEnc === 'pcmu' ? 8 : 16,
			outputEncoding: outEnc,
		};
	}

	get isConnected(): boolean {
		return this._isConnected;
	}

	// --- Lifecycle ---

	async connect(transportConfig?: LLMTransportConfig): Promise<void> {
		if (transportConfig) {
			this.applyTransportConfig(transportConfig);
		}

		// Pre-flight: validate cacheConfig BEFORE opening the WebSocket so any
		// invalid value throws a typed ValidationError without leaking a socket.
		validateOpenAICacheConfig(this.config.cacheConfig);

		// Finalise capability + audio-format snapshots after any connect-time
		// model/audio overrides have landed. Immutable from here onward.
		this._capabilities = this.resolveCapabilities();
		this._audioFormat = this.resolveAudioFormat();

		const model = this.config.model ?? 'gpt-realtime-2';

		// Create WebSocket connection using the openai SDK.
		// NOTE: OpenAIRealtimeWS.create() returns immediately after resolving the
		// API key — the underlying WebSocket is NOT open yet.  We must wait for
		// `session.created` (the server's first message) before sending anything.
		this.rt = await OpenAIRealtimeWS.create(this.client, { model });

		// Wire event listeners (before awaiting session.created so events aren't lost)
		this.wireEventListeners();

		// Wait for the WebSocket to open and the server to acknowledge the session
		const sessionId = await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('session.created timeout — WebSocket may have failed to open')),
				15_000,
			);
			this.rt?.once('session.created', (event) => {
				clearTimeout(timeout);
				// biome-ignore lint/suspicious/noExplicitAny: SDK type gap — runtime event includes session id
				resolve((event.session as any)?.id ?? 'unknown');
			});
		});

		this._isConnected = true;

		// Build and send session configuration, wait for confirmation
		const sessionConfig = this.buildSessionConfig();

		// P6: install probe BEFORE the wait so the listener catches an
		// early `error` event referencing prompt_cache_key. The probe handler
		// races session.updated vs error events.
		this.installPromptCacheKeyProbe();

		// Follow-up fix #1: use the queued, ack-correlated helper instead of
		// fire-and-forget rtSend. The connect-time send goes through the same
		// queue subsequent updateSession()/transferSession() calls use, so
		// they serialize correctly even if a caller invokes them
		// before connect() has fully resolved.
		await this.sendSessionUpdateAndWait(sessionConfig);

		// P5: capture the prefix baseline AFTER the initial session.update is
		// acknowledged. Subsequent prefix-mutating sends update this only on
		// success; failed/blocked sends leave it unchanged.
		this.prefixBaselineCanonical = this.computePrefixCanonical(this.instructions, this.tools);

		// Session is fully ready — notify the framework
		if (this.onSessionReady) this.onSessionReady(sessionId);
	}

	async disconnect(): Promise<void> {
		this._isConnected = false;
		this.pendingFunctionCalls.clear();
		this._pendingWhenIdle = [];
		this._isModelGenerating = false;
		this._suppressAudio = false;
		this.lastAssistantItemId = null;
		this.audioOutputMs = 0;
		// Resolve any active-response waiter so callers awaiting
		// cancelResponse({ waitForDone: true }) don't hang past disconnect.
		this._resolveActiveResponseDone?.();
		this._resolveActiveResponseDone = null;
		this._activeResponseDone = Promise.resolve();
		if (this.rt) {
			try {
				this.rt.close();
			} catch {
				// Ignore close errors
			}
			this.rt = null;
		}
	}

	async reconnect(state?: ReconnectState): Promise<void> {
		await this.disconnect();
		await this.connect();

		if (!this.rt) return;

		// Replay conversation history as conversation items
		if (state?.conversationHistory?.length) {
			this.replayHistory(state.conversationHistory);
		}

		// Re-send completed tool results that were in-flight at disconnect time.
		// Executing tool calls are ignored — the framework re-dispatches those.
		if (state?.pendingToolCalls?.length) {
			for (const pending of state.pendingToolCalls) {
				if (pending.status === 'completed' && pending.result !== undefined) {
					this.rt.send({
						type: 'conversation.item.create',
						item: {
							type: 'function_call_output',
							call_id: pending.id,
							output:
								typeof pending.result === 'string'
									? pending.result
									: JSON.stringify(pending.result),
						},
					});
				}
			}
		}
	}

	// --- Audio ---

	sendAudio(base64Data: string): void {
		if (!this.rt || !this._isConnected) return;
		this.rt.send({ type: 'input_audio_buffer.append', audio: base64Data });
	}

	commitAudio(): void {
		if (!this.rt || !this._isConnected) return;
		this.rt.send({ type: 'input_audio_buffer.commit' });
	}

	clearAudio(): void {
		if (!this.rt || !this._isConnected) return;
		this.rt.send({ type: 'input_audio_buffer.clear' });
	}

	clearInputAudio(): void {
		// OpenAI's input buffer is server-side and append-then-auto-commit
		// (see input_audio_buffer.commit semantics). Identical wire effect to
		// clearAudio() — both send `input_audio_buffer.clear`. The two methods
		// remain distinct on the interface so VoiceSession can document
		// "discard pre-arming echo residue" intent at the call site without
		// coupling to the legacy clearAudio name.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §8.
		if (!this.rt || !this._isConnected) return;
		this.rt.send({ type: 'input_audio_buffer.clear' });
	}

	/** Cancel the in-flight response — wire-only actuation. See
	 *  `LLMTransport.cancelResponse` JSDoc on the interface for the contract.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md §2, §7.
	 *
	 *  Returns Promise<void>. Never rejects — transient send failures are
	 *  caught and logged internally. */
	async cancelResponse(opts?: CancelResponseOptions): Promise<void> {
		// Step 1 (no-op fast path): nothing to cancel AND nothing to truncate.
		// True no-op — no state mutation, no wire events. Tail-mode case
		// (post response.done) lands here.
		if (!this._isModelGenerating && !opts?.truncate) {
			return;
		}
		// Steps 2-5 are shared with internal cancel sites (quiesce,
		// sendToolResult({scheduling:'interrupt'})) — centralised so
		// `_suppressAudio` + `_isModelGenerating` state mutation stays in
		// sync regardless of which path triggers a cancel.
		this.actuateCancelInternal(opts?.truncate);
		// Step 6 (optional): wait for response.done to acknowledge the cancel.
		// Races with a 2000 ms timeout so a missing/late ack doesn't hang the
		// direct-input FIFO or tool-result interrupt queue forever.
		if (opts?.waitForDone) {
			const TIMEOUT_MS = 2000;
			const timeout = new Promise<void>((resolve) => {
				setTimeout(() => {
					console.warn(
						`[OpenAIRealtimeTransport] cancelResponse waitForDone timed out after ${TIMEOUT_MS}ms — proceeding`,
					);
					resolve();
				}, TIMEOUT_MS).unref?.();
			});
			await Promise.race([this._activeResponseDone, timeout]);
		}
	}

	/** Shared cancel-actuation steps used by both public `cancelResponse` and
	 *  internal sites (`quiesce`, `sendToolResult({scheduling:'interrupt'})`).
	 *  Runs §2 steps 2-5: suppress late audio, optional truncate, send
	 *  `response.cancel` if a response is in flight, reset
	 *  `_isModelGenerating`. No top-level no-op guard — internal callers
	 *  invoke only when they know a response is in flight (or want the
	 *  state-mutation parity even when one isn't).
	 *  Never rejects — wraps wire sends in try/catch + console.warn.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md §7. */
	private actuateCancelInternal(truncate?: CancelResponseOptions['truncate']): void {
		this._suppressAudio = true;
		if (truncate && this.lastAssistantItemId) {
			const rawMs = truncate === 'generated' ? this.audioOutputMs : truncate.audioEndMs;
			const audioEndMs = Math.max(0, Math.floor(rawMs));
			try {
				this.rt?.send({
					type: 'conversation.item.truncate',
					item_id: this.lastAssistantItemId,
					content_index: 0,
					audio_end_ms: audioEndMs,
				});
			} catch (err) {
				console.warn('[OpenAIRealtimeTransport] truncate send failed:', err);
			}
		}
		if (this._isModelGenerating) {
			try {
				this.rt?.send({ type: 'response.cancel' });
			} catch (err) {
				console.warn('[OpenAIRealtimeTransport] response.cancel send failed:', err);
			}
		}
		this._isModelGenerating = false;
	}

	// --- Quiesce / unquiesce (cross-provider transcription-mode contract) ---

	/** Pause the transport without disconnecting. Used by VoiceSession to
	 *  enter transcription mode without tearing the WS down.
	 *
	 *  Implementation:
	 *   1. If a response is in flight, send response.cancel so the model stops
	 *      generating.
	 *   2. Set _suppressAudio so any onAudioOutput deltas already in flight
	 *      are dropped (existing flag re-used).
	 *
	 *  Idempotent: calling quiesce() while already quiesced is a no-op. */
	async quiesce(): Promise<void> {
		this._quiesced = true;
		if (!this.rt || !this._isConnected) return;
		// Route through the shared cancel-actuation helper so quiesce stays
		// in lockstep with cancelResponse on `_suppressAudio` +
		// `_isModelGenerating` state mutation. The helper itself logs send
		// failures and never throws. See design-greeting-interrupt-grace.md §7.
		this.actuateCancelInternal();
	}

	/** Resume normal operation. Idempotent. Drains any when_idle tool
	 *  results that accumulated while quiesced — those were deferred so
	 *  flushPendingWhenIdle wouldn't fire `response.create` during
	 *  dictation mode. */
	async unquiesce(): Promise<void> {
		this._quiesced = false;
		this._suppressAudio = false;
		this.flushPendingWhenIdle();
	}

	// --- Session configuration ---

	async updateSession(config: SessionUpdate): Promise<void> {
		// P5: enforce prefix-stability BEFORE any state mutation or wire send,
		// so a thrown CachePrefixMutationError leaves the transport unchanged.
		// Pre-connect path is exempt (returns false).
		const isSamePrefix = this.checkPrefixStability(config, /* isTransfer */ false);

		// State mutation always happens (pre-connect coalescing relies on this).
		if (config.instructions !== undefined) {
			this.instructions = config.instructions;
		}
		if (config.tools !== undefined) {
			this.tools = config.tools;
		}
		if (config.responseModality !== undefined) {
			this._textMode = config.responseModality === 'text';
		}
		if (config.transcription?.input !== undefined) {
			// false → disable transcription (transcriptionModel=null sentinel,
			// which buildSessionConfig already handles). true → restore default
			// model (transcriptionModel=undefined falls through to default).
			this.config = {
				...this.config,
				transcriptionModel: config.transcription.input === false ? null : undefined,
			};
		}

		// Pre-connect: state-only, no wire send. Multiple pre-connect calls coalesce —
		// the merged state is sent in the single `session.update` issued at connect time.
		if (!this.rt || !this._isConnected) return;

		// Post-connect: send `session.update` on the wire.
		// Cache-bust telemetry. instructions / tools mutations always bust the
		// session prefix; responseModality changes do not (they don't enter the
		// cached input prefix). Fire once per actual mutation; prefer
		// 'instructions_changed' when both change in one call so the metric
		// stays sane. P5: skip the bust signal when the canonical prefix is
		// unchanged — same-text/same-tools updates don't bust the cache.
		if (this.onCacheBust && !isSamePrefix) {
			if (config.instructions !== undefined) this.onCacheBust('instructions_changed');
			else if (config.tools !== undefined) this.onCacheBust('tools_changed');
		}

		const update: Partial<RealtimeSessionCreateRequest> = {};
		if (config.instructions !== undefined) {
			update.instructions = config.instructions;
		}
		if (config.tools !== undefined) {
			// biome-ignore lint/suspicious/noExplicitAny: SDK tools type is complex; our tool format is compatible at runtime
			update.tools = config.tools.map(toolToOpenAIFunction) as any;
		}
		if (config.responseModality !== undefined) {
			update.output_modalities = config.responseModality === 'text' ? ['text'] : ['audio'];
		}
		if (config.transcription?.input !== undefined) {
			// Toggle server-side transcription on the wire.
			// biome-ignore lint/suspicious/noExplicitAny: transcription:null is valid wire value but not in SDK union
			(update as any).audio = {
				input: {
					transcription:
						config.transcription.input === false
							? null
							: { model: this.config.transcriptionModel ?? 'gpt-4o-mini-transcribe' },
				},
			};
		}

		// P3: re-apply cacheConfig.truncation on every session.update so the
		// server retains the policy across mutations. transferSession does the
		// same — both paths bypass buildSessionConfig().
		applyOpenAICacheConfig(
			update as Record<string, unknown>,
			this.config.cacheConfig,
			this.currentPromptCacheKeyProbeState(),
		);

		// Follow-up fix #1: send through the queued, ack-correlated helper.
		// `await` guarantees the server acknowledged before the caller sees
		// the resolved promise — concurrent callers serialize via the queue.
		await this.sendSessionUpdateAndWait(update);

		// P5: update the prefix baseline only AFTER a successful ack — if the
		// helper rejects, control bypasses this line and the baseline is
		// unchanged, so a subsequent retry isn't compared against a drifted
		// baseline. Same lifecycle as transferSession() below.
		if (!isSamePrefix && (config.instructions !== undefined || config.tools !== undefined)) {
			this.prefixBaselineCanonical = this.computePrefixCanonical(this.instructions, this.tools);
		}
	}

	// --- Agent transfer (in-place via session.update — no reconnect needed) ---

	async transferSession(config: SessionUpdate, _state?: ReconnectState): Promise<void> {
		// P5: enforce prefix-stability for transfers (transfers default to
		// allowed; opt-out via cacheConfig.allowMutationOnTransfer === false).
		const isSamePrefix = this.checkPrefixStability(config, /* isTransfer */ true);

		const update: Partial<RealtimeSessionCreateRequest> = {};

		if (config.instructions !== undefined) {
			this.instructions = config.instructions;
			update.instructions = config.instructions;
		}
		if (config.tools !== undefined) {
			this.tools = config.tools;
			// biome-ignore lint/suspicious/noExplicitAny: SDK tools type is complex; our tool format is compatible at runtime
			update.tools = config.tools.map(toolToOpenAIFunction) as any;
		}
		if (config.responseModality !== undefined) {
			this._textMode = config.responseModality === 'text';
			update.output_modalities = config.responseModality === 'text' ? ['text'] : ['audio'];
		}

		if (!this.rt || !this._isConnected) return;

		// Cache-bust telemetry — see updateSession for rationale.
		// P5: skip when canonical prefix unchanged.
		if (this.onCacheBust && !isSamePrefix) {
			if (config.instructions !== undefined) this.onCacheBust('instructions_changed');
			else if (config.tools !== undefined) this.onCacheBust('tools_changed');
		}

		// P3: in-place transfers must also carry cacheConfig.truncation. Without
		// this, the server would lose the policy on agent handoff.
		applyOpenAICacheConfig(
			update as Record<string, unknown>,
			this.config.cacheConfig,
			this.currentPromptCacheKeyProbeState(),
		);

		// Follow-up fix #1: route through the queued helper so a transfer
		// invoked while another session.update is in flight serializes
		// correctly. Replaces the per-call ad-hoc session.updated listener
		// (which would race with concurrent updates).
		await this.sendSessionUpdateAndWait(update);

		// P5: update prefix baseline AFTER ack — only on real prefix change.
		if (!isSamePrefix && (config.instructions !== undefined || config.tools !== undefined)) {
			this.prefixBaselineCanonical = this.computePrefixCanonical(this.instructions, this.tools);
		}
	}

	// --- Content injection (greetings, directives, text input) ---

	sendContent(turns: ContentTurn[], turnComplete = true): void {
		if (!this.rt || !this._isConnected) return;

		for (const turn of turns) {
			if (turn.role === 'assistant') {
				this.rt.send({
					type: 'conversation.item.create',
					item: {
						type: 'message',
						role: 'assistant',
						content: [{ type: 'output_text', text: turn.text }],
					},
				});
			} else {
				this.rt.send({
					type: 'conversation.item.create',
					item: {
						type: 'message',
						role: 'user',
						content: [{ type: 'input_text', text: turn.text }],
					},
				});
			}
		}

		if (turnComplete) {
			this.rt.send({ type: 'response.create' });
		}
	}

	// --- File/image injection ---

	sendFile(base64Data: string, mimeType: string): void {
		if (!this.rt || !this._isConnected) return;

		// OpenAI Realtime GA supports image input via conversation items
		// The SDK expects image_url as a data URI (e.g. "data:image/png;base64,...")
		this.rt.send({
			type: 'conversation.item.create',
			item: {
				type: 'message',
				role: 'user',
				content: [
					{
						type: 'input_image',
						image_url: `data:${mimeType};base64,${base64Data}`,
					},
				],
			},
		});
	}

	// --- Tool interaction ---

	sendToolResult(result: TransportToolResult): void {
		if (!this.rt || !this._isConnected) return;

		const scheduling = result.scheduling ?? 'immediate';

		// 'when_idle': buffer if model is mid-response, flush on response.done
		if (scheduling === 'when_idle' && this._isModelGenerating) {
			this._pendingWhenIdle.push(result);
			return;
		}

		// 'interrupt': cancel in-flight response before delivering. Routed
		// through actuateCancelInternal so the shared cancel-actuation state
		// (`_suppressAudio` + `_isModelGenerating`) stays consistent with the
		// public cancelResponse path and any framework-owned barge-in.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §7.
		if (scheduling === 'interrupt' && this._isModelGenerating) {
			this.actuateCancelInternal();
		}

		// Send the tool output as a conversation item
		this.rt.send({
			type: 'conversation.item.create',
			item: {
				type: 'function_call_output',
				call_id: result.id,
				output: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
			},
		});

		// Trigger response generation (OpenAI requires explicit response.create).
		// 'silent': skip — result is injected without triggering a new turn.
		if (scheduling !== 'silent') {
			this.rt.send({ type: 'response.create' });
		}
	}

	// --- Generation control ---

	triggerGeneration(
		instructions?: string,
		overrides?: { reasoning?: { effort: ReasoningEffort } },
	): void {
		if (!this.rt || !this._isConnected) return;

		// Build response.create payload. Per-response instructions and reasoning
		// overrides do NOT mutate the session prefix, so they are cache-safe for
		// subsequent turns (the current Response itself may see a slightly reduced
		// cache hit because its prefix differs).
		const response: Record<string, unknown> = {};
		if (instructions) response.instructions = instructions;
		if (overrides?.reasoning) {
			// Gate per-response reasoning on model capability — if the model
			// doesn't support reasoning, drop the override silently. Strict mode
			// is for session-level gating only; per-response is best-effort.
			const model = this.config.model ?? 'gpt-realtime-2';
			if (supports(model, 'reasoning')) {
				response.reasoning = { effort: overrides.reasoning.effort };
			}
		}

		if (Object.keys(response).length > 0) {
			this.rt.send({
				type: 'response.create',
				// biome-ignore lint/suspicious/noExplicitAny: SDK type for response.create.response is strict
				response: response as any,
			});
		} else {
			this.rt.send({ type: 'response.create' });
		}
	}

	// --- Private helpers ---

	/** Type-safe send wrapper that accepts our dynamically-built events. */
	// biome-ignore lint/suspicious/noExplicitAny: session.update events are built dynamically; SDK types are strict but compatible at runtime
	private rtSend(event: any): void {
		this.rt?.send(event as RealtimeClientEvent);
	}

	private applyTransportConfig(config: LLMTransportConfig): void {
		if (config.auth?.type === 'api_key') {
			// Re-construct the SDK client preserving the existing organization/
			// project/baseURL so the P6 probe scope keys stay stable.
			this.client = new OpenAI({
				apiKey: config.auth.apiKey,
				...(this.config.organization !== undefined
					? { organization: this.config.organization }
					: {}),
				...(this.config.project !== undefined ? { project: this.config.project } : {}),
				...(this.config.baseURL !== undefined ? { baseURL: this.config.baseURL } : {}),
			});
		}
		if (config.model !== undefined) {
			this.config.model = config.model;
		}
		if (config.instructions !== undefined) {
			this.instructions = config.instructions;
		}
		if (config.tools !== undefined) {
			this.tools = config.tools;
		}
		if (config.voice !== undefined) {
			this.voice = config.voice;
		}
		if (config.transcription !== undefined) {
			this.config.transcriptionModel = config.transcription.input === false ? null : undefined;
		}
		if (config.responseModality !== undefined) {
			this._textMode = config.responseModality === 'text';
		}
	}

	/** Validate and normalise an OpenAI audio format. Rejects non-24kHz PCM and
	 *  ignores `rate` for G.711 (always 8000). */
	private normaliseAudioFormat(fmt: OpenAIRealtimeAudioFormat): { type: string; rate?: number } {
		if (fmt.type === 'audio/pcm') {
			const rate = fmt.rate ?? 24000;
			if (rate !== 24000) {
				throw new TransportError(
					`UNSUPPORTED_SAMPLE_RATE: OpenAI Realtime 'audio/pcm' only accepts 24000 Hz, got ${rate}`,
				);
			}
			return { type: 'audio/pcm', rate: 24000 };
		}
		// G.711 μ-law — rate is fixed at 8 kHz; the SDK doesn't take a rate field.
		return { type: 'audio/pcmu' };
	}

	/** Drop or throw on a gated config field unsupported for the active model. */
	private gateField(field: string, model: string): void {
		const msg = `OpenAIRealtimeTransport: field '${field}' is not supported by model '${model}'; dropping.`;
		if (this.config.strict) {
			throw new TransportError(`UNSUPPORTED_FEATURE: ${msg}`);
		}
		// Intentional warn-on-drop in non-strict mode — surfaces the silent
		// feature drop to ops without crashing user code.
		console.warn(msg);
	}

	/** Follow-up fix #1: serial, ack-correlated session.update send.
	 *  - Tags the outgoing payload with a fresh event_id (OpenAI errors echo
	 *    this; success acks do not, so the FIFO queue is what makes
	 *    session.updated unambiguous).
	 *  - Resolves on session.updated.
	 *  - Rejects with the error (also returned to caller) when a matching
	 *    `error` event arrives. Matching = `event_id` equals the outgoing
	 *    one, OR (for general failures) the next error event before
	 *    session.updated.
	 *  - 15s timeout rejects with a Transport-style timeout error.
	 *
	 *  Used by connect() (initial), updateSession(), and transferSession()
	 *  so concurrent callers serialize via the queue. */
	private async sendSessionUpdateAndWait(
		session: Partial<RealtimeSessionCreateRequest>,
	): Promise<void> {
		const rt = this.rt;
		if (!rt) throw new TransportError('sendSessionUpdateAndWait called with no active socket');
		this._sessionUpdateEventIdCounter += 1;
		const eventId = `sess_upd_${this._sessionUpdateEventIdCounter}`;
		const task = async () => {
			return await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					cleanup();
					reject(new TransportError('session.update timeout'));
				}, 15_000);
				const onUpdated = () => {
					cleanup();
					resolve();
				};
				const onError = (event: unknown) => {
					// biome-ignore lint/suspicious/noExplicitAny: SDK error event shape varies
					const e = event as any;
					const echoedId: string | undefined = e?.event_id ?? e?.error?.event_id;
					// Match either by echoed event_id (preferred) or by being the
					// next error before session.updated (fallback for SDKs that
					// drop the echo).
					if (echoedId !== undefined && echoedId !== eventId) return;
					cleanup();
					const err = e?.error ?? e;
					reject(
						err instanceof Error
							? err
							: new TransportError(
									typeof err?.message === 'string' ? err.message : 'session.update error',
									{ cause: err },
								),
					);
				};
				const cleanup = () => {
					clearTimeout(timeout);
					rt.off?.('session.updated', onUpdated);
					rt.off?.('error', onError);
				};
				rt.once('session.updated', onUpdated);
				rt.on('error', onError);
				this.rtSend({
					type: 'session.update',
					session: session as RealtimeSessionCreateRequest,
					// biome-ignore lint/suspicious/noExplicitAny: event_id is documented but not in the SDK request type
					...({ event_id: eventId } as any),
				});
			});
		};
		// Single-flight: chain after any in-flight task; swallow upstream
		// rejections in the chain itself so a failed prior task doesn't
		// poison this one's promise (it still runs after the prior settles).
		const next = this._sessionUpdateQueue.then(task, task);
		this._sessionUpdateQueue = next.catch(() => undefined);
		return next;
	}

	/** P6: derive the current promptCacheKey probe state for this transport.
	 *  Returns 'unknown' when no key is configured (probe not applicable). */
	private currentPromptCacheKeyProbeState(): CacheKeyProbeState {
		const key = this.config.cacheConfig?.experimental?.promptCacheKey;
		if (!key) return 'unknown';
		const scope = derivePromptCacheKeyProbeScope(
			this.client.baseURL,
			this.client.organization ?? undefined,
			this.client.project ?? undefined,
			this.config.model,
			key,
		);
		return getPromptCacheKeyProbeState(scope);
	}

	/** P6: install a one-shot listener that races `session.updated` against an
	 *  `error` event referencing `prompt_cache_key`. Called from connect()
	 *  after the initial session.update is sent, only when:
	 *  (a) cacheConfig.experimental.promptCacheKey is set, AND
	 *  (b) the probe state for that scope is currently 'unknown'.
	 *  On rejection: marks scope rejected, suppresses the error from
	 *  user-facing onError, and resends session.update without the key on
	 *  the same socket (no full reconnect). */
	private installPromptCacheKeyProbe(): void {
		const cfg = this.config.cacheConfig?.experimental?.promptCacheKey;
		if (!cfg || !this.rt) return;
		const scope = derivePromptCacheKeyProbeScope(
			this.client.baseURL,
			this.client.organization ?? undefined,
			this.client.project ?? undefined,
			this.config.model,
			cfg,
		);
		if (getPromptCacheKeyProbeState(scope) !== 'unknown') return;
		const rt = this.rt;
		let settled = false;
		// Follow-up fix #2: mark this scope as in-flight so the generic
		// rt.on('error') handler suppresses the matching probe rejection
		// from user-facing onError. Cleared in `finalize()` regardless of
		// outcome.
		this._inFlightProbeScope = scope;
		const finalize = () => {
			if (this._inFlightProbeScope === scope) this._inFlightProbeScope = null;
		};
		const onUpdated = () => {
			if (settled) return;
			settled = true;
			setPromptCacheKeyProbeState(scope, 'accepted');
			rt.off?.('error', onError);
			finalize();
		};
		// biome-ignore lint/suspicious/noExplicitAny: SDK error event shape varies
		const onError = (event: any) => {
			if (settled) return;
			const err = (event?.error ?? event) as {
				code?: string;
				message?: string;
				param?: string;
			};
			const isProbeError =
				err?.param === 'prompt_cache_key' ||
				err?.code === 'unknown_parameter' ||
				(typeof err?.message === 'string' && err.message.includes('prompt_cache_key'));
			if (!isProbeError) return;
			settled = true;
			setPromptCacheKeyProbeState(scope, 'rejected');
			rt.off?.('session.updated', onUpdated);
			console.warn(
				`[openai-realtime-transport] prompt_cache_key rejected by server (scope=${scope}); stripping the field from subsequent session.update payloads. This rejection is suppressed from the user-facing onError handler.`,
			);
			// Retry the same session.update WITHOUT the key on the same socket.
			// Build a fresh sessionConfig (which now consults the updated probe
			// state and omits prompt_cache_key) and send it.
			try {
				const retry = this.buildSessionConfig();
				this.rtSend({ type: 'session.update', session: retry });
			} catch (retryErr) {
				// If the retry itself fails, surface to user onError.
				if (this.onError) {
					this.onError({
						error: retryErr instanceof Error ? retryErr : new Error(String(retryErr)),
						recoverable: false,
					});
				}
			}
			finalize();
		};
		rt.once('session.updated', onUpdated);
		rt.on('error', onError);
		// Auto-cleanup after 15s in case neither event arrives.
		setTimeout(() => {
			if (settled) return;
			settled = true;
			rt.off?.('session.updated', onUpdated);
			rt.off?.('error', onError);
			finalize();
		}, 15_000);
	}

	/** P5: compute the canonical prefix snapshot string for a given
	 *  (instructions, tools) pair. Tools are normalized to the wire shape
	 *  (toolToOpenAIFunction) before canonicalizing so that ToolDefinition
	 *  objects with different function references but identical wire output
	 *  compare equal. */
	private computePrefixCanonical(
		instructions: string | undefined,
		tools: ToolDefinition[] | undefined,
	): string {
		const wireTools = tools?.map(toolToOpenAIFunction) ?? null;
		return JSON.stringify(canonicalize({ instructions: instructions ?? null, tools: wireTools }));
	}

	/** P5: enforce prefix-stability if the caller opted in via
	 *  cacheConfig.enforcePrefixStability. Returns true if the call should
	 *  proceed AS A NO-OP for cache-bust purposes (same canonical prefix);
	 *  returns false if the call should proceed normally; throws
	 *  CachePrefixMutationError if the call must be rejected. Other
	 *  SessionUpdate fields (responseModality, providerOptions) flow through
	 *  regardless. */
	private checkPrefixStability(config: SessionUpdate, isTransfer: boolean): boolean {
		const cacheCfg = this.config.cacheConfig;
		if (!cacheCfg?.enforcePrefixStability) return false;
		// Pre-connect mutations are always allowed; baseline isn't captured
		// until after the initial session.updated ack.
		if (this.prefixBaselineCanonical === null) return false;

		// Only consider a mutation if instructions or tools is being changed.
		const prefixFieldsTouched = config.instructions !== undefined || config.tools !== undefined;
		if (!prefixFieldsTouched) return false;

		// Compute what the new canonical prefix WOULD be after this update.
		const nextInstructions =
			config.instructions !== undefined ? config.instructions : this.instructions;
		const nextTools = config.tools !== undefined ? config.tools : this.tools;
		const nextCanonical = this.computePrefixCanonical(nextInstructions, nextTools);

		if (nextCanonical === this.prefixBaselineCanonical) {
			// Same-prefix update — treat as no-op for the throw decision but
			// let other fields in the same call still flow to the wire.
			return true;
		}

		// Real prefix mutation. Transfers respect allowMutationOnTransfer (default true).
		if (isTransfer && cacheCfg.allowMutationOnTransfer !== false) {
			return false; // proceed; baseline updated post-success
		}
		throw new CachePrefixMutationError(
			isTransfer
				? 'enforcePrefixStability + allowMutationOnTransfer=false: transfer would mutate prefix'
				: 'enforcePrefixStability: connected, non-transfer updateSession would mutate prefix',
		);
	}

	/** Single resolver consumed by `buildSessionConfig` (wire),
	 *  `effectiveInterruptResponse` (capability gating), and
	 *  `resolveCapabilities` (the runtime `frameworkOwnsInterrupt` /
	 *  `greetingInterruptGraceMs` values). Keeping all three in sync via one
	 *  function prevents capability/wire-config drift.
	 *
	 *  Type-aware merging:
	 *   - `null` → wire `null` (manual turn control; no defaults injected;
	 *     framework-owned interrupt N/A).
	 *   - `semantic_vad` → injects `eagerness` + `create_response` +
	 *     `interrupt_response` defaults under the caller's overrides.
	 *   - `server_vad` → injects only `create_response` +
	 *     `interrupt_response` (no `eagerness` — that field is semantic-only;
	 *     server-VAD threshold/padding/duration fields are caller-supplied).
	 *   - Other / future types → only common defaults under caller overrides.
	 *
	 *  Caller spread is always **last**, so caller-explicit fields win
	 *  (including `interrupt_response: true` for legacy callers).
	 *
	 *  Phase B4 keeps `interrupt_response: true` as the default to preserve
	 *  pre-design behaviour. Phase B8 flips this default to `false` (the
	 *  framework-owned interrupt mode) and runtime-computes the capability
	 *  flags from the resolved value.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md §3. */
	private resolveTurnDetectionConfig(): {
		wire: Record<string, unknown> | null;
		effective: { interrupt_response: boolean; create_response: boolean };
	} {
		const callerTd = this.config.turnDetection;

		// Explicit null: caller is disabling VAD entirely. Frame-by-frame
		// commit via commitAudio() — no auto-create, no auto-interrupt.
		if (callerTd === null) {
			return {
				wire: null,
				effective: { interrupt_response: false, create_response: false },
			};
		}

		const callerTdObj = (callerTd ?? {}) as Record<string, unknown>;
		const callerType = (callerTdObj.type as string | undefined) ?? 'semantic_vad';

		// Framework-owned interruption (Phase B8 default flip): the framework
		// actuates response cancellation via cancelResponse() — the provider
		// does NOT auto-cancel on speech_started. Required so the
		// greeting-grace window can suppress echo-driven barge-ins without
		// being defeated by an unsuppressible provider auto-cancel. Callers
		// who explicitly pass `interrupt_response: true` keep legacy behavior,
		// and the connect-time validation in VoiceSession (§5) downgrades the
		// grace to 0 with a warn for them.
		const commonDefaults: Record<string, unknown> = {
			create_response: true,
			interrupt_response: false,
		};

		const wire: Record<string, unknown> =
			callerType === 'semantic_vad'
				? { type: 'semantic_vad', eagerness: 'medium', ...commonDefaults, ...callerTdObj }
				: callerType === 'server_vad'
					? { type: 'server_vad', ...commonDefaults, ...callerTdObj }
					: { ...commonDefaults, ...callerTdObj };

		return {
			wire,
			effective: {
				interrupt_response: wire.interrupt_response === true,
				create_response: wire.create_response !== false,
			},
		};
	}

	private buildSessionConfig(): RealtimeSessionCreateRequest {
		const inFmt = this.normaliseAudioFormat(
			this.config.audioInputFormat ?? { type: 'audio/pcm', rate: 24000 },
		);
		const outFmt = this.normaliseAudioFormat(
			this.config.audioOutputFormat ?? { type: 'audio/pcm', rate: 24000 },
		);

		const session: RealtimeSessionCreateRequest = {
			type: 'realtime',
			output_modalities: this._textMode ? ['text'] : ['audio'],
			audio: {
				input: {
					// biome-ignore lint/suspicious/noExplicitAny: SDK format type is a strict union; G.711 string is valid at runtime
					format: inFmt as any,
					...(this.config.transcriptionModel !== null
						? {
								transcription: {
									model: this.config.transcriptionModel ?? 'gpt-4o-mini-transcribe',
								},
							}
						: {}),
					// biome-ignore lint/suspicious/noExplicitAny: SDK type is a strict union; wire is the canonical shape
					turn_detection: this.resolveTurnDetectionConfig().wire as any,
					...(this.config.noiseReduction
						? // biome-ignore lint/suspicious/noExplicitAny: noise reduction config is passed through from user
							{ noise_reduction: this.config.noiseReduction as any }
						: {}),
				},
				...(!this._textMode
					? {
							output: {
								// biome-ignore lint/suspicious/noExplicitAny: SDK format type is a strict union; G.711 string is valid at runtime
								format: outFmt as any,
								voice: this.voice,
							},
						}
					: {}),
			},
		};

		// gpt-realtime-2 feature gating.
		const model = this.config.model ?? 'gpt-realtime-2';
		if (this.config.reasoning) {
			if (supports(model, 'reasoning')) {
				// biome-ignore lint/suspicious/noExplicitAny: SDK reasoning field may not be in current types
				(session as any).reasoning = {
					...(this.config.reasoning.effort !== undefined
						? { effort: this.config.reasoning.effort }
						: {}),
					...(this.config.reasoning.summary !== undefined
						? { summary: this.config.reasoning.summary }
						: {}),
				};
			} else {
				this.gateField('reasoning', model);
			}
		}

		if (this.instructions) {
			session.instructions = this.instructions;
		}
		if (this.tools?.length) {
			// biome-ignore lint/suspicious/noExplicitAny: our tool format is compatible with SDK at runtime
			session.tools = this.tools.map(toolToOpenAIFunction) as any;
		}

		// P3: cacheConfig.truncation. Single insertion point — same helper is
		// also called from updateSession() and transferSession() so the field
		// survives both reconnect (rebuilds via this method) and in-place
		// transfers (which do NOT call this method).
		applyOpenAICacheConfig(
			session as unknown as Record<string, unknown>,
			this.config.cacheConfig,
			this.currentPromptCacheKeyProbeState(),
		);

		return session;
	}

	private wireEventListeners(): void {
		if (!this.rt) return;
		const rt = this.rt;

		// --- Audio output ---
		rt.on('response.output_audio.delta', (event) => {
			// _quiesced is the durable, cross-response suppression flag set by
			// quiesce(); _suppressAudio is the per-turn interruption flag set
			// by barge-in. Either dropping the audio is correct.
			if (this._quiesced || this._suppressAudio) return;
			if (this.onAudioOutput) this.onAudioOutput(event.delta);

			// Track audio duration for interruption handling. Uses the resolved
			// OUTPUT-side audioFormat so G.711 telephony (1 byte/sample, 8 kHz)
			// computes the right `audio_end_ms` for conversation.item.truncate
			// regardless of input encoding.
			const bytes = Buffer.from(event.delta, 'base64').length;
			const outBitDepth = this._audioFormat.outputBitDepth ?? this._audioFormat.bitDepth;
			const bps = outBitDepth === 8 ? 1 : 2;
			const samples = bytes / bps;
			this.audioOutputMs += (samples / this._audioFormat.outputSampleRate) * 1000;
		});

		// --- Text output (text mode — for TTS) ---
		// biome-ignore lint/suspicious/noExplicitAny: event name may not be in SDK types yet
		(rt as any).on('response.output_text.delta', (event: any) => {
			if (this.onTextOutput && event.delta) this.onTextOutput(event.delta);
		});
		// biome-ignore lint/suspicious/noExplicitAny: event name may not be in SDK types yet
		(rt as any).on('response.output_text.done', () => {
			if (this.onTextDone) this.onTextDone();
		});

		// --- Response lifecycle: track when a response is active ---
		rt.on('response.created', () => {
			this._isModelGenerating = true;
			// Arm the active-response waiter — see _activeResponseDone field.
			// `response.done` (any status) and disconnect/error resolve it.
			this._activeResponseDone = new Promise<void>((resolve) => {
				this._resolveActiveResponseDone = resolve;
			});
			// Only clear per-turn barge-in suppression. The durable _quiesced
			// flag stays set until unquiesce() — preserves the transcription-mode
			// dictation-only guarantee even if a response sneaks in.
			if (!this._quiesced) this._suppressAudio = false;
			// Reset per-response state.
			this.completedToolCallsThisResponse = [];
			this._reasoningStartedAt = null;
			this._reasoningTokensThisResponse = undefined;
			if (this.onModelTurnStart) this.onModelTurnStart();
		});

		// --- Track assistant output items for interruption + reasoning lifecycle ---
		rt.on('response.output_item.added', (event) => {
			const item = event.item;
			// ConversationItem is a union; only messages have role.
			if ('role' in item && item.role === 'assistant' && item.id) {
				this.lastAssistantItemId = item.id;
				this.audioOutputMs = 0;
			}
			// Reasoning items signal model thinking has started. SDK union does
			// not yet enumerate 'reasoning' as an item.type, so cast through any.
			// biome-ignore lint/suspicious/noExplicitAny: SDK item.type union missing 'reasoning'
			if ((item as any).type === 'reasoning') {
				this._reasoningStartedAt = Date.now();
				if (this.onReasoningStart) this.onReasoningStart();
			}
		});

		// --- Reasoning summary streaming (only when summary is requested) ---
		// biome-ignore lint/suspicious/noExplicitAny: event name not in SDK types
		(rt as any).on('response.reasoning_summary_text.delta', (event: { delta?: string }) => {
			if (this.onReasoningSummary && event.delta) this.onReasoningSummary(event.delta);
		});

		// --- Tool call argument streaming (accumulate per item_id) ---
		rt.on('response.function_call_arguments.delta', (event) => {
			const buffer = this.pendingFunctionCalls.get(event.item_id) ?? '';
			this.pendingFunctionCalls.set(event.item_id, buffer + event.delta);
		});

		// --- Output-item complete: buffer tool calls; close out reasoning items ---
		// Tool calls are batched per response and dispatched together on
		// response.done so parallel calls reach the router as one onToolCall(calls[]).
		// Reasoning items emit onReasoningDone with duration + token count.
		rt.on('response.output_item.done', (event) => {
			const item = event.item;
			if (item.type === 'function_call') {
				const rawArgs = (item.id && this.pendingFunctionCalls.get(item.id)) || item.arguments;
				if (item.id) this.pendingFunctionCalls.delete(item.id);

				let args: Record<string, unknown> = {};
				if (rawArgs) {
					try {
						args = JSON.parse(rawArgs);
					} catch {
						if (this.onError) {
							this.onError({
								error: new Error(
									`Failed to parse tool call arguments for ${item.name}: ${rawArgs}`,
								),
								recoverable: true,
							});
						}
						return;
					}
				}
				this.completedToolCallsThisResponse.push({
					id: item.call_id ?? item.id ?? '',
					name: item.name ?? '',
					args,
				});
				// biome-ignore lint/suspicious/noExplicitAny: SDK item.type union missing 'reasoning'
			} else if ((item as any).type === 'reasoning') {
				// Reasoning step closed — fire onReasoningDone with duration.
				// reasoningTokens lands later via response.done.usage; we capture
				// it after the usage event and re-emit if needed. For now, fire
				// duration only; tokens flow through onRealtimeLLMUsage.
				if (this.onReasoningDone && this._reasoningStartedAt !== null) {
					this.onReasoningDone({
						durationMs: Date.now() - this._reasoningStartedAt,
						reasoningTokens: this._reasoningTokensThisResponse,
					});
				}
				this._reasoningStartedAt = null;
			}
		});

		// --- Turn complete: dispatch batched tool calls, normalise usage,
		//                     flush when_idle queue, signal turn done. ---
		rt.on('response.done', (event: unknown) => {
			// Resolve the active-response waiter first — any status (completed,
			// cancelled, failed) terminates the response and unblocks
			// `cancelResponse({ waitForDone: true })` callers waiting on us.
			this._resolveActiveResponseDone?.();
			this._resolveActiveResponseDone = null;

			const e = event as { response?: { id?: string; usage?: unknown; status?: string } };
			// A cancelled response is the trailing response.done of a server-VAD
			// barge-in (or an explicit response.cancel). The framework already
			// finalized the interrupted turn via onInterrupted.
			const cancelled = e?.response?.status === 'cancelled';

			const normalized = normalizeOpenAIResponseUsage(e?.response?.usage, e?.response?.id);
			if (normalized) {
				// Capture reasoning-token count if exposed; useful for the
				// next onReasoningDone call if the model fires another reasoning
				// item in a subsequent response.
				this._reasoningTokensThisResponse = normalized.modalityBreakdown?.reasoningTokens;
				if (this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(normalized);
			}

			if (cancelled) {
				// Usage above is still forwarded so it attributes to the
				// interrupted turn. But this trailing response.done must NOT
				// finalize a newer framework turn, dispatch the cancelled
				// response's partial tool calls, or trigger a generation-flush.
				// Only state cleanup runs; onTurnComplete is suppressed.
				this.completedToolCallsThisResponse = [];
				this._isModelGenerating = false;
				this.lastAssistantItemId = null;
				this.audioOutputMs = 0;
				return;
			}

			// Dispatch all parallel function_call items collected during this
			// response in a single onToolCall batch. ToolCallRouter then has
			// the opportunity to dispatch them in parallel.
			if (this.completedToolCallsThisResponse.length > 0 && this.onToolCall) {
				const calls = this.completedToolCallsThisResponse;
				this.completedToolCallsThisResponse = [];
				this.onToolCall(calls);
			} else {
				this.completedToolCallsThisResponse = [];
			}

			this._isModelGenerating = false;
			this.lastAssistantItemId = null;
			this.audioOutputMs = 0;
			this.flushPendingWhenIdle();
			if (this.onTurnComplete) this.onTurnComplete();
		});

		// --- Interruption handling: dual-mode dispatch ---
		// Framework-owned mode (default — interrupt_response: false): the
		// handler is signal-only. The framework's wireNativeBargeIn /
		// wireTtsProvider sites read this signal and decide whether to
		// actuate via cancelResponse(), gated by the greeting-grace window.
		// Provider-owned mode (legacy — caller sets interrupt_response: true):
		// the server auto-cancels the response itself. We still issue the
		// local truncate so the stored item reflects what was heard, and fire
		// onInterrupted so the framework can finalize.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §3.
		rt.on('input_audio_buffer.speech_started', () => {
			// Always fire onSpeechStarted first — TTS barge-in (and the
			// framework's wireNativeBargeIn) need it regardless of mode.
			if (this.onSpeechStarted) this.onSpeechStarted();

			// Framework-owned mode: stop here. cancelResponse() is the
			// framework's actuation path; the local truncate + onInterrupted
			// would double-actuate against it.
			if (this.resolveTurnDetectionConfig().effective.interrupt_response === false) {
				return;
			}

			// Provider-owned (legacy) branch — preserved verbatim.
			if (!this._isModelGenerating) return;
			this._suppressAudio = true;
			if (this.lastAssistantItemId) {
				rt.send({
					type: 'conversation.item.truncate',
					item_id: this.lastAssistantItemId,
					content_index: 0,
					audio_end_ms: Math.floor(this.audioOutputMs),
				});
			}
			this._isModelGenerating = false;
			if (this.onInterrupted) this.onInterrupted();
		});

		// --- Input transcription ---
		rt.on('conversation.item.input_audio_transcription.completed', (event: unknown) => {
			const e = event as { transcript?: string; usage?: unknown; item_id?: string };
			if (this.onInputTranscription) this.onInputTranscription(e.transcript ?? '');
			// P4: pass item_id so EventBus consumers can disambiguate transcription
			// usage events that all have turnId === null.
			const tu = normalizeOpenAITranscriptionUsage(e.usage, e.item_id);
			if (tu && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(tu);
		});

		// --- Output transcription (streaming deltas) ---
		rt.on('response.output_audio_transcript.delta', (event) => {
			if (this.onOutputTranscription) this.onOutputTranscription(event.delta);
		});

		// NOTE: session.created is handled in connect() to control startup ordering.
		// onSessionReady fires at the end of connect() after session.updated confirms.

		// --- Error handling (classify recoverability by error type) ---
		rt.on('error', (error) => {
			// Follow-up fix #2: suppress expected prompt_cache_key probe
			// rejections from the user-facing onError handler. The probe
			// listener (installPromptCacheKeyProbe) handles these by marking
			// the scope rejected and retrying without the key on the same
			// socket; surfacing the same error to the app would defeat the
			// purpose of probing.
			if (this._inFlightProbeScope !== null) {
				// biome-ignore lint/suspicious/noExplicitAny: SDK error event shape varies
				const e = error as any;
				const inner = e?.error ?? e;
				const isProbeError =
					inner?.param === 'prompt_cache_key' ||
					inner?.code === 'unknown_parameter' ||
					(typeof inner?.message === 'string' && inner.message.includes('prompt_cache_key'));
				if (isProbeError) return;
			}
			// Resolve any active-response waiter so a transport error doesn't
			// leave cancelResponse({ waitForDone: true }) callers blocked. The
			// waiter resolves rather than rejects (callers should not have to
			// handle rejections — disconnect already cancels the outer session).
			this._resolveActiveResponseDone?.();
			this._resolveActiveResponseDone = null;
			if (this.onError) {
				const err = error instanceof Error ? error : new Error(String(error));
				// OpenAIRealtimeError has .error.type for classification
				// biome-ignore lint/suspicious/noExplicitAny: checking OpenAIRealtimeError shape without importing SDK internal type
				const errorType: string = (error as any)?.error?.type ?? '';
				const nonRecoverable =
					errorType === 'invalid_request_error' || errorType === 'authentication_error';
				this.onError({ error: err, recoverable: !nonRecoverable });
			}
		});

		// --- Connection close (via raw WebSocket, not the typed emitter) ---
		rt.socket.on('close', (code: number, reason: Buffer) => {
			this._isConnected = false;
			// Resolve any active-response waiter so a socket close doesn't
			// leave cancelResponse({ waitForDone: true }) callers blocked.
			this._resolveActiveResponseDone?.();
			this._resolveActiveResponseDone = null;
			if (this.onClose) this.onClose(code, reason.toString());
		});
	}

	/** Flush any tool results queued with 'when_idle' scheduling. While
	 *  `_quiesced` (cross-provider transcription mode), leaves the queue
	 *  intact and returns early — `response.create` must not fire during
	 *  dictation. `unquiesce()` re-runs this flush to drain whatever
	 *  accumulated. */
	private flushPendingWhenIdle(): void {
		if (!this.rt || this._pendingWhenIdle.length === 0) return;
		if (this._quiesced) return;
		const queued = this._pendingWhenIdle.splice(0);
		for (const result of queued) {
			this.rt.send({
				type: 'conversation.item.create',
				item: {
					type: 'function_call_output',
					call_id: result.id,
					output: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
				},
			});
		}
		// Trigger a single response for all flushed results
		this.rt.send({ type: 'response.create' });
	}

	/** P3: latch so the truncation+replayHistory warning fires at most once
	 *  per transport instance. */
	private _truncationReplayWarned = false;

	private replayHistory(items: ReplayItem[]): void {
		if (!this.rt) return;
		const rt = this.rt;

		// P3: warn when an explicit truncation policy could drop replayed items.
		// Only fires when the caller set cacheConfig.truncation to something
		// other than 'disabled' (server defaults are caller-implicit and don't
		// trigger). One-shot per transport instance to avoid log spam.
		if (
			!this._truncationReplayWarned &&
			items.length > 0 &&
			this.config.cacheConfig?.truncation !== undefined &&
			this.config.cacheConfig.truncation !== 'disabled'
		) {
			this._truncationReplayWarned = true;
			console.warn(
				'[openai-realtime-transport] cacheConfig.truncation is set; replayHistory()' +
					' may have items dropped if the conversation exceeds the model context limit.' +
					" Use cacheConfig.truncation: 'disabled' for sessions that depend on exact" +
					' history replay.',
			);
		}

		for (const item of items) {
			switch (item.type) {
				case 'text':
					if (item.role === 'assistant') {
						rt.send({
							type: 'conversation.item.create',
							item: {
								type: 'message',
								role: 'assistant',
								content: [{ type: 'output_text', text: item.text }],
							},
						});
					} else {
						rt.send({
							type: 'conversation.item.create',
							item: {
								type: 'message',
								role: 'user',
								content: [{ type: 'input_text', text: item.text }],
							},
						});
					}
					break;
				case 'tool_call':
					rt.send({
						type: 'conversation.item.create',
						item: {
							type: 'function_call',
							call_id: item.id,
							name: item.name,
							arguments: JSON.stringify(item.args),
						},
					});
					break;
				case 'tool_result':
					rt.send({
						type: 'conversation.item.create',
						item: {
							type: 'function_call_output',
							call_id: item.id,
							output: JSON.stringify(item.result),
						},
					});
					break;
				case 'transfer':
					rt.send({
						type: 'conversation.item.create',
						item: {
							type: 'message',
							role: 'user',
							content: [
								{
									type: 'input_text',
									text: `[Agent transfer: ${item.fromAgent} → ${item.toAgent}]`,
								},
							],
						},
					});
					break;
				case 'file':
					rt.send({
						type: 'conversation.item.create',
						item: {
							type: 'message',
							role: 'user',
							content: [
								{
									type: 'input_image',
									image_url: `data:${item.mimeType};base64,${item.base64Data}`,
								},
							],
						},
					});
					break;
			}
		}
	}
}
