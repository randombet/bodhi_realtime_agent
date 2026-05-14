// SPDX-License-Identifier: MIT

import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type {
	RealtimeClientEvent,
	RealtimeSessionCreateRequest,
} from 'openai/resources/realtime/realtime';
import type { ToolDefinition } from '../types/tool.js';
import type {
	AudioFormatSpec,
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
export interface OpenAIRealtimeConfig {
	/** OpenAI API key. */
	apiKey: string;
	/** Model identifier (default: 'gpt-realtime-2'). */
	model?: OpenAIRealtimeModel;
	/** Voice name (default: 'coral'). */
	voice?: string;
	/** Transcription model (default: 'gpt-4o-mini-transcribe'). Set to null to disable input transcription. */
	transcriptionModel?: string | null;
	/** Turn detection configuration. */
	turnDetection?: Record<string, unknown>;
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

	// Audio suppression: stop forwarding audio deltas after interruption
	private _suppressAudio = false;

	constructor(config: OpenAIRealtimeConfig) {
		this.config = config;
		this.client = new OpenAI({ apiKey: config.apiKey });
		this.voice = config.voice ?? 'coral';
		this._capabilities = this.resolveCapabilities();
		this._audioFormat = this.resolveAudioFormat();
	}

	/** Compute capability flags from the configured model. */
	private resolveCapabilities(): TransportCapabilities {
		const model = this.config.model ?? 'gpt-realtime-2';
		return {
			...this.staticCapabilities,
			parallelToolCalls: supports(model, 'parallelToolCalls'),
			reasoningEffort: supports(model, 'reasoning'),
			// gpt-realtime-2 emits automatic preambles; gating on reasoning is the
			// proxy because the two ship together on the same model line.
			automaticPreambles: supports(model, 'reasoning'),
			quiescible: true,
		};
	}

	/** Compute the wire audio format from `audioInputFormat` / `audioOutputFormat`. */
	private resolveAudioFormat(): AudioFormatSpec {
		const inFmt = this.config.audioInputFormat ?? { type: 'audio/pcm', rate: 24000 };
		const outFmt = this.config.audioOutputFormat ?? { type: 'audio/pcm', rate: 24000 };
		const inEnc: 'pcm' | 'pcmu' = inFmt.type === 'audio/pcmu' ? 'pcmu' : 'pcm';
		const outEnc: 'pcm' | 'pcmu' = outFmt.type === 'audio/pcmu' ? 'pcmu' : 'pcm';
		const inRate = inEnc === 'pcmu' ? 8000 : (inFmt.rate ?? 24000);
		const outRate = outEnc === 'pcmu' ? 8000 : (outFmt.rate ?? 24000);
		// Input and output may differ in rate but for OpenAI Realtime today they
		// match. We carry both because AudioFormatSpec requires it.
		return {
			inputSampleRate: inRate,
			outputSampleRate: outRate,
			channels: 1,
			bitDepth: inEnc === 'pcmu' ? 8 : 16,
			// AudioFormatSpec.encoding is single-valued; we expose the input encoding
			// because that's what consumers (telephony bridge, STT providers) drive
			// off. Output encoding for transport-emitted audio is decoded by the
			// telephony bridge using audioOutputFormat directly if needed.
			encoding: inEnc,
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

		const updatedPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('session.update timeout')), 15_000);
			this.rt?.once('session.updated', () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.rtSend({ type: 'session.update', session: sessionConfig });
		await updatedPromise;

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

	// --- Session configuration ---

	updateSession(config: SessionUpdate): void {
		if (config.instructions !== undefined) {
			this.instructions = config.instructions;
		}
		if (config.tools !== undefined) {
			this.tools = config.tools;
		}
		if (config.responseModality !== undefined) {
			this._textMode = config.responseModality === 'text';
		}

		if (!this.rt || !this._isConnected) return;

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

		this.rtSend({ type: 'session.update', session: update as RealtimeSessionCreateRequest });
	}

	// --- Agent transfer (in-place via session.update — no reconnect needed) ---

	async transferSession(config: SessionUpdate, _state?: ReconnectState): Promise<void> {
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

		// Wait for session.updated confirmation
		const updatedPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('transferSession timeout')), 10_000);
			this.rt?.once('session.updated', () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.rtSend({ type: 'session.update', session: update as RealtimeSessionCreateRequest });
		await updatedPromise;
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

		// 'interrupt': cancel in-flight response before delivering
		if (scheduling === 'interrupt' && this._isModelGenerating) {
			this.rt.send({ type: 'response.cancel' });
			this._isModelGenerating = false;
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
			this.client = new OpenAI({ apiKey: config.auth.apiKey });
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
				throw new Error(
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
			throw new Error(`UNSUPPORTED_FEATURE: ${msg}`);
		}
		// Intentional warn-on-drop in non-strict mode — surfaces the silent
		// feature drop to ops without crashing user code.
		console.warn(msg);
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
					turn_detection: (this.config.turnDetection ?? {
						type: 'semantic_vad',
						eagerness: 'medium',
						create_response: true,
						interrupt_response: true,
						// biome-ignore lint/suspicious/noExplicitAny: turn detection config passed through from user; SDK type is strict union
					}) as any,
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

		return session;
	}

	private wireEventListeners(): void {
		if (!this.rt) return;
		const rt = this.rt;

		// --- Audio output ---
		rt.on('response.output_audio.delta', (event) => {
			if (this._suppressAudio) return;
			if (this.onAudioOutput) this.onAudioOutput(event.delta);

			// Track audio duration for interruption handling. Uses the resolved
			// audioFormat so G.711 telephony (1 byte/sample, 8 kHz) computes
			// the right `audio_end_ms` for conversation.item.truncate.
			const bytes = Buffer.from(event.delta, 'base64').length;
			const bps = this._audioFormat.bitDepth === 8 ? 1 : 2;
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
			this._suppressAudio = false;
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
			const e = event as { response?: { id?: string; usage?: unknown } };
			const normalized = normalizeOpenAIResponseUsage(e?.response?.usage, e?.response?.id);
			if (normalized) {
				// Capture reasoning-token count if exposed; useful for the
				// next onReasoningDone call if the model fires another reasoning
				// item in a subsequent response.
				this._reasoningTokensThisResponse = normalized.modalityBreakdown?.reasoningTokens;
				if (this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(normalized);
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

		// --- Interruption handling (server VAD mode) ---
		// In server VAD mode (when speech_started fires), the server automatically
		// cancels any in-flight response and sends response.done (status: cancelled).
		// We only need to truncate the audio item to what the user actually heard.
		// Sending response.cancel here would race with the server's own cancellation
		// and produce "no active response found" errors.
		rt.on('input_audio_buffer.speech_started', () => {
			// Always fire onSpeechStarted — TTS barge-in needs this even when LLM is idle
			if (this.onSpeechStarted) this.onSpeechStarted();

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
			const e = event as { transcript?: string; usage?: unknown };
			if (this.onInputTranscription) this.onInputTranscription(e.transcript ?? '');
			const tu = normalizeOpenAITranscriptionUsage(e.usage);
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
			if (this.onClose) this.onClose(code, reason.toString());
		});
	}

	/** Flush any tool results queued with 'when_idle' scheduling. */
	private flushPendingWhenIdle(): void {
		if (!this.rt || this._pendingWhenIdle.length === 0) return;
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

	private replayHistory(items: ReplayItem[]): void {
		if (!this.rt) return;
		const rt = this.rt;

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
