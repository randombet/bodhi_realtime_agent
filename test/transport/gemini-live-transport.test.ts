// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	DEFAULT_GEMINI_LIVE_MODEL,
	DEFAULT_GEMINI_REALTIME_INPUT_CONFIG,
	GeminiLiveTransport,
	resolveGeminiRealtimeInputConfig,
} from '../../src/transport/gemini-live-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { RealtimeLLMUsageEvent } from '../../src/types/transport.js';

// Mock @google/genai
let capturedConnectConfig: Record<string, unknown> = {};
const mockSession = {
	sendRealtimeInput: vi.fn(),
	sendToolResponse: vi.fn(),
	sendClientContent: vi.fn(),
	close: vi.fn(),
};

vi.mock('@google/genai', () => ({
	GoogleGenAI: vi.fn().mockImplementation(() => ({
		live: {
			connect: vi.fn(async (params: Record<string, unknown>) => {
				capturedConnectConfig = params;
				const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
				cbs.onopen?.();
				// Fire setupComplete so connect() resolves (it awaits this)
				setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'mock_sid' } }), 1);
				return mockSession;
			}),
		},
	})),
}));

function createTestTool(): ToolDefinition {
	return {
		name: 'search',
		description: 'Search the web',
		parameters: z.object({ query: z.string() }),
		execution: 'inline',
		execute: vi.fn(async () => 'result'),
	};
}

describe('GeminiLiveTransport', () => {
	beforeEach(() => {
		mockSession.sendRealtimeInput.mockClear();
		mockSession.sendToolResponse.mockClear();
		mockSession.sendClientContent.mockClear();
		mockSession.close.mockClear();
	});

	describe('connect', () => {
		it('builds correct config with defaults', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			expect(capturedConnectConfig.model).toBe(DEFAULT_GEMINI_LIVE_MODEL);
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.responseModalities).toEqual(['AUDIO']);
			expect(config.sessionResumption).toEqual({});
			expect(config.inputAudioTranscription).toEqual({});
		});

		it('includes system instruction when provided', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', systemInstruction: 'Be helpful' },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.systemInstruction).toBe('Be helpful');
		});

		it('includes tools as function declarations', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', tools: [createTestTool()] },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<{
				functionDeclarations: Array<Record<string, unknown>>;
			}>;
			expect(tools[0].functionDeclarations[0].name).toBe('search');
			expect(tools[0].functionDeclarations[0].description).toBe('Search the web');
		});

		it('includes googleSearch when enabled', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', googleSearch: true, tools: [createTestTool()] },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<Record<string, unknown>>;
			expect(tools).toHaveLength(2);
			expect(tools[0]).toEqual({ googleSearch: {} });
			expect(tools[1]).toHaveProperty('functionDeclarations');
		});

		it('omits googleSearch when not set', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', tools: [createTestTool()] },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<Record<string, unknown>>;
			expect(tools).toHaveLength(1);
			expect(tools[0]).toHaveProperty('functionDeclarations');
		});

		it('supports googleSearch without function declarations', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key', googleSearch: true }, {});
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			const tools = config.tools as Array<Record<string, unknown>>;
			expect(tools).toHaveLength(1);
			expect(tools[0]).toEqual({ googleSearch: {} });
		});

		it('includes inputAudioTranscription by default', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.inputAudioTranscription).toEqual({});
		});

		it('includes realtimeInputConfig when provided', async () => {
			const realtimeInputConfig = {
				automaticActivityDetection: {
					endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
					silenceDurationMs: 500,
				},
			};
			const transport = new GeminiLiveTransport({ apiKey: 'test-key', realtimeInputConfig }, {});
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.realtimeInputConfig).toEqual(realtimeInputConfig);
		});

		it('omits inputAudioTranscription when explicitly disabled', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', inputAudioTranscription: false },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.inputAudioTranscription).toBeUndefined();
		});

		it('includes resumption handle', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', resumptionHandle: 'handle_abc' },
				{},
			);
			await transport.connect();

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'handle_abc' });
		});

		it('sets isConnected after connect', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(transport.isConnected).toBe(false);
			await transport.connect();
			expect(transport.isConnected).toBe(true);
		});

		it('rejects with timeout when setupComplete never fires', async () => {
			// Override GoogleGenAI constructor to return a connect that never fires setupComplete
			const { GoogleGenAI } = await import('@google/genai');
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: {
					connect: vi.fn(async () => mockSession),
				},
			}));

			const transport = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 50 }, {});
			await expect(transport.connect()).rejects.toThrow('timed out');
		});
	});

	describe('sendAudio', () => {
		it('calls session.sendRealtimeInput with correct format', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendAudio('base64audiodata');

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				audio: { data: 'base64audiodata', mimeType: 'audio/pcm;rate=16000' },
			});
		});

		it.each([DEFAULT_GEMINI_LIVE_MODEL, 'gemini-2.5-flash-native-audio-preview-12-2025'])(
			'sends non-deprecated audio realtime input for %s',
			async (model) => {
				const transport = new GeminiLiveTransport({ apiKey: 'test-key', model }, {});
				await transport.connect();

				transport.sendAudio('base64audiodata');

				expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
					audio: { data: 'base64audiodata', mimeType: 'audio/pcm;rate=16000' },
				});
				expect(mockSession.sendRealtimeInput).not.toHaveBeenCalledWith(
					expect.objectContaining({ media: expect.anything() }),
				);
			},
		);

		it('does nothing if not connected', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.sendAudio('data');
			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
		});
	});

	describe('sendToolResponse', () => {
		it('sends tool response with scheduling', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendToolResponse(
				[{ id: 'fc_1', name: 'search', response: { results: [] } }],
				'WHEN_IDLE',
			);

			expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
				functionResponses: [{ id: 'fc_1', name: 'search', response: { results: [] } }],
			});
		});
	});

	describe('sendClientContent', () => {
		it('sends turns with turnComplete default', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendClientContent([{ role: 'user', parts: [{ text: 'hello' }] }]);

			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [{ role: 'user', parts: [{ text: 'hello' }] }],
				turnComplete: true,
			});
		});
	});

	describe('message dispatch', () => {
		it('dispatches setupComplete', async () => {
			const onSetupComplete = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onSetupComplete });
			await transport.connect();

			// Simulate message from server
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ setupComplete: { sessionId: 'sid_1' } });

			expect(onSetupComplete).toHaveBeenCalledWith('sid_1');
		});

		it('dispatches audio output', async () => {
			const onAudioOutput = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onAudioOutput });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});

			expect(onAudioOutput).toHaveBeenCalledWith('audio_b64');
		});

		it('suppresses audio output callbacks in text mode', async () => {
			const onAudioOutput = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onAudioOutput });
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash-native-audio-preview-12-2025',
				responseModality: 'text',
			});

			const propertyAudioOutput = vi.fn();
			transport.onAudioOutput = propertyAudioOutput;

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});

			expect(onAudioOutput).not.toHaveBeenCalled();
			expect(propertyAudioOutput).not.toHaveBeenCalled();
		});

		it('dispatches toolCall', async () => {
			const onToolCall = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onToolCall });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				toolCall: {
					functionCalls: [{ id: 'fc_1', name: 'search', args: { q: 'test' } }],
				},
			});

			expect(onToolCall).toHaveBeenCalledWith([
				{ id: 'fc_1', name: 'search', args: { q: 'test' } },
			]);
		});

		it('dispatches toolCallCancellation', async () => {
			const onToolCallCancellation = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onToolCallCancellation });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ toolCallCancellation: { ids: ['fc_1', 'fc_2'] } });

			expect(onToolCallCancellation).toHaveBeenCalledWith(['fc_1', 'fc_2']);
		});

		it('dispatches turnComplete', async () => {
			const onTurnComplete = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onTurnComplete });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ serverContent: { turnComplete: true } });

			expect(onTurnComplete).toHaveBeenCalledOnce();
		});

		it('dispatches goAway', async () => {
			const onGoAway = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onGoAway });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ goAway: { timeLeft: '30s' } });

			expect(onGoAway).toHaveBeenCalledWith('30s');
		});

		it('dispatches resumptionUpdate', async () => {
			const onResumptionUpdate = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onResumptionUpdate });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'h_new', resumable: true },
			});

			expect(onResumptionUpdate).toHaveBeenCalledWith('h_new', true);
		});

		it('dispatches groundingMetadata', async () => {
			const onGroundingMetadata = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onGroundingMetadata });
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: {
					groundingMetadata: {
						searchEntryPoint: { renderedContent: '<div>results</div>' },
						groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
					},
				},
			});

			expect(onGroundingMetadata).toHaveBeenCalledWith({
				searchEntryPoint: { renderedContent: '<div>results</div>' },
				groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
			});
		});

		it('dispatches transcriptions', async () => {
			const onInputTranscription = vi.fn();
			const onOutputTranscription = vi.fn();
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onInputTranscription, onOutputTranscription },
			);
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: { inputTranscription: { text: 'hello' } },
			});
			cbs.onmessage({
				serverContent: { outputTranscription: { text: 'hi there' } },
			});

			expect(onInputTranscription).toHaveBeenCalledWith('hello');
			expect(onOutputTranscription).toHaveBeenCalledWith('hi there');
		});

		it('fires onSpeechStarted when input transcription arrives', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const speechStarted = vi.fn();
			transport.onSpeechStarted = speechStarted;

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: { inputTranscription: { text: 'hello' } },
			});

			expect(speechStarted).toHaveBeenCalledOnce();
		});

		it('fires onSpeechStarted when turn is interrupted', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const speechStarted = vi.fn();
			transport.onSpeechStarted = speechStarted;

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: { interrupted: true },
			});

			expect(speechStarted).toHaveBeenCalledOnce();
		});
	});

	describe('disconnect', () => {
		it('closes session and sets isConnected to false', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			expect(transport.isConnected).toBe(true);

			await transport.disconnect();
			expect(transport.isConnected).toBe(false);
			expect(mockSession.close).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// LLMTransport interface tests
	// =========================================================================

	describe('LLMTransport capabilities', () => {
		it('reports Gemini capabilities', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(transport.capabilities).toEqual({
				messageTruncation: false,
				turnDetection: true,
				userTranscription: true,
				inPlaceSessionUpdate: false,
				sessionResumption: true,
				contextCompression: true,
				groundingMetadata: true,
				textResponseModality: true,
				quiescible: true,
			});
		});

		it('reports Gemini audio format', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(transport.audioFormat).toEqual({
				inputSampleRate: 16000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			});
		});
	});

	describe('text-mode responses', () => {
		it('configures dual AUDIO+TEXT modalities when responseModality is text', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash',
				responseModality: 'text',
			});

			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({ responseModalities: ['AUDIO', 'TEXT'] }),
			);
		});

		it('uses AUDIO + outputAudioTranscription in text mode for native-audio models', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash-native-audio-preview-12-2025',
				responseModality: 'text',
			});

			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({
					responseModalities: ['AUDIO'],
					outputAudioTranscription: {},
				}),
			);
		});

		it('uses AUDIO + outputAudioTranscription in text mode for Gemini 3.x live models', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-3.1-flash-live-preview',
				responseModality: 'text',
			});

			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({
					responseModalities: ['AUDIO'],
					outputAudioTranscription: {},
				}),
			);
		});

		it('fires onTextOutput for text parts in modelTurn', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash',
				responseModality: 'text',
			});

			const textOutput = vi.fn();
			transport.onTextOutput = textOutput;

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ text: 'Hello world' }] },
				},
			});

			expect(textOutput).toHaveBeenCalledWith('Hello world');
		});

		it('routes outputTranscription text to onTextOutput in native-audio text mode', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash-native-audio-preview-12-2025',
				responseModality: 'text',
			});

			const textOutput = vi.fn();
			transport.onTextOutput = textOutput;

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: { outputTranscription: { text: 'Transcribed output' } },
			});

			expect(textOutput).toHaveBeenCalledWith('Transcribed output');
		});

		it('suppresses model text parts when native-audio outputTranscription fallback is active', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash-native-audio-preview-12-2025',
				responseModality: 'text',
			});

			const textOutput = vi.fn();
			transport.onTextOutput = textOutput;

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ text: '**Interpreting User Intent**' }] },
					outputTranscription: { text: "I'm doing great, thanks!" },
				},
			});

			expect(textOutput).toHaveBeenCalledTimes(1);
			expect(textOutput).toHaveBeenCalledWith("I'm doing great, thanks!");
		});

		it('fires onTextDone before onTurnComplete in text mode', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash',
				responseModality: 'text',
			});

			const order: string[] = [];
			transport.onTextDone = () => order.push('textDone');
			transport.onTurnComplete = () => order.push('turnComplete');

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: { turnComplete: true },
			});

			expect(order).toEqual(['textDone', 'turnComplete']);
		});

		it('does not fire onTextDone in audio mode', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const textDone = vi.fn();
			transport.onTextDone = textDone;

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				serverContent: { turnComplete: true },
			});

			expect(textDone).not.toHaveBeenCalled();
		});

		it('preserves responseModality on reconnect', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash',
				responseModality: 'text',
			});

			await transport.disconnect();
			await transport.reconnect();

			// Second connect should still have TEXT modality
			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({ responseModalities: ['AUDIO', 'TEXT'] }),
			);
		});

		it('applies responseModality from updateSession on next reconnect', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash',
			});
			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({ responseModalities: ['AUDIO'] }),
			);

			transport.updateSession({ responseModality: 'text' });
			await transport.reconnect();

			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({ responseModalities: ['AUDIO', 'TEXT'] }),
			);
		});

		describe('server-turn state machine (external-TTS turn completion)', () => {
			async function connectTextMode(model = 'gemini-3.1-flash-live-preview') {
				const transport = new GeminiLiveTransport({ apiKey: 'test-key', model }, {});
				await transport.connect({
					auth: { type: 'api_key', apiKey: 'test-key' },
					model,
					responseModality: 'text',
				});
				const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
				return { transport, cbs };
			}

			it('fires turn-end on generationComplete in native-audio text mode', async () => {
				const { transport, cbs } = await connectTextMode();
				const order: string[] = [];
				transport.onTextOutput = () => order.push('text');
				transport.onTextDone = () => order.push('textDone');
				let completedId: number | undefined;
				transport.onTurnComplete = (id) => {
					order.push('turnComplete');
					completedId = id;
				};
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hello there.' } } });
				cbs.onmessage({ serverContent: { generationComplete: true } });
				expect(order).toEqual(['text', 'textDone', 'turnComplete']);
				expect(typeof completedId).toBe('number');
			});

			it('does not re-fire turn-end on the trailing turnComplete after early completion', async () => {
				const { transport, cbs } = await connectTextMode();
				transport.onTextOutput = () => {};
				const textDone = vi.fn();
				const turnComplete = vi.fn();
				transport.onTextDone = textDone;
				transport.onTurnComplete = turnComplete;
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
				cbs.onmessage({ serverContent: { generationComplete: true } });
				expect(textDone).toHaveBeenCalledTimes(1);
				expect(turnComplete).toHaveBeenCalledTimes(1);
				cbs.onmessage({ serverContent: { turnComplete: true } });
				expect(textDone).toHaveBeenCalledTimes(1);
				expect(turnComplete).toHaveBeenCalledTimes(1);
			});

			it('same-message text + generationComplete fires text before turn-end', async () => {
				const { transport, cbs } = await connectTextMode('gemini-2.5-flash');
				const order: string[] = [];
				transport.onTextOutput = () => order.push('text');
				transport.onTextDone = () => order.push('textDone');
				transport.onTurnComplete = () => order.push('turnComplete');
				cbs.onmessage({
					serverContent: {
						modelTurn: { parts: [{ text: 'Final words.' }] },
						generationComplete: true,
					},
				});
				expect(order).toEqual(['text', 'textDone', 'turnComplete']);
			});

			it('a late modelTurn after early completion does not re-fire onModelTurnStart', async () => {
				const { transport, cbs } = await connectTextMode();
				const modelTurnStart = vi.fn();
				transport.onModelTurnStart = modelTurnStart;
				transport.onTextOutput = () => {};
				transport.onTextDone = () => {};
				transport.onTurnComplete = () => {};
				cbs.onmessage({
					serverContent: { modelTurn: { parts: [{ inlineData: { data: 'aa' } }] } },
				});
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hello.' } } });
				cbs.onmessage({ serverContent: { generationComplete: true } });
				expect(modelTurnStart).toHaveBeenCalledTimes(1);
				cbs.onmessage({
					serverContent: { modelTurn: { parts: [{ inlineData: { data: 'bb' } }] } },
				});
				expect(modelTurnStart).toHaveBeenCalledTimes(1);
			});

			it('does not early-complete a tool-call turn', async () => {
				const { transport, cbs } = await connectTextMode();
				transport.onTextOutput = () => {};
				transport.onToolCall = () => {};
				const turnComplete = vi.fn();
				transport.onTurnComplete = turnComplete;
				cbs.onmessage({ toolCall: { functionCalls: [{ id: 'fc1', name: 'x', args: {} }] } });
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Checking.' } } });
				cbs.onmessage({ serverContent: { generationComplete: true } });
				expect(turnComplete).not.toHaveBeenCalled();
				cbs.onmessage({ serverContent: { turnComplete: true } });
				expect(turnComplete).toHaveBeenCalledTimes(1);
			});

			it('does not fire turn-end on generationComplete in audio mode', async () => {
				const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
				await transport.connect();
				const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
				const turnComplete = vi.fn();
				transport.onTurnComplete = turnComplete;
				cbs.onmessage({ serverContent: { generationComplete: true } });
				expect(turnComplete).not.toHaveBeenCalled();
				cbs.onmessage({ serverContent: { turnComplete: true } });
				expect(turnComplete).toHaveBeenCalledTimes(1);
			});

			it('interrupted carries a server-turn id reused by the trailing turnComplete', async () => {
				const { transport, cbs } = await connectTextMode();
				let interruptedId: number | undefined;
				let completedId: number | undefined;
				transport.onInterrupted = (id) => {
					interruptedId = id;
				};
				transport.onTurnComplete = (id) => {
					completedId = id;
				};
				transport.onTextDone = () => {};
				cbs.onmessage({ serverContent: { interrupted: true } });
				cbs.onmessage({ serverContent: { turnComplete: true } });
				expect(typeof interruptedId).toBe('number');
				expect(completedId).toBe(interruptedId);
			});

			it('tags final usage from an early-completed turn as serverTurnWindingDown', async () => {
				const { transport, cbs } = await connectTextMode();
				transport.onTextOutput = () => {};
				transport.onTextDone = () => {};
				transport.onTurnComplete = () => {};
				const usage: RealtimeLLMUsageEvent[] = [];
				transport.onRealtimeLLMUsage = (u) => usage.push(u);
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
				cbs.onmessage({ serverContent: { generationComplete: true } });
				cbs.onmessage({
					usageMetadata: { promptTokenCount: 6, responseTokenCount: 4, totalTokenCount: 10 },
					serverContent: { turnComplete: true },
				});
				const windingDown = usage.filter((u) => u.serverTurnWindingDown);
				expect(windingDown.length).toBeGreaterThan(0);
				expect(typeof windingDown[0].serverTurnId).toBe('number');
			});

			it('buffers generation-triggering sends during the divergence window', async () => {
				const { transport, cbs } = await connectTextMode();
				transport.onTextOutput = () => {};
				transport.onTextDone = () => {};
				transport.onTurnComplete = () => {};
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
				cbs.onmessage({ serverContent: { generationComplete: true } });
				mockSession.sendClientContent.mockClear();
				mockSession.sendRealtimeInput.mockClear();
				// During ENDED_EARLY a generation-triggering send is buffered.
				transport.sendClientContent([{ role: 'user', parts: [{ text: 'directive' }] }], true);
				expect(mockSession.sendClientContent).not.toHaveBeenCalled();
				// Realtime audio is never buffered.
				transport.sendAudio('YXVkaW8=');
				expect(mockSession.sendRealtimeInput).toHaveBeenCalled();
				// On turnComplete (CLOSED) the buffer flushes.
				cbs.onmessage({ serverContent: { turnComplete: true } });
				expect(mockSession.sendClientContent).toHaveBeenCalledTimes(1);
			});

			it('disconnect() resets server-turn state', async () => {
				const { transport, cbs } = await connectTextMode();
				transport.onTextOutput = () => {};
				transport.onTextDone = () => {};
				transport.onTurnComplete = () => {};
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
				cbs.onmessage({ serverContent: { generationComplete: true } });
				await transport.disconnect();
				await transport.reconnect();
				mockSession.sendClientContent.mockClear();
				// After the reset the session is no longer winding down — send goes through.
				transport.sendClientContent([{ role: 'user', parts: [{ text: 'x' }] }], true);
				expect(mockSession.sendClientContent).toHaveBeenCalledTimes(1);
			});

			it('getActiveServerTurnId() is active-only — id while generating, undefined otherwise', async () => {
				const { transport, cbs } = await connectTextMode();
				transport.onTextOutput = () => {};
				transport.onTextDone = () => {};
				transport.onTurnComplete = () => {};
				// idle — no server turn yet
				expect(transport.getActiveServerTurnId()).toBeUndefined();
				// generating — a live id
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
				const generatingId = transport.getActiveServerTurnId();
				expect(typeof generatingId).toBe('number');
				// ended_early (winding down) — still the same live id
				cbs.onmessage({ serverContent: { generationComplete: true } });
				expect(transport.getActiveServerTurnId()).toBe(generatingId);
				// closed (trailing turnComplete) — undefined, not the stale id
				cbs.onmessage({ serverContent: { turnComplete: true } });
				expect(transport.getActiveServerTurnId()).toBeUndefined();
			});

			it('getActiveServerTurnId() is undefined after disconnect/reset', async () => {
				const { transport, cbs } = await connectTextMode();
				transport.onTextOutput = () => {};
				cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
				expect(typeof transport.getActiveServerTurnId()).toBe('number');
				await transport.disconnect();
				expect(transport.getActiveServerTurnId()).toBeUndefined();
			});
		});

		it('resumes with the latest server handle and does not replay history', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'handle_resume', resumable: true },
			});

			mockSession.sendClientContent.mockClear();
			await transport.reconnect({
				conversationHistory: [{ type: 'text', role: 'user', text: 'hello before reconnect' }],
			});

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'handle_resume' });
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});

		it('uses an explicit reconnect resumption handle and does not replay history', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			mockSession.sendClientContent.mockClear();
			await transport.reconnect({
				resumptionHandle: 'handle_explicit',
				conversationHistory: [{ type: 'text', role: 'user', text: 'hello before reconnect' }],
			});

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'handle_explicit' });
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});
	});

	describe('sendContent', () => {
		it('converts ContentTurn to Gemini format', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendContent([
				{ role: 'user', text: 'hello' },
				{ role: 'assistant', text: 'hi there' },
			]);

			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [
					{ role: 'user', parts: [{ text: 'hello' }] },
					{ role: 'model', parts: [{ text: 'hi there' }] },
				],
				turnComplete: true,
			});
		});

		it('respects turnComplete parameter', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendContent([{ role: 'user', text: 'hello' }], false);

			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [{ role: 'user', parts: [{ text: 'hello' }] }],
				turnComplete: false,
			});
		});

		it('uses realtime text for generation-triggering content on Gemini 3 live models', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview' },
				{},
			);
			await transport.connect();

			transport.sendContent([
				{ role: 'user', text: ' Say hello. ' },
				{ role: 'user', text: 'Ask one question.' },
			]);

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
				text: 'Say hello.\n\nAsk one question.',
			});
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});

		it('uses realtime text for generation-triggering content on Gemini 2.5 native-audio live models', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', model: 'gemini-2.5-flash-native-audio-preview-12-2025' },
				{},
			);
			await transport.connect();

			transport.sendContent([{ role: 'user', text: 'Say hello.' }]);

			expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({ text: 'Say hello.' });
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});

		it('keeps non-generating content on clientContent for Gemini 3 live models', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview' },
				{},
			);
			await transport.connect();

			transport.sendContent([{ role: 'user', text: 'prefill context' }], false);

			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [{ role: 'user', parts: [{ text: 'prefill context' }] }],
				turnComplete: false,
			});
		});
	});

	describe('sendFile', () => {
		it('wraps in inlineData format', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendFile('base64imgdata', 'image/png');

			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [
					{
						role: 'user',
						parts: [{ inlineData: { data: 'base64imgdata', mimeType: 'image/png' } }],
					},
				],
				turnComplete: false,
			});
		});
	});

	describe('sendToolResult', () => {
		it('wraps in functionResponses format', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendToolResult({
				id: 'fc_1',
				name: 'search',
				result: { results: ['a', 'b'] },
				scheduling: 'when_idle',
			});

			expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
				functionResponses: [{ id: 'fc_1', name: 'search', response: { results: ['a', 'b'] } }],
			});
		});

		it('wraps primitive results into an object payload', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			transport.sendToolResult({
				id: 'fc_2',
				name: 'ask_openclaw',
				result: 'done',
				scheduling: 'when_idle',
			});

			expect(mockSession.sendToolResponse).toHaveBeenCalledWith({
				functionResponses: [{ id: 'fc_2', name: 'ask_openclaw', response: { result: 'done' } }],
			});
		});
	});

	describe('transferSession', () => {
		it('disconnects, reconnects, and replays conversation history', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.sendClientContent.mockClear();

			await transport.transferSession(
				{ instructions: 'New agent', tools: [] },
				{
					conversationHistory: [
						{ type: 'text', role: 'user', text: 'hello' },
						{ type: 'text', role: 'assistant', text: 'hi' },
					],
				},
			);

			// Should have reconnected (close + connect)
			expect(mockSession.close).toHaveBeenCalled();

			// Should have replayed the conversation history
			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [
					{ role: 'user', parts: [{ text: 'hello' }] },
					{ role: 'model', parts: [{ text: 'hi' }] },
				],
				turnComplete: false,
			});
		});

		it('replay serializes tool history as Gemini Live-safe text context', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.sendClientContent.mockClear();

			await transport.transferSession(
				{ instructions: 'New agent', tools: [] },
				{
					conversationHistory: [
						{ type: 'tool_call', id: 'tc_1', name: 'ask_openclaw', args: { task: 'x' } },
						{ type: 'tool_result', id: 'tc_1', name: 'ask_openclaw', result: 'sent' },
					],
				},
			);

			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [
					{
						role: 'user',
						parts: [{ text: '[Previous tool call: ask_openclaw({"task":"x"})]' }],
					},
					{
						role: 'user',
						parts: [{ text: '[Previous tool result for ask_openclaw: "sent"]' }],
					},
				],
				turnComplete: false,
			});

			const replayPayload = mockSession.sendClientContent.mock.calls[0][0];
			expect(JSON.stringify(replayPayload)).not.toContain('functionCall');
			expect(JSON.stringify(replayPayload)).not.toContain('functionResponse');
		});

		it('skips transfer history replay when resuming an existing Gemini session', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'handle_transfer_resume', resumable: true },
			});

			mockSession.sendClientContent.mockClear();
			await transport.transferSession(
				{ instructions: 'New agent', tools: [] },
				{
					conversationHistory: [
						{ type: 'text', role: 'user', text: 'hello' },
						{ type: 'tool_call', id: 'tc_1', name: 'search', args: { query: 'x' } },
					],
				},
			);

			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'handle_transfer_resume' });
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
		});

		it('applies responseModality from transferSession before reconnect', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model: 'gemini-2.5-flash',
			});
			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({ responseModalities: ['AUDIO'] }),
			);

			await transport.transferSession({ responseModality: 'text' }, { conversationHistory: [] });
			expect(capturedConnectConfig.config).toEqual(
				expect.objectContaining({ responseModalities: ['AUDIO', 'TEXT'] }),
			);
		});
	});

	describe('LLMTransport callback properties', () => {
		it('fires callback properties alongside constructor callbacks', async () => {
			const constructorCb = vi.fn();
			const propertyCb = vi.fn();

			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onTurnComplete: constructorCb },
			);
			transport.onTurnComplete = propertyCb;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ serverContent: { turnComplete: true } });

			expect(constructorCb).toHaveBeenCalledOnce();
			expect(propertyCb).toHaveBeenCalledOnce();
		});

		it('fires onSessionReady alongside constructor onSetupComplete', async () => {
			const onSetupComplete = vi.fn();
			const onSessionReady = vi.fn();

			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onSetupComplete });
			transport.onSessionReady = onSessionReady;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ setupComplete: { sessionId: 'sid_dual' } });

			expect(onSetupComplete).toHaveBeenCalledWith('sid_dual');
			expect(onSessionReady).toHaveBeenCalledWith('sid_dual');
		});
	});

	describe('no-op methods', () => {
		it('commitAudio and clearAudio are no-ops', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			// Should not throw
			transport.commitAudio();
			transport.clearAudio();
		});

		it('triggerGeneration is a no-op', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.triggerGeneration('some instructions');
		});
	});

	describe('onModelTurnStart', () => {
		it('fires on first modelTurn.parts per turn', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onModelTurnStart });
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// First modelTurn — should fire
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});

			// Constructor callback + property callback = 2 calls
			expect(onModelTurnStart).toHaveBeenCalledTimes(2);
		});

		it('fires only once per turn (not on subsequent modelTurn.parts)', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// First modelTurn — fires
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'chunk1' } }] },
				},
			});
			// Second modelTurn in same turn — does NOT fire again
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'chunk2' } }] },
				},
			});

			expect(onModelTurnStart).toHaveBeenCalledOnce();
		});

		it('fires on first toolCall if no audio preceded it', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			cbs.onmessage({
				toolCall: {
					functionCalls: [{ id: 'fc_1', name: 'search', args: { q: 'test' } }],
				},
			});

			expect(onModelTurnStart).toHaveBeenCalledOnce();
		});

		it('does not fire on toolCall if audio already fired it', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// Audio fires first
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});
			expect(onModelTurnStart).toHaveBeenCalledOnce();

			// Tool call should not fire again
			cbs.onmessage({
				toolCall: {
					functionCalls: [{ id: 'fc_1', name: 'search', args: {} }],
				},
			});
			expect(onModelTurnStart).toHaveBeenCalledOnce();
		});

		it('resets on turnComplete so next turn fires again', async () => {
			const onModelTurnStart = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onModelTurnStart = onModelTurnStart;
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// Turn 1
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});
			cbs.onmessage({ serverContent: { turnComplete: true } });

			// Turn 2
			cbs.onmessage({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] },
				},
			});

			expect(onModelTurnStart).toHaveBeenCalledTimes(2);
		});
	});

	// P2: sessionResumption refactor — see dev_docs/framework/design-context-caching.md
	describe('sessionResumption (P2)', () => {
		it('sessionResumption: false omits the field from connectConfig', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', sessionResumption: false },
				{},
			);
			await transport.connect();
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toBeUndefined();
		});

		it('sessionResumption.handle flows through', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', sessionResumption: { handle: 'h_initial' } },
				{},
			);
			await transport.connect();
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'h_initial' });
		});

		it('legacy resumptionHandle still works (deprecation alias)', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const transport = new GeminiLiveTransport(
				// biome-ignore lint/suspicious/noExplicitAny: testing deprecated path
				{ apiKey: 'test-key', resumptionHandle: 'h_legacy' } as any,
				{},
			);
			await transport.connect();
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'h_legacy' });
			// deprecation warn fires (latched module-level — exact call count
			// across tests is implementation-dependent, just ensure ≥0 and don't
			// crash when the latch already fired in another test)
			expect(warnSpy).toBeDefined();
			warnSpy.mockRestore();
		});

		it('sessionResumption.handle wins over legacy resumptionHandle when both set', async () => {
			const transport = new GeminiLiveTransport(
				{
					apiKey: 'test-key',
					sessionResumption: { handle: 'h_new' },
					resumptionHandle: 'h_legacy',
					// biome-ignore lint/suspicious/noExplicitAny: testing deprecated path
				} as any,
				{},
			);
			await transport.connect();
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'h_new' });
		});

		it('default (omitted) → sessionResumption: {} (fresh resumable session)', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({});
		});

		it('resumable: true update updates effectiveResumptionHandle for next reconnect', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'h_server', resumable: true },
			});

			await transport.reconnect();
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({ handle: 'h_server' });
		});

		it('resumable: false update clears the handle → next reconnect uses {} (fresh)', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', sessionResumption: { handle: 'h_initial' } },
				{},
			);
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				sessionResumptionUpdate: { newHandle: 'h_terminal', resumable: false },
			});

			expect(transport.getLastNonResumableAt()).not.toBeNull();

			await transport.reconnect();
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toEqual({});
		});

		it('sessionResumption: false overrides incoming reconnect state handle', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', sessionResumption: false },
				{},
			);
			await transport.connect();

			await transport.reconnect({ resumptionHandle: 'h_from_state' });
			const config = capturedConnectConfig.config as Record<string, unknown>;
			expect(config.sessionResumption).toBeUndefined();
		});
	});
});

describe('resolveGeminiRealtimeInputConfig', () => {
	it('returns the default when user is undefined', () => {
		const result = resolveGeminiRealtimeInputConfig(undefined);
		expect(result).toEqual(DEFAULT_GEMINI_REALTIME_INPUT_CONFIG);
		expect(
			(result as { automaticActivityDetection: { endOfSpeechSensitivity: string } })
				.automaticActivityDetection.endOfSpeechSensitivity,
		).toBe('END_SENSITIVITY_HIGH');
	});

	it('deep-merges partial automaticActivityDetection — user fields win, defaults fill in', () => {
		const result = resolveGeminiRealtimeInputConfig({
			automaticActivityDetection: { silenceDurationMs: 800 },
		});
		expect((result as Record<string, Record<string, unknown>>).automaticActivityDetection).toEqual({
			endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
			silenceDurationMs: 800,
		});
	});

	it('preserves default silenceDurationMs when user only overrides sensitivity', () => {
		const result = resolveGeminiRealtimeInputConfig({
			automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_LOW' },
		});
		expect((result as Record<string, Record<string, unknown>>).automaticActivityDetection).toEqual({
			endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
			silenceDurationMs: 500,
		});
	});

	it('retains a user-supplied disabled flag without dropping default keys', () => {
		const result = resolveGeminiRealtimeInputConfig({
			automaticActivityDetection: { disabled: true },
		});
		const aad = (result as Record<string, Record<string, unknown>>).automaticActivityDetection;
		expect(aad.disabled).toBe(true);
		expect(aad.endOfSpeechSensitivity).toBe('END_SENSITIVITY_HIGH');
		expect(aad.silenceDurationMs).toBe(500);
	});

	it('preserves user-provided top-level keys outside automaticActivityDetection', () => {
		const result = resolveGeminiRealtimeInputConfig({
			automaticActivityDetection: { silenceDurationMs: 800 },
			activityHandling: 'NO_INTERRUPTION',
		} as Record<string, unknown>);
		expect((result as Record<string, unknown>).activityHandling).toBe('NO_INTERRUPTION');
		expect(
			(result as Record<string, Record<string, unknown>>).automaticActivityDetection
				.endOfSpeechSensitivity,
		).toBe('END_SENSITIVITY_HIGH');
	});

	it('does not mutate the default constant', () => {
		const before = JSON.stringify(DEFAULT_GEMINI_REALTIME_INPUT_CONFIG);
		resolveGeminiRealtimeInputConfig({
			automaticActivityDetection: { silenceDurationMs: 999 },
		});
		expect(JSON.stringify(DEFAULT_GEMINI_REALTIME_INPUT_CONFIG)).toBe(before);
	});
});
