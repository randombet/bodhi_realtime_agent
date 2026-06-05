// SPDX-License-Identifier: MIT

import type { ToolDefinition } from './tool.js';

/** Reasoning effort dial for reasoning-capable realtime models
 *  (e.g. `gpt-realtime-2`). Trades time-to-first-audio for instruction
 *  following / accuracy. `low` is the documented production default. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Static capabilities — orchestrator branches on these, never on provider names. */
export interface TransportCapabilities {
	/** Can truncate server-side message at audio playback position (OpenAI: yes, Gemini: no). */
	messageTruncation: boolean;
	/** Server-side VAD / end-of-turn detection (V1 requires true). */
	turnDetection: boolean;
	/** Provides transcriptions of user audio input. */
	userTranscription: boolean;
	/** Supports in-place session update without reconnection (OpenAI: yes, Gemini: no). */
	inPlaceSessionUpdate: boolean;
	/** Supports session resumption on disconnect (Gemini: yes, OpenAI: no). */
	sessionResumption: boolean;
	/** Supports server-side context compression (Gemini: yes, OpenAI: no). */
	contextCompression: boolean;
	/** Provides grounding metadata with search citations (Gemini: yes, OpenAI: no). */
	groundingMetadata: boolean;
	/** Supports text-only response modality (required for external TTS).
	 *  Optional — defaults to false. Existing custom transport implementations
	 *  are unaffected until they want to support TTS. */
	textResponseModality?: boolean;
	/** Model can emit multiple `function_call` items in a single response.
	 *  Optional — `undefined` means `false`. Doc-only signal; the transport's
	 *  batched-tool-call dispatch is on for everyone (no-op if only one call). */
	parallelToolCalls?: boolean;
	/** Model exposes a configurable reasoning-effort dial (e.g. `gpt-realtime-2`).
	 *  Optional — `undefined` means `false`. */
	reasoningEffort?: boolean;
	/** Model emits short spoken preambles automatically before tool calls / during
	 *  reasoning. Doc-only signal for behaviour gating (suppress duplicate
	 *  app-side announcements). Optional — `undefined` means `false`. */
	automaticPreambles?: boolean;
	/** Transport implements `quiesce()` / `unquiesce()` for cross-provider
	 *  transcription mode (pause without disconnecting). When `undefined` or
	 *  `false`, VoiceSession falls back to a framework-layer audio-output guard
	 *  during mode flips. */
	quiescible?: boolean;
	/** `onTurnComplete` fires only after model audio playback should be done
	 *  (Gemini Live: yes — `turnComplete` is delayed until playback; OpenAI
	 *  Realtime: no — `response.done` is generation-gated). When `false`, the
	 *  native playback-end gate must supply playback-end gating itself.
	 *  Optional — `undefined` means `false`. EVERY transport should set this
	 *  explicitly; the default exists only so adding the flag does not break
	 *  compilation of existing custom transports.
	 *  See dev_docs/framework/design-playback-end-gating-openai-native.md. */
	playbackGatedTurnComplete?: boolean;
	/** Recommended grace window (ms) at session-first-audio during which
	 *  user-driven interrupts are suppressed and outbound mic frames are
	 *  dropped. Allows browser AEC to converge before the framework lets
	 *  echo-triggered events count as barge-in.
	 *  Defaults: OpenAI Realtime → 1000 (runtime-computed iff
	 *  `frameworkOwnsInterrupt` is `true`), Gemini Live → 0,
	 *  unknown → 0. Optional — `undefined` means `0`.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md. */
	greetingInterruptGraceMs?: number;
	/** True if this transport's interrupt actuation is framework-owned:
	 *  `cancelResponse()` is the wire path the framework uses to stop
	 *  generation, and the provider does **not** auto-cancel from
	 *  server-VAD events. Required for `greetingInterruptGraceMs > 0` to be
	 *  honoured (otherwise the provider auto-cancel defeats the grace).
	 *  Optional — `undefined` means `false`. */
	frameworkOwnsInterrupt?: boolean;
}

/** Explicit defaults for every flag. Downstream `LLMTransport` implementations
 *  can spread this and override only what they actually support, so adding new
 *  flags to the union doesn't break compilation. */
export const DEFAULT_TRANSPORT_CAPABILITIES: Required<TransportCapabilities> = {
	messageTruncation: false,
	turnDetection: false,
	userTranscription: false,
	inPlaceSessionUpdate: false,
	sessionResumption: false,
	contextCompression: false,
	groundingMetadata: false,
	textResponseModality: false,
	parallelToolCalls: false,
	reasoningEffort: false,
	automaticPreambles: false,
	quiescible: false,
	playbackGatedTurnComplete: false,
	greetingInterruptGraceMs: 0,
	frameworkOwnsInterrupt: false,
};

/** Audio format descriptor passed to an STT provider at configuration time. */
export interface STTAudioConfig {
	/** Sample rate in Hz (e.g. 16000 for Gemini, 24000 for OpenAI). */
	sampleRate: number;
	/** Bits per sample (16 for PCM, 8 for G.711 μ-law). */
	bitDepth: number;
	/** Number of channels (1 = mono). */
	channels: number;
	/** Encoding the consumer will deliver. Default `'pcm'` — every existing
	 *  STT provider expects PCM16. A G.711-only provider declares
	 *  `supportedEncodings: ['pcmu']` and `VoiceSession` encodes before feeding. */
	encoding?: 'pcm' | 'pcmu';
}

/**
 * Provider-agnostic interface for pluggable speech-to-text providers.
 *
 * VoiceSession creates the provider, calls configure() with the transport's
 * audio format, then start(). Audio flows via feedAudio(); turn signals via
 * commit()/handleInterrupted()/handleTurnComplete(). Results arrive via the
 * onTranscript/onPartialTranscript callbacks.
 */
export interface STTProvider {
	/** Optional static declaration of which audio encodings the provider can
	 *  consume. When omitted, defaults to `['pcm']` (today's behaviour).
	 *  VoiceSession reads this at configure time and decides whether to feed
	 *  raw PCM or encode to G.711 before calling `feedAudio()`. */
	readonly supportedEncodings?: ReadonlyArray<'pcm' | 'pcmu'>;

	/** Configure the audio format that feedAudio() will deliver.
	 *  Called once before start(). The provider MUST resample or reject
	 *  if it cannot handle the given format. */
	configure(audio: STTAudioConfig): void;

	/** Start the STT session (e.g. open WebSocket). */
	start(): Promise<void>;
	/** Stop the STT session (e.g. close WebSocket). */
	stop(): Promise<void>;

	/** Feed audio data. Format matches the STTAudioConfig from configure().
	 *  @param base64Pcm Base64-encoded PCM audio chunk. */
	feedAudio(base64Pcm: string): void;

	/** Signal that the user's turn has ended (model started responding).
	 *  For batch providers, this triggers transcription.
	 *  For streaming providers, this may trigger a manual commit.
	 *  @param turnId Monotonically increasing turn counter for ordering. */
	commit(turnId: number): void;

	/** Signal that the current turn was interrupted by the user.
	 *  Providers MUST preserve buffered audio for the next commit(). */
	handleInterrupted(): void;

	/** Signal a natural turn completion (model finished, no interruption).
	 *  Batch providers SHOULD clear buffers. Streaming providers may no-op. */
	handleTurnComplete(): void;

	/** Final transcription of user speech.
	 *  @param text The transcribed text.
	 *  @param turnId The turn this transcript belongs to (from commit()).
	 *               Undefined when a streaming provider's VAD auto-commits
	 *               before the framework calls commit(). */
	onTranscript?: (text: string, turnId: number | undefined) => void;

	/** Partial/interim transcription (streaming providers only).
	 *  Replaces any previous partial for the same turn. */
	onPartialTranscript?: (text: string) => void;
}

/** Simple text turn for injection (greetings, directives, text input). */
export interface ContentTurn {
	role: 'user' | 'assistant';
	text: string;
}

/**
 * Rich replay item for reconnect/transfer recovery.
 * Preserves the full conversation structure — text, tool calls/results, files,
 * and agent transfers — so that recovery is lossless even for multimodal and
 * tool-heavy sessions.
 */
export type ReplayItem =
	| { type: 'text'; role: 'user' | 'assistant'; text: string }
	| { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
	| { type: 'tool_result'; id: string; name: string; result: unknown; error?: string }
	| { type: 'file'; role: 'user'; base64Data: string; mimeType: string }
	| { type: 'transfer'; fromAgent: string; toAgent: string };

/** Audio format specification advertised by a transport.
 *  Input and output rates / encodings may differ — e.g. Gemini: 16 kHz in /
 *  24 kHz out (both PCM); OpenAI telephony may mix `audio/pcmu` input with
 *  `audio/pcm` output for some bridges. */
export interface AudioFormatSpec {
	inputSampleRate: number;
	outputSampleRate: number;
	channels: number;
	/** Bits per sample, INPUT side. Mirror via `outputBitDepth` for the
	 *  output side when input and output differ. Single-sided value retained
	 *  for backwards compat with consumers that don't care about the split. */
	bitDepth: number;
	/** Wire encoding, INPUT side. `'pcm'` is signed 16-bit linear; `'pcmu'`
	 *  is G.711 μ-law for telephony bridges. A-law (`'pcma'`) is future work. */
	encoding: 'pcm' | 'pcmu';
	/** OUTPUT side bit depth. Defaults to `bitDepth` if omitted (single-sided).
	 *  Set explicitly when input and output encodings differ. */
	outputBitDepth?: number;
	/** OUTPUT side encoding. Defaults to `encoding` if omitted (single-sided). */
	outputEncoding?: 'pcm' | 'pcmu';
}

/** Bytes per audio sample for a given encoding. PCM16 is 2; G.711 μ-law is 1. */
export function bytesPerSample(encoding: AudioFormatSpec['encoding']): number {
	return encoding === 'pcm' ? 2 : 1;
}

/** Default sample rate for a given encoding. PCM is 24 kHz (OpenAI Realtime
 *  default); G.711 μ-law is always 8 kHz (telephony). */
export function defaultRate(encoding: AudioFormatSpec['encoding']): number {
	return encoding === 'pcm' ? 24000 : 8000;
}

/** Configuration for establishing a transport connection. */
export interface LLMTransportConfig {
	auth: TransportAuth;
	model: string;
	instructions?: string;
	tools?: ToolDefinition[];
	voice?: string;
	transcription?: { input?: boolean; output?: boolean };
	/** Response modality. Default: 'audio' (LLM-native speech).
	 *  Set to 'text' when using an external TTSProvider. */
	responseModality?: 'audio' | 'text';
	/** Provider-specific realtime input/VAD config. Gemini transport maps this to realtimeInputConfig. */
	realtimeInputConfig?: Record<string, unknown>;
	providerOptions?: Record<string, unknown>;
}

/**
 * Provider-neutral cache configuration shared across cache-aware transports.
 * Lives here for cross-transport visibility but is currently consumed only
 * by `OpenAIRealtimeCacheConfig` — Gemini Live has no in-place session
 * updates, so prefix-stability enforcement does not apply.
 */
export interface CacheConfigCommon {
	/**
	 * If true, the OpenAI transport rejects prefix-busting mutations
	 * (instructions, tools) that occur AFTER `connect()` has completed and
	 * are NOT part of a `transferSession()` call. Default: false.
	 *
	 * Pre-connect config is always allowed (initial setup never throws).
	 * Same-canonical-prefix updates do not throw — other `SessionUpdate`
	 * fields in the same call are still sent on the wire.
	 *
	 * Wired in P5 of the configurable context caching design.
	 */
	enforcePrefixStability?: boolean;

	/**
	 * Only consulted when `enforcePrefixStability` is true. Default: true
	 * (multi-agent transfers continue to work). Set false only for hardened
	 * single-agent demos that should never legitimately swap instructions.
	 */
	allowMutationOnTransfer?: boolean;
}

/** Authentication method for the transport. */
export type TransportAuth =
	| { type: 'api_key'; apiKey: string }
	| { type: 'service_account'; projectId: string; location?: string }
	| { type: 'token_provider'; getToken: () => Promise<string> };

/** Partial session update — used for updateSession() and transferSession(). */
export interface SessionUpdate {
	instructions?: string;
	tools?: ToolDefinition[];
	/** Response modality override. Used to preserve text mode across
	 *  agent transfers and reconnects when TTSProvider is configured. */
	responseModality?: 'audio' | 'text';
	/** Toggle server-side audio transcription. `input: false` disables transcription
	 *  of user audio (used when an external STT provider is the source of truth).
	 *  Implemented by both transports — OpenAI maps to `audio.input.transcription = null`,
	 *  Gemini maps to its `inputAudioTranscription` config. */
	transcription?: { input?: boolean; output?: boolean };
	providerOptions?: Record<string, unknown>;
}

/** Tool call as delivered by the transport. */
export interface TransportToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/** Tool result sent back to the transport. */
export interface TransportToolResult {
	id: string;
	name: string;
	result: unknown;
	/** Delivery scheduling hint. The transport owns actual timing.
	 *  'immediate': send result now (inline tools)
	 *  'when_idle': wait for model to finish speaking (background tools)
	 *  'interrupt': interrupt current response and deliver immediately
	 *  'silent':    send result without triggering a new response */
	scheduling?: 'immediate' | 'when_idle' | 'interrupt' | 'silent';
}

/** State provided to the transport for reconnection/recovery. */
export interface ReconnectState {
	/** Provider session handle to resume a live session when supported. */
	resumptionHandle?: string;
	/** Full conversation replay for recovery — rich typed items, not text-only. */
	conversationHistory?: ReplayItem[];
	/** In-flight tool calls to recover after reconnect. */
	pendingToolCalls?: TransportPendingToolCall[];
}

/** Snapshot of an in-flight tool call for reconnect recovery. Named TransportPendingToolCall
 *  to avoid conflict with PendingToolCall in session.ts (used for session checkpoints). */
export interface TransportPendingToolCall {
	/** Transport-assigned tool call ID (used for idempotency dedup). */
	id: string;
	/** Tool name. */
	name: string;
	/** Parsed arguments. */
	args: Record<string, unknown>;
	/** Whether the tool is still running or has completed. */
	status: 'executing' | 'completed';
	/** Result value (present only when status === 'completed'). */
	result?: unknown;
	/** When execution started (Unix ms). Used for timeout calculation on recovery. */
	startedAt: number;
	/** Max execution time in ms. Transport skips re-execution if wall-clock exceeds this. */
	timeoutMs?: number;
	/** Whether this was an inline or background tool call. */
	execution: 'inline' | 'background';
	/** Name of the agent that owned this tool call at dispatch time. */
	agentName: string;
}

/** Transport-level error with recovery signal. Named LLMTransportError to avoid
 *  collision with the TransportError class in core/errors.ts. */
export interface LLMTransportError {
	error: Error;
	recoverable: boolean;
}

/** Which realtime provider produced this usage event. */
export type RealtimeUsageProvider = 'gemini_live' | 'openai_realtime';

/** What billable slice this event describes. */
export type RealtimeUsageKind = 'response' | 'input_transcription';

/** Whether this is a mid-turn snapshot or a turn-final snapshot. */
export type RealtimeUsagePhase = 'update' | 'final';

/** Billable unit for this event (tokens vs duration-based transcription). */
export type RealtimeUsageUnit = 'tokens' | 'duration_seconds';

/** Optional per-modality token breakdown when the provider exposes it. */
export interface RealtimeUsageModalityBreakdown {
	inputTextTokens?: number;
	inputAudioTokens?: number;
	inputImageTokens?: number;
	cachedTokens?: number;
	cachedTextTokens?: number;
	cachedAudioTokens?: number;
	cachedImageTokens?: number;
	outputTextTokens?: number;
	outputAudioTokens?: number;
	/** Reasoning tokens generated internally by reasoning-capable models
	 *  (e.g. `gpt-realtime-2`). Hidden from the API — only the count is
	 *  exposed via `response.usage.output_tokens_details.reasoning_tokens`.
	 *  Billed as output tokens at the chosen modality rate. */
	reasoningTokens?: number;
}

/**
 * Normalized usage from Gemini Live or OpenAI Realtime transports.
 * Carries provider-reported billable units only (no USD estimation).
 */
export interface RealtimeLLMUsageEvent {
	provider: RealtimeUsageProvider;
	kind: RealtimeUsageKind;
	phase: RealtimeUsagePhase;
	unit: RealtimeUsageUnit;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/** Present when `unit === 'duration_seconds'` (e.g. some transcription billing). */
	durationSeconds?: number;
	modalityBreakdown?: RealtimeUsageModalityBreakdown;
	/** OpenAI response id when `kind === 'response'`. */
	providerResponseId?: string;
	/** Provider-supplied opaque id for non-response items. Currently used
	 *  for OpenAI input-audio transcription `item_id` so transcription usage
	 *  events can be aggregated independently (they have no `turnId`). */
	providerItemId?: string;
	/** Opaque provider payload for exact downstream reconciliation. */
	providerRaw?: unknown;
	/** Monotonic id of the server turn this usage belongs to. Set by transports
	 *  that model the server turn explicitly (Gemini Live external-TTS path) so
	 *  consumers can attribute usage that arrives after the framework turn ended. */
	serverTurnId?: number;
	/** True when the transport emitted this usage event while the server turn was
	 *  winding down — the framework turn had ended early (or been interrupted) but
	 *  the provider's server turn was not yet closed. A transport-phase marker:
	 *  consumers should attribute by `serverTurnId`, not assume the framework
	 *  turn already finalized. */
	serverTurnWindingDown?: boolean;
}

/**
 * Provider-agnostic interface for realtime LLM transports.
 *
 * Each provider (Gemini Live, OpenAI Realtime) implements this interface,
 * exposing static capabilities and handling provider-specific wire protocols internally.
 */
/** Options for `LLMTransport.cancelResponse`. See the method's JSDoc on
 *  `LLMTransport` for full semantics.
 *  See dev_docs/framework/design-greeting-interrupt-grace.md §2. */
export interface CancelResponseOptions {
	/** Truncate the stored assistant audio item alongside cancelling the
	 *  response. `{ audioEndMs }` provides an explicit value (floored).
	 *  `'generated'` asks the transport to use its own per-response
	 *  generated-audio counter. Omit to skip truncation entirely. */
	truncate?: { audioEndMs: number } | 'generated';
	/** When true, the returned promise resolves only after the trailing
	 *  `response.done(status:'cancelled')` (or a 2000 ms timeout). Use
	 *  before sending a new `response.create` to avoid races. */
	waitForDone?: boolean;
}

export interface LLMTransport {
	/** Static capabilities — read before connecting, used for orchestrator branching. */
	readonly capabilities: TransportCapabilities;

	// --- Lifecycle ---
	connect(config?: LLMTransportConfig): Promise<void>;
	disconnect(): Promise<void>;
	reconnect(state?: ReconnectState): Promise<void>;
	readonly isConnected: boolean;

	// --- Audio ---
	sendAudio(base64Data: string): void;
	readonly audioFormat: AudioFormatSpec;

	// --- Turn boundary control (V1: server VAD only — these are no-ops) ---
	commitAudio(): void;
	clearAudio(): void;

	// --- Framework-owned interrupt actuation (optional; required when
	//     `capabilities.frameworkOwnsInterrupt` is true) ---
	/** Cancel the in-flight response — wire-only actuation. May be called
	 *  from any framework barge-in path that has decided to interrupt.
	 *  Idempotent.
	 *
	 *  MUST NOT invoke `onInterrupted` or any other framework callback — the
	 *  caller is responsible for `finalizeTurn(interrupted)`. The
	 *  implementation only sends wire messages and updates the transport's
	 *  own state.
	 *
	 *  MUST NOT reject. Transient send failures are caught and logged
	 *  internally; the returned promise still resolves so fire-and-forget
	 *  callers cannot trigger unhandled-rejection warnings.
	 *
	 *  When `truncate.audioEndMs` is supplied and the transport tracks an
	 *  active assistant audio item, it also sends a per-provider truncate
	 *  (OpenAI: `conversation.item.truncate`). `truncate: 'generated'` asks
	 *  the transport to compute `audioEndMs` from its own per-response
	 *  generated-audio counter (e.g. OpenAI's `audioOutputMs`); transports
	 *  without such a counter ignore the sentinel. Omitting `truncate` only
	 *  skips truncation — `cancelResponse` still stops generation if a
	 *  response is in flight.
	 *
	 *  When `waitForDone` is true, the returned promise resolves only after
	 *  the trailing `response.done(status:'cancelled')` arrives from the
	 *  provider (or a 2000 ms timeout, whichever comes first). Use this
	 *  before sending a new `response.create` so cancel and create cannot
	 *  race. Default `false`. */
	cancelResponse?(opts?: CancelResponseOptions): Promise<void>;

	/** Clear the provider's pending input-audio buffer (OpenAI Realtime:
	 *  `input_audio_buffer.clear`). Optional — Gemini and other transports
	 *  without a server-side append-then-commit input buffer omit this.
	 *  Called by `VoiceSession` at grace-window arming to discard any
	 *  pre-arming echo residue; safe to call when the buffer is empty.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md §8. */
	clearInputAudio?(): void;

	// --- Quiesce / unquiesce (optional; advertised via capabilities.quiescible) ---
	/** Pause the transport without disconnecting:
	 *   1. Cancel any in-flight model response (provider chooses how).
	 *   2. Suppress onAudioOutput deltas until unquiesce() is called.
	 *   3. Leave the WebSocket open and conversation state intact.
	 *
	 *  Idempotent. Used by VoiceSession to transition into transcription mode
	 *  without tearing the transport down. When omitted, VoiceSession falls
	 *  back to its framework-layer audio-output guard. */
	quiesce?(): Promise<void>;

	/** Resume normal operation after quiesce(). After this resolves,
	 *  onAudioOutput fires again on the next response. Idempotent. */
	unquiesce?(): Promise<void>;

	// --- Session configuration ---
	/** Apply a session update.
	 *  Pre-connect: state-only mutation; coalesces with prior pre-connect calls
	 *  and resolves immediately. The merged config is sent in the single
	 *  `session.update` issued at connect time.
	 *  Post-connect: serialized via the transport's internal FIFO queue; each
	 *  call produces one wire `session.update` and awaits its ack. */
	updateSession(config: SessionUpdate): Promise<void>;

	// --- Agent transfer (transport decides: in-place vs reconnect) ---
	transferSession(config: SessionUpdate, state?: ReconnectState): Promise<void>;

	// --- Content injection (greetings, directives, text input — NOT replay) ---
	sendContent(turns: ContentTurn[], turnComplete?: boolean): void;

	// --- File/image injection ---
	sendFile(base64Data: string, mimeType: string): void;

	// --- Tool interaction ---
	sendToolResult(result: TransportToolResult): void;

	// --- Generation control (non-tool-result generation) ---
	/** Trigger a model response.
	 *  @param instructions Optional one-off instruction (passed as
	 *    `response.create.response.instructions` on OpenAI — does not mutate
	 *    the session prefix, so it is cache-safe for subsequent turns).
	 *  @param overrides Optional per-response overrides. `reasoning.effort`
	 *    bumps the dial for this Response only (resets to session default
	 *    on the next turn). Only honored by transports advertising
	 *    `capabilities.reasoningEffort`. */
	triggerGeneration(
		instructions?: string,
		overrides?: { reasoning?: { effort: ReasoningEffort } },
	): void;

	/** Best-effort re-elicit of a model response from existing/restored context,
	 *  without injecting new content. Used after a watchdog-driven reconnect to
	 *  recover a turn the model silently dropped. Optional — transports that
	 *  auto-generate (or cannot elicit without content) may omit it; callers fall
	 *  back to `triggerGeneration()`. Gemini implements it as a content-less
	 *  `turnComplete`. */
	elicitResponse?(): void;

	// --- Turn correlation (optional) ---
	/** The transport's currently-active server-turn id, or `undefined` when no
	 *  server turn is active (idle/closed) or the transport does not model
	 *  server turns. Read synchronously from a model-output callback to bind the
	 *  framework `Turn` to the server turn at birth. Active-only by contract:
	 *  it must NOT return a stale id between turns. */
	getActiveServerTurnId?(): number | undefined;

	// --- Core callbacks (all providers must support) ---
	onAudioOutput?: (base64Data: string) => void;
	onToolCall?: (calls: TransportToolCall[]) => void;
	onToolCallCancel?: (ids: string[]) => void;
	/** @param serverTurnId Monotonic id of the server turn that completed, when
	 *  the transport models server turns explicitly (Gemini external-TTS path).
	 *  Consumers dedupe finalization by this id. `undefined` for transports that
	 *  do not track server turns. */
	onTurnComplete?: (serverTurnId?: number) => void;
	/** @param serverTurnId Monotonic id of the server turn being interrupted
	 *  (see `onTurnComplete`). `undefined` for transports without server turns. */
	onInterrupted?: (serverTurnId?: number) => void;
	onInputTranscription?: (text: string) => void;
	onOutputTranscription?: (text: string) => void;
	onSessionReady?: (sessionId: string) => void;
	onError?: (error: LLMTransportError) => void;
	onClose?: (code?: number, reason?: string) => void;

	// --- Turn lifecycle callbacks ---
	/** Fires when the model begins any response (audio, tool call, etc.).
	 *  Used by VoiceSession to trigger STT provider commit. */
	onModelTurnStart?: () => void;

	// --- Text-mode callbacks (active when responseModality is 'text') ---
	/** Fires when the model produces text output (text-mode responses).
	 *  Only active when responseModality is 'text' (i.e., external TTS in use).
	 *  @param text Incremental text chunk (may be partial word/sentence) */
	onTextOutput?: (text: string) => void;

	/** Fires when the model's text response is complete for this turn.
	 *  Signals that all text for the current response has been delivered.
	 *  Ordering contract: fires after all onTextOutput, before onTurnComplete. */
	onTextDone?: () => void;

	/** Fires when the transport detects user speech via VAD.
	 *  Used for TTS-level barge-in when the LLM is idle but TTS is still playing.
	 *  OpenAI: wired to input_audio_buffer.speech_started.
	 *  Gemini: may require custom VAD signal — needs empirical testing. */
	onSpeechStarted?: () => void;

	// --- Optional capability callbacks (only fired by supporting transports) ---
	onGoAway?: (timeLeft: string) => void;
	onResumptionUpdate?: (handle: string, resumable: boolean) => void;
	onGroundingMetadata?: (metadata: Record<string, unknown>) => void;

	/** Optional: fires when the provider reports token or duration usage for billing/observability. */
	onRealtimeLLMUsage?: (usage: RealtimeLLMUsageEvent) => void;

	// --- Reasoning lifecycle (reasoning-capable models only) ---
	/** Fires when the model begins emitting its hidden reasoning trace
	 *  for the current response. Useful for latency observability. */
	onReasoningStart?: () => void;

	/** Fires when the model's reasoning step completes for the current
	 *  response, before any audio/text answer is emitted. `durationMs`
	 *  is the wall-clock time the reasoning step took; `reasoningTokens`
	 *  is the count if the provider exposes it (otherwise undefined). */
	onReasoningDone?: (info: { durationMs: number; reasoningTokens?: number }) => void;

	/** Fires with a streamed chunk of the optional reasoning summary text
	 *  (when the model was configured to emit one). Surface this to ops
	 *  telemetry only — never to end users. */
	onReasoningSummary?: (text: string) => void;

	// --- Prompt-cache observability ---
	/** Fires immediately before the framework emits a `session.update` that
	 *  changes `instructions` or `tools` — i.e. before a guaranteed full
	 *  prompt-cache bust on the next response. Pure telemetry. */
	onCacheBust?: (reason: 'instructions_changed' | 'tools_changed') => void;
}
