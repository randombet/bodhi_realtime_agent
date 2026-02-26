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
		sampleRate: 24000,
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
	private pendingFunctionCalls = new Map<string, { name: string; buffer: string }>();

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

		// Create WebSocket connection using the openai SDK
		this.rt = await OpenAIRealtimeWS.create(this.client, { model });
		this._isConnected = true;

		// Wire event listeners
		this.wireEventListeners();

		// Build session configuration
		const sessionConfig = this.buildSessionConfig();

		// Wait for session.updated confirmation after sending session.update
		const updatedPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('session.update timeout')), 15_000);
			this.rt?.on('session.updated', () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.rtSend({ type: 'session.update', session: sessionConfig });
		await updatedPromise;
	}

	async disconnect(): Promise<void> {
		this._isConnected = false;
		this.pendingFunctionCalls.clear();
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

		// Replay conversation history as conversation items
		if (state?.conversationHistory?.length) {
			this.replayHistory(state.conversationHistory);
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
			this.rt?.on('session.updated', () => {
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

		// Step 1: Send the tool output as a conversation item
		this.rt.send({
			type: 'conversation.item.create',
			item: {
				type: 'function_call_output',
				call_id: result.id,
				output: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
			},
		});

		// Step 2: Explicitly trigger response generation
		// OpenAI requires manual response.create after tool results (unlike Gemini's auto-response).
		// For 'silent' scheduling, skip the response trigger.
		if (result.scheduling !== 'silent') {
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
	}

	private buildSessionConfig(): RealtimeSessionCreateRequest {
		const session: RealtimeSessionCreateRequest = {
			type: 'realtime',
			audio: {
				input: {
					format: { type: 'audio/pcm', rate: 24000 },
					transcription: { model: 'gpt-4o-transcribe' },
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
			if (this.onAudioOutput) this.onAudioOutput(event.delta);

			// Track audio duration for interruption handling
			const bytes = Buffer.from(event.delta, 'base64').length;
			const samples = bytes / 2; // 16-bit = 2 bytes per sample
			this.audioOutputMs += (samples / 24000) * 1000;
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

		// --- Tool call argument streaming ---
		rt.on('response.function_call_arguments.delta', (event) => {
			const pending = this.pendingFunctionCalls.get(event.item_id) ?? {
				name: '',
				buffer: '',
			};
			pending.buffer += event.delta;
			this.pendingFunctionCalls.set(event.item_id, pending);
		});

		// --- Tool call complete (fires onToolCall) ---
		rt.on('response.output_item.done', (event) => {
			const item = event.item;
			if (item.type === 'function_call') {
				if (item.id) this.pendingFunctionCalls.delete(item.id);
				const args = item.arguments ? JSON.parse(item.arguments) : {};
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

		// --- Turn complete ---
		rt.on('response.done', () => {
			if (this.onTurnComplete) this.onTurnComplete();
		});

		// --- Interruption handling (client-managed) ---
		rt.on('input_audio_buffer.speech_started', () => {
			// Truncate assistant's message to what user actually heard
			if (this.lastAssistantItemId) {
				rt.send({
					type: 'conversation.item.truncate',
					item_id: this.lastAssistantItemId,
					content_index: 0,
					audio_end_ms: Math.floor(this.audioOutputMs),
				});
			}
			rt.send({ type: 'response.cancel' });
			if (this.onInterrupted) this.onInterrupted();
		});

		// --- Input transcription ---
		rt.on('conversation.item.input_audio_transcription.completed', (event) => {
			if (this.onInputTranscription) this.onInputTranscription(event.transcript);
		});

		// --- Output transcription ---
		rt.on('response.output_audio_transcript.done', (event) => {
			if (this.onOutputTranscription) this.onOutputTranscription(event.transcript);
		});

		// --- Session created (fires onSessionReady) ---
		rt.on('session.created', (event) => {
			// The API returns session.id at runtime but SDK types model session as RealtimeSessionCreateRequest
			// biome-ignore lint/suspicious/noExplicitAny: SDK type gap — runtime event includes session id
			const sessionId = (event.session as any)?.id ?? 'unknown';
			if (this.onSessionReady) this.onSessionReady(sessionId);
		});

		// --- Error handling ---
		rt.on('error', (error) => {
			if (this.onError) {
				this.onError({
					error: error instanceof Error ? error : new Error(String(error)),
					recoverable: true,
				});
			}
		});

		// --- Connection close (via raw WebSocket, not the typed emitter) ---
		rt.socket.on('close', (code: number, reason: Buffer) => {
			this._isConnected = false;
			if (this.onClose) this.onClose(code, reason.toString());
		});
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
