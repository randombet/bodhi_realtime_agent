import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import type { ToolDefinition } from '../types/tool.js';
import { zodToJsonSchema } from './zod-to-schema.js';

export interface GeminiTransportConfig {
	apiKey: string;
	model?: string;
	systemInstruction?: string;
	tools?: ToolDefinition[];
	resumptionHandle?: string;
	speechConfig?: { voiceName?: string };
	compressionConfig?: { triggerTokens: number; targetTokens: number };
}

export interface GeminiTransportCallbacks {
	onSetupComplete?(sessionId: string): void;
	onAudioOutput?(data: string): void;
	onToolCall?(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): void;
	onToolCallCancellation?(ids: string[]): void;
	onTurnComplete?(): void;
	onInterrupted?(): void;
	onInputTranscription?(text: string): void;
	onOutputTranscription?(text: string): void;
	onGoAway?(timeLeft: string): void;
	onResumptionUpdate?(handle: string, resumable: boolean): void;
	onError?(error: Error): void;
	onClose?(): void;
}

export class GeminiLiveTransport {
	private session: Session | null = null;
	private ai: GoogleGenAI;
	private callbacks: GeminiTransportCallbacks;
	private config: GeminiTransportConfig;

	constructor(config: GeminiTransportConfig, callbacks: GeminiTransportCallbacks) {
		this.ai = new GoogleGenAI({ apiKey: config.apiKey });
		this.config = config;
		this.callbacks = callbacks;
	}

	async connect(): Promise<void> {
		const model = this.config.model ?? 'gemini-live-2.5-flash-preview';

		const connectConfig: Record<string, unknown> = {
			responseModalities: ['AUDIO'],
			inputAudioTranscription: {},
			outputAudioTranscription: {},
		};

		if (this.config.systemInstruction) {
			connectConfig.systemInstruction = this.config.systemInstruction;
		}

		if (this.config.tools?.length) {
			connectConfig.tools = [{ functionDeclarations: this.config.tools.map(toolToDeclaration) }];
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
	}

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

	sendAudio(base64Data: string): void {
		if (!this.session) return;
		this.session.sendRealtimeInput({
			media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
		});
	}

	sendToolResponse(
		responses: Array<{ id?: string; name?: string; response?: Record<string, unknown> }>,
		_scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT',
	): void {
		if (!this.session) return;
		this.session.sendToolResponse({ functionResponses: responses });
	}

	sendClientContent(
		turns: Array<{ role: string; parts: Array<{ text: string }> }>,
		turnComplete = true,
	): void {
		if (!this.session) return;
		this.session.sendClientContent({ turns, turnComplete });
	}

	updateTools(tools: ToolDefinition[]): void {
		this.config.tools = tools;
	}

	updateSystemInstruction(instruction: string): void {
		this.config.systemInstruction = instruction;
	}

	get isConnected(): boolean {
		return this.session !== null;
	}

	// biome-ignore lint/suspicious/noExplicitAny: LiveServerMessage is a complex union type
	private handleMessage(msg: any): void {
		if (msg.setupComplete) {
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

function toolToDeclaration(tool: ToolDefinition): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: zodToJsonSchema(tool.parameters),
	};
}
