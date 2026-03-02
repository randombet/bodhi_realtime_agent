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
	ReconnectState,
	ReplayItem,
	SessionUpdate,
	TransportCapabilities,
	TransportToolCall,
	TransportToolResult,
} from '../types/transport.js';
import { zodToJsonSchema } from './zod-to-schema.js';

/** Configuration for constructing an OpenAIRealtimeTransport. */
export interface OpenAIRealtimeConfig {
	/** OpenAI API key. */
	apiKey: string;
	/** Model identifier (default: 'gpt-realtime'). */
	model?: string;
	/** Voice name (default: 'coral'). */
	voice?: string;
	/** Transcription model (default: 'gpt-4o-mini-transcribe'). Set to null to disable input transcription. */
	transcriptionModel?: string | null;
	/** Turn detection configuration. */
	turnDetection?: Record<string, unknown>;
	/** Noise reduction configuration. */
	noiseReduction?: Record<string, unknown>;
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
	readonly capabilities: TransportCapabilities = {
		messageTruncation: true,
		turnDetection: true,
		userTranscription: true,
		inPlaceSessionUpdate: true,
		sessionResumption: false,
		contextCompression: false,
		groundingMetadata: false,
	};

	readonly audioFormat: AudioFormatSpec = {
		inputSampleRate: 24000,
		outputSampleRate: 24000,
		channels: 1,
		bitDepth: 16,
		encoding: 'pcm',
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

	// when_idle scheduling: buffer tool results while model is generating
	private _isModelGenerating = false;
	private _pendingWhenIdle: TransportToolResult[] = [];

	// Audio suppression: stop forwarding audio deltas after interruption
	private _suppressAudio = false;

	constructor(config: OpenAIRealtimeConfig) {
		this.config = config;
		this.client = new OpenAI({ apiKey: config.apiKey });
		this.voice = config.voice ?? 'coral';
	}

	get isConnected(): boolean {
		return this._isConnected;
	}

	// --- Lifecycle ---

	async connect(transportConfig?: LLMTransportConfig): Promise<void> {
		if (transportConfig) {
			this.applyTransportConfig(transportConfig);
		}

		const model = this.config.model ?? 'gpt-realtime';

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

		if (!this.rt || !this._isConnected) return;

		const update: Partial<RealtimeSessionCreateRequest> = {};
		if (config.instructions !== undefined) {
			update.instructions = config.instructions;
		}
		if (config.tools !== undefined) {
			// biome-ignore lint/suspicious/noExplicitAny: SDK tools type is complex; our tool format is compatible at runtime
			update.tools = config.tools.map(toolToOpenAIFunction) as any;
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

	triggerGeneration(instructions?: string): void {
		if (!this.rt || !this._isConnected) return;

		if (instructions) {
			this.rt.send({
				type: 'response.create',
				response: { instructions },
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
	}

	private buildSessionConfig(): RealtimeSessionCreateRequest {
		const session: RealtimeSessionCreateRequest = {
			type: 'realtime',
			audio: {
				input: {
					format: { type: 'audio/pcm', rate: 24000 },
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
				output: {
					format: { type: 'audio/pcm', rate: 24000 },
					voice: this.voice,
				},
			},
		};

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

			// Track audio duration for interruption handling
			const bytes = Buffer.from(event.delta, 'base64').length;
			const samples = bytes / 2; // 16-bit = 2 bytes per sample
			this.audioOutputMs += (samples / 24000) * 1000;
		});

		// --- Response lifecycle: track when a response is active ---
		rt.on('response.created', () => {
			this._isModelGenerating = true;
			this._suppressAudio = false;
			if (this.onModelTurnStart) this.onModelTurnStart();
		});

		// --- Track assistant output items for interruption ---
		rt.on('response.output_item.added', (event) => {
			// ConversationItem is a union; only messages have role
			const item = event.item;
			if ('role' in item && item.role === 'assistant' && item.id) {
				this.lastAssistantItemId = item.id;
				this.audioOutputMs = 0;
			}
		});

		// --- Tool call argument streaming (accumulate per item_id) ---
		rt.on('response.function_call_arguments.delta', (event) => {
			const buffer = this.pendingFunctionCalls.get(event.item_id) ?? '';
			this.pendingFunctionCalls.set(event.item_id, buffer + event.delta);
		});

		// --- Tool call complete (fires onToolCall) ---
		rt.on('response.output_item.done', (event) => {
			const item = event.item;
			if (item.type === 'function_call') {
				// Prefer accumulated buffer (built from streamed deltas).
				// Fall back to item.arguments from the done event.
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
				if (this.onToolCall) {
					this.onToolCall([
						{
							id: item.call_id ?? item.id ?? '',
							name: item.name ?? '',
							args,
						},
					]);
				}
			}
		});

		// --- Turn complete: clear generating state, flush when_idle queue ---
		rt.on('response.done', () => {
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
		rt.on('conversation.item.input_audio_transcription.completed', (event) => {
			if (this.onInputTranscription) this.onInputTranscription(event.transcript);
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
