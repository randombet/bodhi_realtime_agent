// SPDX-License-Identifier: MIT

import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_RECONNECT_TIMEOUT_MS } from '../core/constants.js';
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

/** Configuration for connecting to the Gemini Live API. */
export interface GeminiTransportConfig {
	/** Google API key for authentication. */
	apiKey: string;
	/** Gemini model name (default: "gemini-live-2.5-flash-preview"). */
	model?: string;
	/** System instruction sent to the model at connection time. */
	systemInstruction?: string;
	/** Tool definitions to register with the model (converted to Gemini function declarations). */
	tools?: ToolDefinition[];
	/** Opaque handle from a previous session, used to resume an existing Gemini session. */
	resumptionHandle?: string;
	/** Voice configuration for Gemini's speech synthesis. */
	speechConfig?: { voiceName?: string };
	/** Context window compression settings (trigger and target token counts). */
	compressionConfig?: { triggerTokens: number; targetTokens: number };
	/** Enable Gemini's built-in Google Search grounding. */
	googleSearch?: boolean;
	/** Enable server-side transcription of user audio input (default: true). */
	inputAudioTranscription?: boolean;
	/** Separate model for user input STT (e.g. "gemini-3-flash-preview").
	 *  When set, disables built-in inputAudioTranscription and uses this model instead. */
	sttModel?: string;
	/** Timeout in ms for connect() to receive setupComplete (default: 30000). */
	connectTimeoutMs?: number;
	/** Timeout in ms for the overall reconnect operation (default: 45000). */
	reconnectTimeoutMs?: number;
}

/** Callbacks fired by GeminiLiveTransport when server messages arrive. */
export interface GeminiTransportCallbacks {
	/** Gemini session setup is complete and ready for audio. */
	onSetupComplete?(sessionId: string): void;
	/** Base64-encoded PCM audio output from the model. */
	onAudioOutput?(data: string): void;
	/** Model is requesting one or more tool invocations. */
	onToolCall?(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): void;
	/** Model is cancelling previously requested tool calls. */
	onToolCallCancellation?(ids: string[]): void;
	/** Model has finished its response turn. */
	onTurnComplete?(): void;
	/** Model's response was interrupted by user speech. */
	onInterrupted?(): void;
	/** Transcription of user's spoken input. */
	onInputTranscription?(text: string): void;
	/** Transcription of model's spoken output. */
	onOutputTranscription?(text: string): void;
	/** Server is shutting down — reconnect before timeLeft expires. */
	onGoAway?(timeLeft: string): void;
	/** New session resumption handle available. */
	onResumptionUpdate?(handle: string, resumable: boolean): void;
	/** Grounding metadata from Google Search results. */
	onGroundingMetadata?(metadata: Record<string, unknown>): void;
	/** Transport-level error. */
	onError?(error: Error): void;
	/** WebSocket connection closed. */
	onClose?(code?: number, reason?: string): void;
}

/**
 * WebSocket transport layer for the Gemini Live API.
 *
 * Wraps the `@google/genai` SDK's live.connect() to manage the bidirectional
 * audio stream. Handles connection setup, message routing, tool declaration
 * conversion (Zod → JSON Schema), and session resumption.
 *
 * Implements `LLMTransport` for provider-agnostic usage. The constructor
 * callback pattern is preserved for backward compatibility alongside the
 * LLMTransport callback properties.
 */
export class GeminiLiveTransport implements LLMTransport {
	private session: Session | null = null;
	private ai: GoogleGenAI;
	private callbacks: GeminiTransportCallbacks;
	private config: GeminiTransportConfig;
	/** Resolves when setupComplete fires — used to make connect() await Gemini readiness. */
	private setupResolver: (() => void) | null = null;
	/** Buffered user audio chunks for separate-model STT (base64 PCM). */
	private _audioChunks: string[] = [];
	/** Tracks whether the current turn was interrupted (to skip buffer clearing on turnComplete). */
	private _wasInterrupted = false;

	// --- LLMTransport static properties ---

	readonly capabilities: TransportCapabilities = {
		messageTruncation: false,
		turnDetection: true,
		userTranscription: true,
		inPlaceSessionUpdate: false,
		sessionResumption: true,
		contextCompression: true,
		groundingMetadata: true,
	};

	readonly audioFormat: AudioFormatSpec = {
		inputSampleRate: 16000,
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
	onGoAway?: (timeLeft: string) => void;
	onResumptionUpdate?: (handle: string, resumable: boolean) => void;
	onGroundingMetadata?: (metadata: Record<string, unknown>) => void;

	constructor(config: GeminiTransportConfig, callbacks: GeminiTransportCallbacks) {
		this.ai = new GoogleGenAI({ apiKey: config.apiKey });
		this.config = config;
		this.callbacks = callbacks;
	}

	/** Establish a WebSocket connection to the Gemini Live API.
	 *  Resolves only after Gemini sends `setupComplete`, so callers can safely
	 *  send content immediately after awaiting this method.
	 *
	 *  Also satisfies `LLMTransport.connect(config)` — if config is provided,
	 *  it is applied before connecting.
	 */
	async connect(transportConfig?: LLMTransportConfig): Promise<void> {
		if (transportConfig) {
			this.applyTransportConfig(transportConfig);
		}

		const setupComplete = new Promise<void>((resolve) => {
			this.setupResolver = resolve;
		});

		const model = this.config.model ?? 'gemini-live-2.5-flash-preview';

		const connectConfig: Record<string, unknown> = {
			responseModalities: ['AUDIO'],
			outputAudioTranscription: {},
		};

		if (this.config.inputAudioTranscription !== false && !this.config.sttModel) {
			connectConfig.inputAudioTranscription = {};
		}

		if (this.config.systemInstruction) {
			connectConfig.systemInstruction = this.config.systemInstruction;
		}

		const toolEntries: Record<string, unknown>[] = [];
		if (this.config.googleSearch) {
			toolEntries.push({ googleSearch: {} });
		}
		if (this.config.tools?.length) {
			toolEntries.push({ functionDeclarations: this.config.tools.map(toolToDeclaration) });
		}
		if (toolEntries.length > 0) {
			connectConfig.tools = toolEntries;
		}

		if (this.config.resumptionHandle) {
			connectConfig.sessionResumption = { handle: this.config.resumptionHandle };
		} else {
			connectConfig.sessionResumption = {};
		}

		if (this.config.speechConfig?.voiceName) {
			connectConfig.speechConfig = {
				voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.speechConfig.voiceName } },
			};
		}

		if (this.config.compressionConfig) {
			connectConfig.contextWindowCompression = {
				triggerTokens: this.config.compressionConfig.triggerTokens,
				slidingWindow: { targetTokens: this.config.compressionConfig.targetTokens },
			};
		}

		this.session = await this.ai.live.connect({
			model,
			config: connectConfig,
			callbacks: {
				onopen: () => {},
				onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
				onerror: (e: { message?: string }) => {
					const error = new Error(e.message ?? 'WebSocket error');
					this.callbacks.onError?.(error);
					if (this.onError) this.onError({ error, recoverable: true });
				},
				onclose: (e: { code?: number; reason?: string }) => {
					const code = e?.code;
					const reason = e?.reason;
					this.callbacks.onClose?.(code, reason);
					if (this.onClose) this.onClose(code, reason);
				},
			},
		});

		const timeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Gemini connect timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		});
		await Promise.race([setupComplete, timeout]).finally(() => clearTimeout(timer));
	}

	/** Disconnect and reconnect, optionally with a new resumption handle or ReconnectState.
	 *  Accepts either a string handle (legacy API) or ReconnectState (LLMTransport API).
	 */
	async reconnect(stateOrHandle?: ReconnectState | string): Promise<void> {
		const timeoutMs = this.config.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			// Force-kill the stale session so disconnect() unblocks
			this.session = null;
		}, timeoutMs);

		try {
			await this.disconnect();

			// Accept either a handle string (legacy) or ReconnectState (LLMTransport)
			if (typeof stateOrHandle === 'string') {
				this.config.resumptionHandle = stateOrHandle;
			}
			// When ReconnectState, the internal resumption handle is already stored
			// from onResumptionUpdate. conversationHistory replay happens after reconnect.

			await this.connect();

			// If ReconnectState with conversation history, replay it
			if (typeof stateOrHandle === 'object' && stateOrHandle?.conversationHistory?.length) {
				this.replayHistory(stateOrHandle.conversationHistory);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	async disconnect(): Promise<void> {
		this._audioChunks = [];
		this._wasInterrupted = false;
		if (this.session) {
			try {
				await this.session.close();
			} catch {
				// Ignore close errors
			}
			this.session = null;
		}
	}

	/** Send base64-encoded PCM audio to Gemini as realtime input. */
	sendAudio(base64Data: string): void {
		if (!this.session) return;
		if (this.config.sttModel) {
			this._audioChunks.push(base64Data);
		}
		this.session.sendRealtimeInput({
			media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
		});
	}

	/** Send tool execution results back to Gemini (legacy API). */
	sendToolResponse(
		responses: Array<{ id?: string; name?: string; response?: Record<string, unknown> }>,
		_scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT',
	): void {
		if (!this.session) return;
		this.session.sendToolResponse({ functionResponses: responses });
	}

	/** Send text-based conversation turns to Gemini (legacy API, used for context replay). */
	sendClientContent(
		turns: Array<{ role: string; parts: Array<{ text: string }> }>,
		turnComplete = true,
	): void {
		if (!this.session) return;
		this.session.sendClientContent({ turns, turnComplete });
	}

	/** Update the tool declarations (applied on next reconnect). */
	updateTools(tools: ToolDefinition[]): void {
		this.config.tools = tools;
	}

	/** Update the system instruction (applied on next reconnect). */
	updateSystemInstruction(instruction: string): void {
		this.config.systemInstruction = instruction;
	}

	/** Update Google Search grounding flag (applied on next reconnect). */
	updateGoogleSearch(enabled: boolean): void {
		this.config.googleSearch = enabled;
	}

	get isConnected(): boolean {
		return this.session !== null;
	}

	// --- LLMTransport methods ---

	/** Send provider-neutral content turns to Gemini. Converts ContentTurn to Gemini format. */
	sendContent(turns: ContentTurn[], turnComplete = true): void {
		if (!this.session) return;
		const geminiTurns = turns.map((t) => ({
			role: t.role === 'assistant' ? 'model' : t.role,
			parts: [{ text: t.text }],
		}));
		this.session.sendClientContent({ turns: geminiTurns, turnComplete });
	}

	/** Send a file/image to Gemini as inline data. */
	sendFile(base64Data: string, mimeType: string): void {
		if (!this.session) return;
		this.session.sendClientContent({
			turns: [{ role: 'user', parts: [{ inlineData: { data: base64Data, mimeType } }] as never[] }],
			turnComplete: false,
		});
	}

	/** Send a tool result back to Gemini (LLMTransport API). */
	sendToolResult(result: TransportToolResult): void {
		if (!this.session) return;
		this.session.sendToolResponse({
			functionResponses: [
				{ id: result.id, name: result.name, response: result.result as Record<string, unknown> },
			],
		});
	}

	/** No-op for Gemini — generation is automatic after tool results and content injection. */
	triggerGeneration(_instructions?: string): void {
		// Gemini auto-generates after sendToolResponse and sendClientContent
	}

	/** No-op for V1 — server VAD only. */
	commitAudio(): void {}

	/** No-op for V1 — server VAD only. */
	clearAudio(): void {}

	/** Update session configuration (applied on next reconnect for Gemini). */
	updateSession(config: SessionUpdate): void {
		if (config.instructions !== undefined) {
			this.config.systemInstruction = config.instructions;
		}
		if (config.tools !== undefined) {
			this.config.tools = config.tools;
		}
		if (config.providerOptions !== undefined) {
			if (typeof config.providerOptions.googleSearch === 'boolean') {
				this.config.googleSearch = config.providerOptions.googleSearch;
			}
			if (config.providerOptions.compressionConfig) {
				this.config.compressionConfig = config.providerOptions.compressionConfig as {
					triggerTokens: number;
					targetTokens: number;
				};
			}
		}
	}

	/** Transfer session: update config → reconnect → replay conversation history. */
	async transferSession(config: SessionUpdate, state?: ReconnectState): Promise<void> {
		this.updateSession(config);
		// Use internal resumption handle (stored from onResumptionUpdate)
		await this.disconnect();
		await this.connect();

		// Replay conversation history if provided
		if (state?.conversationHistory?.length) {
			this.replayHistory(state.conversationHistory);
		}
	}

	// --- Private helpers ---

	/** Apply LLMTransportConfig fields to the internal GeminiTransportConfig. */
	/** Merge LLMTransportConfig into the internal config. Only provided fields are applied;
	 *  undefined fields preserve existing constructor values.
	 */
	private applyTransportConfig(config: LLMTransportConfig): void {
		if (config.auth.type === 'api_key') {
			this.ai = new GoogleGenAI({ apiKey: config.auth.apiKey });
		}
		if (config.model !== undefined) {
			this.config.model = config.model;
		}
		if (config.instructions !== undefined) {
			this.config.systemInstruction = config.instructions;
		}
		if (config.tools !== undefined) {
			this.config.tools = config.tools;
		}
		if (config.voice !== undefined) {
			this.config.speechConfig = { voiceName: config.voice };
		}
		if (config.transcription !== undefined) {
			this.config.inputAudioTranscription = config.transcription.input ?? true;
		}
		if (config.providerOptions) {
			if (typeof config.providerOptions.googleSearch === 'boolean') {
				this.config.googleSearch = config.providerOptions.googleSearch;
			}
			if (config.providerOptions.compressionConfig) {
				this.config.compressionConfig = config.providerOptions.compressionConfig as {
					triggerTokens: number;
					targetTokens: number;
				};
			}
		}
	}

	/** Convert ReplayItem[] to Gemini Content format and send as client content. */
	private replayHistory(items: ReplayItem[]): void {
		if (!this.session || items.length === 0) return;
		const turns: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

		for (const item of items) {
			switch (item.type) {
				case 'text':
					turns.push({
						role: item.role === 'assistant' ? 'model' : item.role,
						parts: [{ text: item.text }],
					});
					break;
				case 'tool_call':
					turns.push({
						role: 'model',
						parts: [{ functionCall: { name: item.name, args: item.args } }],
					});
					break;
				case 'tool_result':
					turns.push({
						role: 'user',
						parts: [{ functionResponse: { name: item.name, response: item.result } }],
					});
					break;
				case 'file':
					turns.push({
						role: 'user',
						parts: [{ inlineData: { data: item.base64Data, mimeType: item.mimeType } }],
					});
					break;
				case 'transfer':
					turns.push({
						role: 'user',
						parts: [{ text: `[Agent transfer: ${item.fromAgent} → ${item.toAgent}]` }],
					});
					break;
			}
		}

		this.session.sendClientContent({ turns, turnComplete: false });
	}

	/** Transcribe buffered user audio using a separate Gemini model (fire-and-forget). */
	private _transcribeBufferedAudio(): void {
		const chunks = this._audioChunks;
		this._audioChunks = [];

		const sttModel = this.config.sttModel;
		if (!sttModel) return;

		const pcmBuf = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
		if (pcmBuf.length === 0) return;

		// Skip STT if audio is too short (<0.3s) or too quiet (mostly silence/noise)
		const MIN_DURATION_BYTES = 9600; // 0.3s at 32000 bytes/s (16kHz 16-bit mono)
		const MIN_RMS_THRESHOLD = 300; // silence ~0-100, speech ~1000+
		if (pcmBuf.length < MIN_DURATION_BYTES || pcmRms(pcmBuf) < MIN_RMS_THRESHOLD) return;

		const wavBuf = pcmToWav(pcmBuf, 16000);

		this.ai.models
			.generateContent({
				model: sttModel,
				contents: [
					{
						role: 'user',
						parts: [
							{
								inlineData: {
									data: wavBuf.toString('base64'),
									mimeType: 'audio/wav',
								},
							},
							{
								text: 'Transcribe the spoken words in this audio. If the audio contains only silence, background noise, or no clear speech, respond with exactly: [SILENCE]',
							},
						],
					},
				],
			})
			.then((response) => {
				const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
				if (text && text !== '[SILENCE]') {
					this.callbacks.onInputTranscription?.(text);
					if (this.onInputTranscription) this.onInputTranscription(text);
				}
			})
			.catch(() => {
				// STT failure is non-fatal — user audio still processed by live model
			});
	}

	// biome-ignore lint/suspicious/noExplicitAny: LiveServerMessage is a complex union type
	private handleMessage(msg: any): void {
		if (msg.setupComplete) {
			// Resolve the connect() promise so callers know Gemini is ready
			if (this.setupResolver) {
				this.setupResolver();
				this.setupResolver = null;
			}
			const sessionId = msg.setupComplete.sessionId ?? '';
			this.callbacks.onSetupComplete?.(sessionId);
			if (this.onSessionReady) this.onSessionReady(sessionId);
			return;
		}

		if (msg.serverContent) {
			const content = msg.serverContent;

			// Audio output
			if (content.modelTurn?.parts) {
				// Trigger separate-model STT when model starts responding
				if (this.config.sttModel && this._audioChunks.length > 0) {
					this._transcribeBufferedAudio();
				}
				for (const part of content.modelTurn.parts) {
					if (part.inlineData?.data) {
						this.callbacks.onAudioOutput?.(part.inlineData.data);
						if (this.onAudioOutput) this.onAudioOutput(part.inlineData.data);
					}
				}
			}

			// Grounding metadata (Google Search results)
			if (content.groundingMetadata) {
				this.callbacks.onGroundingMetadata?.(content.groundingMetadata);
				if (this.onGroundingMetadata) this.onGroundingMetadata(content.groundingMetadata);
			}

			// Transcriptions — skip built-in input transcription when using separate STT model
			if (content.inputTranscription?.text && !this.config.sttModel) {
				this.callbacks.onInputTranscription?.(content.inputTranscription.text);
				if (this.onInputTranscription) this.onInputTranscription(content.inputTranscription.text);
			}
			if (content.outputTranscription?.text) {
				this.callbacks.onOutputTranscription?.(content.outputTranscription.text);
				if (this.onOutputTranscription)
					this.onOutputTranscription(content.outputTranscription.text);
			}

			// Turn signals — check interrupted BEFORE turnComplete so the flag
			// is set correctly even if both arrive in the same server message
			if (content.interrupted) {
				this._wasInterrupted = true;
				this.callbacks.onInterrupted?.();
				if (this.onInterrupted) this.onInterrupted();
			}
			if (content.turnComplete) {
				// Only clear STT buffer on NATURAL turn completion (not after interruption).
				// When the user interrupts, their speech is in the buffer and must be
				// preserved for the next modelTurn to trigger STT.
				if (this.config.sttModel && !this._wasInterrupted) {
					this._audioChunks = [];
				}
				this._wasInterrupted = false;
				this.callbacks.onTurnComplete?.();
				if (this.onTurnComplete) this.onTurnComplete();
			}
			return;
		}

		if (msg.toolCall?.functionCalls?.length) {
			this.callbacks.onToolCall?.(msg.toolCall.functionCalls);
			if (this.onToolCall) this.onToolCall(msg.toolCall.functionCalls);
			return;
		}

		if (msg.toolCallCancellation?.ids?.length) {
			this.callbacks.onToolCallCancellation?.(msg.toolCallCancellation.ids);
			if (this.onToolCallCancel) this.onToolCallCancel(msg.toolCallCancellation.ids);
			return;
		}

		if (msg.goAway) {
			this.callbacks.onGoAway?.(msg.goAway.timeLeft ?? '');
			if (this.onGoAway) this.onGoAway(msg.goAway.timeLeft ?? '');
			return;
		}

		if (msg.sessionResumptionUpdate?.newHandle) {
			this.callbacks.onResumptionUpdate?.(
				msg.sessionResumptionUpdate.newHandle,
				msg.sessionResumptionUpdate.resumable ?? false,
			);
			if (this.onResumptionUpdate) {
				this.onResumptionUpdate(
					msg.sessionResumptionUpdate.newHandle,
					msg.sessionResumptionUpdate.resumable ?? false,
				);
			}
		}
	}
}

/** Convert a ToolDefinition to a Gemini function declaration (name + description + JSON Schema). */
function toolToDeclaration(tool: ToolDefinition): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: zodToJsonSchema(tool.parameters),
	};
}

/** Calculate RMS (root mean square) energy of 16-bit signed PCM audio.
 *  Returns 0 for empty buffers. Typical values: silence ~0-100, speech ~1000-5000. */
function pcmRms(pcm: Buffer): number {
	const sampleCount = pcm.length / 2;
	if (sampleCount === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < pcm.length; i += 2) {
		const sample = pcm.readInt16LE(i);
		sumSquares += sample * sample;
	}
	return Math.sqrt(sumSquares / sampleCount);
}

/** Wrap raw PCM (16-bit mono little-endian) in a minimal 44-byte WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(pcm.length + 36, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16); // chunk size
	header.writeUInt16LE(1, 20); // PCM format
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
