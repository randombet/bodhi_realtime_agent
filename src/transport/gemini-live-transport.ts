// SPDX-License-Identifier: MIT

import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import type { ToolDefinition } from '../types/tool.js';
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
	onClose?(): void;
}

/**
 * WebSocket transport layer for the Gemini Live API.
 *
 * Wraps the `@google/genai` SDK's live.connect() to manage the bidirectional
 * audio stream. Handles connection setup, message routing, tool declaration
 * conversion (Zod → JSON Schema), and session resumption.
 */
export class GeminiLiveTransport {
	private session: Session | null = null;
	private ai: GoogleGenAI;
	private callbacks: GeminiTransportCallbacks;
	private config: GeminiTransportConfig;
	/** Resolves when setupComplete fires — used to make connect() await Gemini readiness. */
	private setupResolver: (() => void) | null = null;

	constructor(config: GeminiTransportConfig, callbacks: GeminiTransportCallbacks) {
		this.ai = new GoogleGenAI({ apiKey: config.apiKey });
		this.config = config;
		this.callbacks = callbacks;
	}

	/** Establish a WebSocket connection to the Gemini Live API.
	 *  Resolves only after Gemini sends `setupComplete`, so callers can safely
	 *  send content immediately after awaiting this method.
	 */
	async connect(): Promise<void> {
		const setupComplete = new Promise<void>((resolve) => {
			this.setupResolver = resolve;
		});

		const model = this.config.model ?? 'gemini-live-2.5-flash-preview';

		const connectConfig: Record<string, unknown> = {
			responseModalities: ['AUDIO'],
			outputAudioTranscription: {},
		};

		if (this.config.inputAudioTranscription !== false) {
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
					this.callbacks.onError?.(new Error(e.message ?? 'WebSocket error'));
				},
				onclose: () => {
					this.callbacks.onClose?.();
				},
			},
		});

		await setupComplete;
	}

	/** Disconnect and reconnect, optionally with a new resumption handle. */
	async reconnect(handle?: string): Promise<void> {
		await this.disconnect();
		if (handle) {
			this.config.resumptionHandle = handle;
		}
		await this.connect();
	}

	async disconnect(): Promise<void> {
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
		this.session.sendRealtimeInput({
			media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
		});
	}

	/** Send tool execution results back to Gemini. */
	sendToolResponse(
		responses: Array<{ id?: string; name?: string; response?: Record<string, unknown> }>,
		_scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT',
	): void {
		if (!this.session) return;
		this.session.sendToolResponse({ functionResponses: responses });
	}

	/** Send text-based conversation turns to Gemini (used for context replay). */
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

	// biome-ignore lint/suspicious/noExplicitAny: LiveServerMessage is a complex union type
	private handleMessage(msg: any): void {
		if (msg.setupComplete) {
			// Resolve the connect() promise so callers know Gemini is ready
			if (this.setupResolver) {
				this.setupResolver();
				this.setupResolver = null;
			}
			this.callbacks.onSetupComplete?.(msg.setupComplete.sessionId ?? '');
			return;
		}

		if (msg.serverContent) {
			const content = msg.serverContent;

			// Audio output
			if (content.modelTurn?.parts) {
				for (const part of content.modelTurn.parts) {
					if (part.inlineData?.data) {
						this.callbacks.onAudioOutput?.(part.inlineData.data);
					}
				}
			}

			// Grounding metadata (Google Search results)
			if (content.groundingMetadata) {
				this.callbacks.onGroundingMetadata?.(content.groundingMetadata);
			}

			// Transcriptions
			if (content.inputTranscription?.text) {
				this.callbacks.onInputTranscription?.(content.inputTranscription.text);
			}
			if (content.outputTranscription?.text) {
				this.callbacks.onOutputTranscription?.(content.outputTranscription.text);
			}

			// Turn signals
			if (content.turnComplete) {
				this.callbacks.onTurnComplete?.();
			}
			if (content.interrupted) {
				this.callbacks.onInterrupted?.();
			}
			return;
		}

		if (msg.toolCall?.functionCalls?.length) {
			this.callbacks.onToolCall?.(msg.toolCall.functionCalls);
			return;
		}

		if (msg.toolCallCancellation?.ids?.length) {
			this.callbacks.onToolCallCancellation?.(msg.toolCallCancellation.ids);
			return;
		}

		if (msg.goAway) {
			this.callbacks.onGoAway?.(msg.goAway.timeLeft ?? '');
			return;
		}

		if (msg.sessionResumptionUpdate?.newHandle) {
			this.callbacks.onResumptionUpdate?.(
				msg.sessionResumptionUpdate.newHandle,
				msg.sessionResumptionUpdate.resumable ?? false,
			);
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
