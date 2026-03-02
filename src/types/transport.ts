// SPDX-License-Identifier: MIT

import type { ToolDefinition } from './tool.js';

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
}

/** Audio format descriptor passed to an STT provider at configuration time. */
export interface STTAudioConfig {
	/** Sample rate in Hz (e.g. 16000 for Gemini, 24000 for OpenAI). */
	sampleRate: number;
	/** Bits per sample (16). */
	bitDepth: number;
	/** Number of channels (1 = mono). */
	channels: number;
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
 *  Input and output rates may differ (e.g. Gemini: 16kHz in / 24kHz out). */
export interface AudioFormatSpec {
	inputSampleRate: number;
	outputSampleRate: number;
	channels: number;
	bitDepth: number;
	encoding: 'pcm';
}

/** Configuration for establishing a transport connection. */
export interface LLMTransportConfig {
	auth: TransportAuth;
	model: string;
	instructions?: string;
	tools?: ToolDefinition[];
	voice?: string;
	transcription?: { input?: boolean; output?: boolean };
	providerOptions?: Record<string, unknown>;
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

/**
 * Provider-agnostic interface for realtime LLM transports.
 *
 * Each provider (Gemini Live, OpenAI Realtime) implements this interface,
 * exposing static capabilities and handling provider-specific wire protocols internally.
 */
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

	// --- Session configuration ---
	updateSession(config: SessionUpdate): void;

	// --- Agent transfer (transport decides: in-place vs reconnect) ---
	transferSession(config: SessionUpdate, state?: ReconnectState): Promise<void>;

	// --- Content injection (greetings, directives, text input — NOT replay) ---
	sendContent(turns: ContentTurn[], turnComplete?: boolean): void;

	// --- File/image injection ---
	sendFile(base64Data: string, mimeType: string): void;

	// --- Tool interaction ---
	sendToolResult(result: TransportToolResult): void;

	// --- Generation control (non-tool-result generation) ---
	triggerGeneration(instructions?: string): void;

	// --- Core callbacks (all providers must support) ---
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

	// --- Turn lifecycle callbacks ---
	/** Fires when the model begins any response (audio, tool call, etc.).
	 *  Used by VoiceSession to trigger STT provider commit. */
	onModelTurnStart?: () => void;

	// --- Optional capability callbacks (only fired by supporting transports) ---
	onGoAway?: (timeLeft: string) => void;
	onResumptionUpdate?: (handle: string, resumable: boolean) => void;
	onGroundingMetadata?: (metadata: Record<string, unknown>) => void;
}
