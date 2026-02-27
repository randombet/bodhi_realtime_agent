// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GeminiLiveTransport } from '../../src/transport/gemini-live-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';

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

			expect(capturedConnectConfig.model).toBe('gemini-live-2.5-flash-preview');
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
				media: { data: 'base64audiodata', mimeType: 'audio/pcm;rate=16000' },
			});
		});

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
});
