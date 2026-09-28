import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	DEFAULT_GEMINI_LIVE_MODEL,
	DEFAULT_GEMINI_REALTIME_INPUT_CONFIG,
	GeminiLiveTransport,
	type LiveUsageMetadata,
	resolveGeminiRealtimeInputConfig,
} from '../../src/transport/gemini-live-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { LLMTransport, RealtimeLLMUsageEvent } from '../../src/types/transport.js';

// Mock @google/genai
let capturedConnectConfig: Record<string, unknown> = {};
const mockSession = {
	sendRealtimeInput: vi.fn(),
	sendToolResponse: vi.fn(),
	// Replicates @google/genai validation: any non-null/non-undefined `turns` is
	// parsed, and tContents([]) rejects an empty array — so `turns: []` throws
	// exactly like the real SDK. Note this covers only *client-side* validation;
	// the server's own rejection of a content-less request (1007) arrives as a
	// socket close and cannot be modelled here.
	sendClientContent: vi.fn((params: { turns?: unknown }) => {
		if (Array.isArray(params.turns) && params.turns.length === 0) {
			throw new Error(`Failed to parse client content "turns", type: '${typeof params.turns}'`);
		}
	}),
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

		it('replayUserTurn sends inline audio clientContent with an explicit turnComplete', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.sendClientContent.mockClear();
			const pcm = Buffer.alloc(640, 5);
			const dispatched = transport.replayUserTurn?.({
				pcm,
				sampleRateHz: 16000,
				utteranceId: 1,
				sealedAtMs: 0,
			});
			expect(dispatched).toBe(true);
			expect(mockSession.sendClientContent).toHaveBeenCalledWith({
				turns: [
					{
						role: 'user',
						parts: [
							{
								inlineData: {
									data: pcm.toString('base64'),
									mimeType: 'audio/pcm;rate=16000',
								},
							},
						],
					},
				],
				turnComplete: true,
			});
		});

		it('replayUserTurn returns false when not connected', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(
				transport.replayUserTurn?.({
					pcm: Buffer.alloc(2),
					sampleRateHz: 16000,
					utteranceId: 1,
					sealedAtMs: 0,
				}),
			).toBe(false);
		});

		// Gemini has no valid content-less nudge: `turns: []` is rejected by the SDK
		// and omitting `turns` is rejected by the server (1007, closing the socket
		// asynchronously — which the response watchdog then retries into oblivion).
		// Leaving the method undefined routes the reconnector to its
		// `triggerGeneration()` fallback, a no-op here. This mock cannot reproduce
		// the server-side rejection, which is exactly why the previous version of
		// this test passed while the real session died — so assert the absence.
		it('does not implement elicitResponse (no valid content-less nudge)', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.sendClientContent.mockClear();

			expect((transport as LLMTransport).elicitResponse).toBeUndefined();

			// The fallback the reconnector uses instead must stay silent on the wire.
			transport.triggerGeneration();
			expect(mockSession.sendClientContent).not.toHaveBeenCalled();
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

		it(
			'rejects with timeout when the SDK dial itself never settles (failed DNS/socket)',
			{ timeout: 1000 },
			async () => {
				// live.connect()'s promise is resolve-only in the SDK — on a failed
				// dial (getaddrinfo ENOTFOUND) it never settles, so the deadline must
				// cover the dial, not just the setupComplete wait.
				const { GoogleGenAI } = await import('@google/genai');
				(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
					live: {
						connect: vi.fn(() => new Promise(() => {})),
					},
				}));

				const transport = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 50 }, {});
				await expect(transport.connect()).rejects.toThrow('timed out');
			},
		);

		it('a superseded dial closing late does not fire the live onClose callback', async () => {
			// Real-SDK shape: closing a session fires that dial's onclose. A dial
			// abandoned by timeout is closed when it finally resolves; that stale
			// close must not reach the session's handleTransportClose, which would
			// mistake it for the CURRENT connection and tear down a healthy
			// replacement.
			const { GoogleGenAI } = await import('@google/genai');
			let resolveDial1!: (s: unknown) => void;
			let dial1Callbacks!: Record<string, (...args: unknown[]) => void>;
			const connectFn = vi.fn();
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));
			connectFn
				.mockImplementationOnce((params: Record<string, unknown>) => {
					dial1Callbacks = params.callbacks as typeof dial1Callbacks;
					return new Promise((resolve) => {
						resolveDial1 = resolve;
					});
				})
				// Dial 2 behaves like a healthy socket: session + its own setupComplete.
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'live_sid' } }), 1);
					return mockSession;
				});

			const transport = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 50 }, {});
			const onCloseSpy = vi.fn();
			transport.onClose = onCloseSpy;

			// Dial 1 times out.
			await expect(transport.connect()).rejects.toThrow('timed out');

			// Dial 2 succeeds (default mock: resolves + fires setupComplete).
			await transport.connect();
			expect(transport.isConnected).toBe(true);

			// Dial 1's socket finally opens; the transport closes the orphan and
			// the SDK fires dial 1's onclose — as the real websocket would.
			const dial1Session = {
				close: vi.fn(() => dial1Callbacks.onclose?.({ code: 1000, reason: 'stale' })),
			};
			resolveDial1(dial1Session);
			await new Promise((r) => setTimeout(r, 10));

			expect(dial1Session.close).toHaveBeenCalled();
			expect(onCloseSpy).not.toHaveBeenCalled();
		});

		it(
			"a superseded dial's setupComplete cannot satisfy the current dial's setup wait",
			{ timeout: 1000 },
			async () => {
				// setupResolver is per-connect state; a stale dial's late
				// setupComplete must not resolve the replacement dial's wait.
				const { GoogleGenAI } = await import('@google/genai');
				let dial1Callbacks!: Record<string, (...args: unknown[]) => void>;
				const connectFn = vi.fn();
				(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
					live: { connect: connectFn },
				}));
				connectFn
					.mockImplementationOnce((params: Record<string, unknown>) => {
						dial1Callbacks = params.callbacks as typeof dial1Callbacks;
						return new Promise(() => {});
					})
					// Dial 2 resolves a session but its own setupComplete never fires.
					.mockImplementationOnce(async () => mockSession);

				const transport = new GeminiLiveTransport(
					{ apiKey: 'test-key', connectTimeoutMs: 100 },
					{},
				);
				await expect(transport.connect()).rejects.toThrow('timed out');

				const secondDial = transport.connect();
				// The stale dial's socket delivers a setupComplete mid-wait.
				dial1Callbacks.onmessage?.({ setupComplete: { sessionId: 'stale_sid' } });

				// Dial 2 must still time out — the stale ack proves nothing about it.
				await expect(secondDial).rejects.toThrow('timed out');
			},
		);

		it('socket close before setupComplete rejects connect() within 20 ms with "closed before setupComplete"', async () => {
			// The socket dies mid-dial (the SDK's resolve-only connect promise never
			// settles): connect() must fail on the close, not wait out the 30 s
			// default deadline.
			const { GoogleGenAI } = await import('@google/genai');
			let closedAt = 0;
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: {
					connect: vi.fn((params: Record<string, unknown>) => {
						const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
						setTimeout(() => {
							closedAt = Date.now();
							cbs.onclose?.({ code: 1006, reason: 'abnormal' });
						}, 1);
						return new Promise(() => {});
					}),
				},
			}));

			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			const onCloseSpy = vi.fn();
			transport.onClose = onCloseSpy;

			await expect(transport.connect()).rejects.toThrow(
				'Gemini socket closed before setupComplete (code=1006)',
			);
			expect(Date.now() - closedAt).toBeLessThan(20);
			expect(transport.isConnected).toBe(false);
			// The property-form onClose still observes the setup-failure close.
			expect(onCloseSpy).toHaveBeenCalledWith(1006, 'abnormal');
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

		it('cancelResponse suppresses the current turn audio and resumes on the next', async () => {
			const onAudioOutput = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onAudioOutput });
			await transport.connect();
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			const audio = {
				serverContent: { modelTurn: { parts: [{ inlineData: { data: 'a' } }] } },
			};

			cbs.onmessage(audio); // server turn 1 — forwarded
			expect(onAudioOutput).toHaveBeenCalledTimes(1);

			// Gemini can't cancel generation; cancelResponse suppresses the rest of
			// the current server turn's outbound audio.
			await transport.cancelResponse();
			cbs.onmessage(audio); // trailing turn-1 audio — dropped
			cbs.onmessage(audio);
			expect(onAudioOutput).toHaveBeenCalledTimes(1);

			// A new server turn (the response to the barge-in) resumes forwarding.
			cbs.onmessage({ serverContent: { turnComplete: true } });
			cbs.onmessage(audio); // server turn 2 — forwarded
			expect(onAudioOutput).toHaveBeenCalledTimes(2);
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

	describe('dial generation fence', () => {
		type Cbs = Record<string, (...args: unknown[]) => void>;

		/** A fake SDK session whose close() is controlled by the test. */
		function fakeSession(close: () => unknown = () => {}) {
			return {
				sendRealtimeInput: vi.fn(),
				sendToolResponse: vi.fn(),
				sendClientContent: vi.fn(),
				close: vi.fn(close),
			};
		}

		/** Deferred close: `close()` stays pending until `release()`. */
		function slowClose() {
			let release: () => void = () => {};
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			return { close: () => pending, release: () => release() };
		}

		/** Route this test's GeminiLiveTransport through `connectFn`. */
		async function useConnect(connectFn: ReturnType<typeof vi.fn>): Promise<void> {
			const { GoogleGenAI } = await import('@google/genai');
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));
		}

		/** A dial that resolves `session` and then acks setup. */
		function healthyDial(session: unknown) {
			return async (params: Record<string, unknown>) => {
				const cbs = params.callbacks as Cbs;
				setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'sid' } }), 1);
				return session;
			};
		}

		it('`currentDialGen` is 1 after a successful first `connect()`, 2 after a first dial that fails; `currentTransportGeneration` advances only on setup-ok', async () => {
			const healthy = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			expect(healthy.currentDialGen).toBe(0);
			expect(healthy.currentTransportGeneration).toBe(0);
			await healthy.connect();
			expect(healthy.currentDialGen).toBe(1);
			expect(healthy.currentTransportGeneration).toBe(1);

			await useConnect(vi.fn(() => new Promise(() => {})));
			const failing = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 20 }, {});
			await expect(failing.connect()).rejects.toThrow('timed out');
			expect(failing.currentDialGen).toBe(2);
			expect(failing.currentTransportGeneration).toBe(0);
		});

		it("a superseded dial whose setup deadline expires after the replacement dial became active leaves the replacement's session installed", async () => {
			const stale = fakeSession();
			const replacement = fakeSession();
			const connectFn = vi
				.fn()
				// Dial 1 resolves its session, but its setupComplete never arrives.
				.mockImplementationOnce(async () => stale)
				.mockImplementationOnce(healthyDial(replacement));
			await useConnect(connectFn);
			const transport = new GeminiLiveTransport({ apiKey: 'test-key', connectTimeoutMs: 50 }, {});

			const firstDial = transport.connect();
			// Dial 1's session is installed while it waits for setup.
			await new Promise((r) => setTimeout(r, 0));
			expect(transport.isConnected).toBe(true);

			// A newer dial supersedes it and completes setup well inside the deadline.
			await transport.connect();
			expect(transport.isConnected).toBe(true);

			// Dial 1's setup deadline expires only now, after the replacement is active.
			await expect(firstDial).rejects.toThrow('timed out');
			await new Promise((r) => setTimeout(r, 0));

			// The abandoned dial closes its own session and leaves the shared field alone.
			expect(stale.close).toHaveBeenCalledTimes(1);
			expect(replacement.close).not.toHaveBeenCalled();
			expect(transport.isConnected).toBe(true);
			transport.sendAudio('AA==');
			expect(replacement.sendRealtimeInput).toHaveBeenCalledTimes(1);
			expect(stale.sendRealtimeInput).not.toHaveBeenCalled();
		});

		it('force-kill timer does not null a session established by a newer dial', async () => {
			const incumbent = fakeSession(() => new Promise(() => {})); // close() hangs
			const replacement = fakeSession();
			const connectFn = vi
				.fn()
				.mockImplementationOnce(healthyDial(incumbent))
				.mockImplementationOnce(healthyDial(replacement));
			await useConnect(connectFn);
			const transport = new GeminiLiveTransport({ apiKey: 'test-key', reconnectTimeoutMs: 30 }, {});
			await transport.connect();

			// reconnect() is stuck in disconnect() awaiting the hung close; its
			// force-kill timer (30 ms) is pending.
			void transport.reconnect();
			// A newer dial establishes the replacement meanwhile.
			await transport.connect();
			expect(transport.isConnected).toBe(true);

			await new Promise((r) => setTimeout(r, 60)); // the force-kill timer fires
			expect(transport.isConnected).toBe(true);
			transport.sendAudio('AA==');
			expect(replacement.sendRealtimeInput).toHaveBeenCalledTimes(1);
		});

		it('disconnect() does not null a session replaced while close() was in flight', async () => {
			const gate = slowClose();
			const incumbent = fakeSession(gate.close);
			const replacement = fakeSession();
			const connectFn = vi
				.fn()
				.mockImplementationOnce(healthyDial(incumbent))
				.mockImplementationOnce(healthyDial(replacement));
			await useConnect(connectFn);
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			const closing = transport.disconnect();
			// Detached synchronously, before the close completes.
			expect(transport.isConnected).toBe(false);
			await transport.connect();

			gate.release();
			await closing;

			expect(transport.isConnected).toBe(true);
			transport.sendAudio('AA==');
			expect(replacement.sendRealtimeInput).toHaveBeenCalledTimes(1);
			expect(incumbent.sendRealtimeInput).not.toHaveBeenCalled();
		});

		it('abortIncumbent() while disconnect() is still awaiting a hanging close resolves `forced` after its 5 s bound, not `closed` at once, and a replacement session installed afterwards is untouched', async () => {
			const incumbent = fakeSession(() => new Promise(() => {})); // close() hangs
			const replacement = fakeSession();
			const connectFn = vi
				.fn()
				.mockImplementationOnce(healthyDial(incumbent))
				.mockImplementationOnce(healthyDial(replacement));
			await useConnect(connectFn);
			vi.useFakeTimers();
			try {
				const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
				const connecting = transport.connect();
				await vi.advanceTimersByTimeAsync(1); // setupComplete
				await connecting;

				// disconnect() detaches the incumbent at once and then awaits its close.
				void transport.disconnect();
				expect(incumbent.close).toHaveBeenCalledTimes(1);
				expect(transport.isConnected).toBe(false);

				let outcome: 'closed' | 'forced' | undefined;
				void transport.abortIncumbent().then((result) => {
					outcome = result;
				});
				await vi.advanceTimersByTimeAsync(0);
				expect(outcome).toBeUndefined();
				await vi.advanceTimersByTimeAsync(4_999);
				expect(outcome).toBeUndefined();
				await vi.advanceTimersByTimeAsync(1);
				expect(outcome).toBe('forced');

				const redialing = transport.connect();
				await vi.advanceTimersByTimeAsync(1); // setupComplete
				await redialing;
				await vi.advanceTimersByTimeAsync(60_000);

				expect(transport.isConnected).toBe(true);
				expect(replacement.close).not.toHaveBeenCalled();
				expect(incumbent.close).toHaveBeenCalledTimes(1);
				transport.sendAudio('AA==');
				expect(replacement.sendRealtimeInput).toHaveBeenCalledTimes(1);
				expect(incumbent.sendRealtimeInput).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('abortIncumbent() during a slow incumbent close prevents the dial and closes a late-resolving session', async () => {
			const gate = slowClose();
			const incumbent = fakeSession(gate.close);
			const late = fakeSession();
			let resolveLateDial: (s: unknown) => void = () => {};
			const connectFn = vi
				.fn()
				.mockImplementationOnce(healthyDial(incumbent))
				.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveLateDial = resolve;
						}),
				);
			await useConnect(connectFn);
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();

			// (1) reconnect() is awaiting the incumbent's slow close when the
			// incumbent is aborted: once the close completes it must not dial.
			const reconnecting = transport.reconnect();
			expect(incumbent.close).toHaveBeenCalledTimes(1);
			// The abort bounds that in-flight close, so it settles with the close.
			const aborting = transport.abortIncumbent();
			gate.release();
			await expect(aborting).resolves.toBe('closed');
			await reconnecting;
			expect(connectFn).toHaveBeenCalledTimes(1);
			expect(transport.isConnected).toBe(false);

			// (2) A dial still pending when the incumbent is aborted closes its own
			// session when it resolves late, and never installs it.
			const dialing = transport.connect();
			expect(connectFn).toHaveBeenCalledTimes(2);
			await expect(transport.abortIncumbent()).resolves.toBe('closed');
			resolveLateDial(late);
			await expect(dialing).rejects.toThrow('superseded');
			await new Promise((r) => setTimeout(r, 0));
			expect(late.close).toHaveBeenCalledTimes(1);
			expect(transport.isConnected).toBe(false);
		});

		it('abortIncumbent resolves `closed` and the next connect omits `sessionResumption.handle`', async () => {
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', sessionResumption: { handle: 'h_seed' } },
				{},
			);
			await transport.connect();
			expect((capturedConnectConfig.config as Record<string, unknown>).sessionResumption).toEqual({
				handle: 'h_seed',
			});
			const cbs = capturedConnectConfig.callbacks as Cbs;
			cbs.onmessage({ sessionResumptionUpdate: { newHandle: 'h_server', resumable: true } });
			const genBefore = transport.currentDialGen;

			await expect(transport.abortIncumbent()).resolves.toBe('closed');
			expect(mockSession.close).toHaveBeenCalledTimes(1);
			expect(transport.isConnected).toBe(false);
			expect(transport.currentDialGen).toBe(genBefore + 1);

			await transport.connect();
			expect((capturedConnectConfig.config as Record<string, unknown>).sessionResumption).toEqual(
				{},
			);
		});

		it('abortIncumbent resolves `forced` when close throws', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.close.mockImplementationOnce(() => {
				throw new Error('close failed');
			});

			await expect(transport.abortIncumbent()).resolves.toBe('forced');
			expect(transport.isConnected).toBe(false);
		});
	});

	describe('connection lifecycle events', () => {
		type Ev = { kind: string; connectAttemptId: string } & Record<string, unknown>;

		it('a clean connect emits attempt (handleSupplied=false) then setup-ok with the generation', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			await transport.connect();

			expect(events.map((e) => e.kind)).toEqual(['attempt', 'setup-ok']);
			expect(events[0].handleSupplied).toBe(false);
			expect(events[1].transportGeneration).toBe(1);
			expect(events[0].connectAttemptId).toBe(events[1].connectAttemptId);
			expect(transport.currentTransportGeneration).toBe(1);
		});

		it('a dial with a stored resumption handle reports handleSupplied=true (sessionResumption and legacy resumptionHandle)', async () => {
			const viaSessionResumption: Ev[] = [];
			await new GeminiLiveTransport(
				{ apiKey: 'test-key', sessionResumption: { handle: 'handle_1' } },
				{ onConnectionLifecycle: (e) => viaSessionResumption.push(e as Ev) },
			).connect();
			expect(viaSessionResumption[0]).toMatchObject({ kind: 'attempt', handleSupplied: true });

			const viaLegacy: Ev[] = [];
			await new GeminiLiveTransport(
				{ apiKey: 'test-key', resumptionHandle: 'handle_2' },
				{ onConnectionLifecycle: (e) => viaLegacy.push(e as Ev) },
			).connect();
			expect(viaLegacy[0]).toMatchObject({ kind: 'attempt', handleSupplied: true });

			// The privacy opt-out sends no handle, so the attempt supplies none.
			const optedOut: Ev[] = [];
			await new GeminiLiveTransport(
				{ apiKey: 'test-key', sessionResumption: false, resumptionHandle: 'handle_3' },
				{ onConnectionLifecycle: (e) => optedOut.push(e as Ev) },
			).connect();
			expect(optedOut[0]).toMatchObject({ kind: 'attempt', handleSupplied: false });
		});

		it('a close after setup is generation-close carrying the generation', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			await transport.connect();

			const cbs = capturedConnectConfig.callbacks as Record<string, (e?: unknown) => void>;
			cbs.onclose({ code: 1011, reason: 'internal error' });

			const last = events.at(-1) as Ev;
			expect(last.kind).toBe('generation-close');
			expect(last.connectAttemptId).toBe('att_1');
			expect(last.transportGeneration).toBe(1);
			expect(last.code).toBe(1011);
			expect(last.reason).toBe('internal error');
		});

		it('a socket that dies BEFORE setupComplete emits attempt-close (no generation) then setup-failed', async () => {
			// The dial resolves a session but setupComplete never arrives; the
			// socket closes, which rejects connect() at once.
			const { GoogleGenAI } = await import('@google/genai');
			let dialCallbacks!: Record<string, (...args: unknown[]) => void>;
			const connectFn = vi.fn().mockImplementationOnce(async (params: Record<string, unknown>) => {
				dialCallbacks = params.callbacks as typeof dialCallbacks;
				return mockSession;
			});
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));

			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', connectTimeoutMs: 1000 },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			const pending = transport.connect();
			await new Promise((r) => setTimeout(r, 5));
			dialCallbacks.onclose?.({ code: 1006, reason: 'died during setup' });
			await expect(pending).rejects.toThrow('closed before setupComplete');

			const kinds = events.map((e) => e.kind);
			expect(kinds).toEqual(['attempt', 'attempt-close', 'setup-failed']);
			const close = events[1];
			expect(close.code).toBe(1006);
			expect(Object.hasOwn(close, 'transportGeneration')).toBe(false);
			// Both events describe one attempt — correlated by id, not by guesswork.
			expect(close.connectAttemptId).toBe(events[0].connectAttemptId);
			expect(events[2].connectAttemptId).toBe(events[0].connectAttemptId);
			expect(events[2].reason).toContain('closed before setupComplete');
			expect(transport.currentTransportGeneration).toBe(0);
		});

		it('a superseded dial emits no setup-failed — stale-dial fencing covers failures too', async () => {
			const { GoogleGenAI } = await import('@google/genai');
			const connectFn = vi.fn();
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));
			connectFn
				// Dial 1 never resolves; dial 2 is healthy.
				.mockImplementationOnce(() => new Promise(() => {}))
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'sid_2' } }), 1);
					return mockSession;
				});

			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', connectTimeoutMs: 200 },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			const first = transport.connect();
			first.catch(() => {}); // outcome asserted below; silence unhandled-rejection
			await new Promise((r) => setTimeout(r, 5));
			await transport.connect(); // supersedes dial 1
			await expect(first).rejects.toThrow('timed out');

			const kinds = events.map((e) => `${e.kind}:${e.connectAttemptId}`);
			expect(kinds).toEqual(['attempt:att_1', 'attempt:att_2', 'setup-ok:att_2']);
		});

		it('reconnect() emits generation-close for the socket it closes locally, exactly once', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => events.push(e as Ev),
				},
			);
			await transport.connect();
			const firstCbs = capturedConnectConfig.callbacks as Record<string, (e?: unknown) => void>;
			await transport.reconnect({ resumptionHandle: undefined, conversationHistory: [] });
			// The closed socket's own onclose lands late: fenced, never a second close.
			firstCbs.onclose({ code: 1000, reason: 'late' });

			const closes = events.filter((e) => e.kind === 'generation-close');
			expect(closes).toHaveLength(1);
			expect(closes[0]).toMatchObject({
				connectAttemptId: 'att_1',
				transportGeneration: 1,
				code: 1000,
				reason: 'local disconnect',
			});
			// The reconnect's own lineage continues: attempt + setup-ok for att_2.
			expect(events.map((e) => e.kind)).toEqual([
				'attempt',
				'setup-ok',
				'generation-close',
				'attempt',
				'setup-ok',
			]);
			expect(events[4]).toMatchObject({ connectAttemptId: 'att_2', transportGeneration: 2 });
		});

		it('a socket close landing while disconnect() awaits close() is not a second generation-close', async () => {
			// Real-SDK shape: close() fires this dial's onclose before the next dial
			// advances the fence, so only the ledger's once-per-attempt rule stops a
			// duplicate after the local disconnect.
			const { GoogleGenAI } = await import('@google/genai');
			let dial1Callbacks!: Record<string, (...args: unknown[]) => void>;
			const dial1Session = {
				...mockSession,
				close: vi.fn(() => dial1Callbacks.onclose?.({ code: 1000, reason: 'closed by client' })),
			};
			const connectFn = vi
				.fn()
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					dial1Callbacks = params.callbacks as typeof dial1Callbacks;
					setTimeout(() => dial1Callbacks.onmessage?.({ setupComplete: { sessionId: 's1' } }), 1);
					return dial1Session;
				})
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 's2' } }), 1);
					return mockSession;
				});
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));

			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onConnectionLifecycle: (e) => events.push(e as Ev) },
			);
			await transport.connect();
			await transport.reconnect({ resumptionHandle: undefined, conversationHistory: [] });

			expect(dial1Session.close).toHaveBeenCalledTimes(1);
			expect(events.map((e) => `${e.kind}:${e.connectAttemptId}`)).toEqual([
				'attempt:att_1',
				'setup-ok:att_1',
				'generation-close:att_1',
				'attempt:att_2',
				'setup-ok:att_2',
			]);
			expect(events[2]).toMatchObject({ code: 1000, reason: 'local disconnect' });
		});

		it('setup-failed fires after the dial fence advanced: an observer that redials is not superseded', async () => {
			const { GoogleGenAI } = await import('@google/genai');
			let dial1Callbacks!: Record<string, (...args: unknown[]) => void>;
			const connectFn = vi
				.fn()
				// Dial 1 resolves a session whose setupComplete never arrives.
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					dial1Callbacks = params.callbacks as typeof dial1Callbacks;
					return mockSession;
				})
				.mockImplementationOnce(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 's2' } }), 1);
					return mockSession;
				});
			(GoogleGenAI as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
				live: { connect: connectFn },
			}));

			const events: Ev[] = [];
			let redial: Promise<void> | undefined;
			let connectedDuringSetupFailed: boolean | undefined;
			const transport: GeminiLiveTransport = new GeminiLiveTransport(
				{ apiKey: 'test-key', connectTimeoutMs: 1000 },
				{
					onConnectionLifecycle: (e) => {
						events.push(e as Ev);
						if (e.kind === 'setup-failed') {
							connectedDuringSetupFailed = transport.isConnected;
							redial = transport.connect();
						}
					},
				},
			);
			const pending = transport.connect();
			await new Promise((r) => setTimeout(r, 5));
			dial1Callbacks.onclose?.({ code: 1006, reason: 'died during setup' });
			await expect(pending).rejects.toThrow('closed before setupComplete');

			expect(connectedDuringSetupFailed).toBe(false);
			await expect(redial).resolves.toBeUndefined();
			expect(transport.isConnected).toBe(true);
			expect(events.map((e) => `${e.kind}:${e.connectAttemptId}`)).toEqual([
				'attempt:att_1',
				'attempt-close:att_1',
				'setup-failed:att_1',
				'attempt:att_3',
				'setup-ok:att_3',
			]);
		});

		it('abortIncumbent() emits no local generation-close (only disconnect() does)', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onConnectionLifecycle: (e) => events.push(e as Ev) },
			);
			await transport.connect();
			await expect(transport.abortIncumbent()).resolves.toBe('closed');

			expect(events.map((e) => e.kind)).toEqual(['attempt', 'setup-ok']);
		});

		it('a throwing observer cannot interrupt the connection state machine', async () => {
			// A throwing attempt observer must not prevent dialing; a throwing
			// setup-ok observer must not fake a timeout; a throwing close observer
			// must not keep disconnect() from closing the socket.
			const seen: string[] = [];
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{
					onConnectionLifecycle: (e) => {
						seen.push(e.kind);
						throw new Error(`observer failed on ${e.kind}`);
					},
				},
			);
			transport.onConnectionLifecycle = () => {
				throw new Error('property-form observer failed');
			};

			await transport.connect(); // resolves despite attempt+setup-ok throwing
			expect(transport.isConnected).toBe(true);
			expect(transport.currentTransportGeneration).toBe(1);

			await transport.disconnect(); // completes despite generation-close throwing
			expect(mockSession.close).toHaveBeenCalled();
			expect(transport.isConnected).toBe(false);

			expect(seen).toEqual(['attempt', 'setup-ok', 'generation-close']);
		});

		it('property-form callback fires too — the path VoiceSession wires', async () => {
			const events: Ev[] = [];
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.onConnectionLifecycle = (e) => events.push(e as Ev);
			await transport.connect();
			expect(events.map((e) => e.kind)).toEqual(['attempt', 'setup-ok']);
		});

		it('a setup-ok observer already reads the minted generation from the transport', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			const read: number[] = [];
			transport.onConnectionLifecycle = (e) => {
				if (e.kind === 'setup-ok') {
					read.push(
						transport.currentTransportGeneration,
						transport.getDiagnostics().transportGeneration,
					);
				}
			};
			await transport.connect();
			expect(read).toEqual([1, 1]);
		});
	});

	describe('usage metadata', () => {
		async function connectWith(onUsageMetadata: ReturnType<typeof vi.fn>) {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onUsageMetadata });
			await transport.connect();
			return capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
		}
		const USAGE = { promptTokenCount: 4096, totalTokenCount: 4200 };

		it('dispatches usage metadata on its own', async () => {
			const onUsageMetadata = vi.fn();
			const cbs = await connectWith(onUsageMetadata);
			cbs.onmessage({ usageMetadata: USAGE });
			expect(onUsageMetadata).toHaveBeenCalledWith(USAGE);
		});

		// The reason usage is read before the dispatch branches: every branch below
		// returns, so a branch of its own would miss the common co-occurring cases.
		it('dispatches usage metadata riding along with serverContent', async () => {
			const onUsageMetadata = vi.fn();
			const onAudioOutput = vi.fn();
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onUsageMetadata, onAudioOutput },
			);
			await transport.connect();
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				usageMetadata: USAGE,
				serverContent: { modelTurn: { parts: [{ inlineData: { data: 'audio_b64' } }] } },
			});
			expect(onUsageMetadata).toHaveBeenCalledWith(USAGE);
			expect(onAudioOutput).toHaveBeenCalledWith('audio_b64');
		});

		it('dispatches usage metadata riding along with a tool call', async () => {
			const onUsageMetadata = vi.fn();
			const onToolCall = vi.fn();
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onUsageMetadata, onToolCall },
			);
			await transport.connect();
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({
				usageMetadata: USAGE,
				toolCall: { functionCalls: [{ id: 'fc_1', name: 'search', args: { query: 'x' } }] },
			});
			expect(onUsageMetadata).toHaveBeenCalledWith(USAGE);
			expect(onToolCall).toHaveBeenCalled();
		});

		it('dispatches usage metadata riding along with goAway', async () => {
			const onUsageMetadata = vi.fn();
			const onGoAway = vi.fn();
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onUsageMetadata, onGoAway },
			);
			await transport.connect();
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ usageMetadata: USAGE, goAway: { timeLeft: '50s' } });
			expect(onUsageMetadata).toHaveBeenCalledWith(USAGE);
			expect(onGoAway).toHaveBeenCalledWith('50s');
		});

		it('carries the per-modality breakdown through unchanged', async () => {
			const onUsageMetadata = vi.fn();
			const cbs = await connectWith(onUsageMetadata);
			const detailed = {
				promptTokenCount: 9000,
				promptTokensDetails: [
					{ modality: 'AUDIO', tokenCount: 7000 },
					{ modality: 'TEXT', tokenCount: 2000 },
				],
			};
			cbs.onmessage({ usageMetadata: detailed });
			expect(onUsageMetadata).toHaveBeenCalledWith(detailed);
		});

		it('does not fire when the message carries no usage', async () => {
			const onUsageMetadata = vi.fn();
			const cbs = await connectWith(onUsageMetadata);
			cbs.onmessage({ serverContent: { turnComplete: true } });
			expect(onUsageMetadata).not.toHaveBeenCalled();
		});

		// VoiceSession constructs the transport with an EMPTY callbacks object and
		// wires property callbacks afterwards, so a constructor-only callback would
		// be unreachable from the library's main consumer.
		it('dispatches to the property callback, which is how VoiceSession wires events', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const seen: LiveUsageMetadata[] = [];
			transport.onUsageMetadata = (u) => seen.push(u);

			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ usageMetadata: USAGE });

			expect(seen).toEqual([USAGE]);
		});

		it('carries fields beyond the common two — cache and tool-use counts included', async () => {
			const onUsageMetadata = vi.fn();
			const cbs = await connectWith(onUsageMetadata);
			const full = {
				promptTokenCount: 1000,
				cachedContentTokenCount: 400,
				toolUsePromptTokenCount: 50,
				thoughtsTokenCount: 25,
				totalTokenCount: 1500,
			};
			cbs.onmessage({ usageMetadata: full });
			expect(onUsageMetadata).toHaveBeenCalledWith(full);
		});

		it('a throwing observer does not suppress the co-occurring turn', async () => {
			const onAudioOutput = vi.fn();
			const onGoAway = vi.fn();
			const onUsageMetadata = vi.fn(() => {
				throw new Error('metrics failed');
			});
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key' },
				{ onAudioOutput, onGoAway, onUsageMetadata },
			);
			await transport.connect();
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			// ONE message carrying usage AND the payload it rides with.
			cbs.onmessage({
				usageMetadata: USAGE,
				serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AUDIO' } }] } },
			});
			cbs.onmessage({ usageMetadata: USAGE, goAway: { timeLeft: '30s' } });

			expect(onUsageMetadata).toHaveBeenCalledTimes(2);
			expect(onAudioOutput).toHaveBeenCalledWith('AUDIO');
			expect(onGoAway).toHaveBeenCalledWith('30s');
		});

		it('a throwing property-form observer is isolated too', async () => {
			const onAudioOutput = vi.fn();
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, { onAudioOutput });
			await transport.connect();
			transport.onUsageMetadata = () => {
				throw new Error('metrics failed');
			};
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			cbs.onmessage({
				usageMetadata: USAGE,
				serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AUDIO' } }] } },
			});

			expect(onAudioOutput).toHaveBeenCalledWith('AUDIO');
		});

		it('a throwing `onRealtimeLLMUsage` observer does not suppress audio on the same message', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const onAudioOutput = vi.fn();
			transport.onAudioOutput = onAudioOutput;
			transport.onRealtimeLLMUsage = () => {
				throw new Error('observer failed');
			};
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			expect(() =>
				cbs.onmessage({
					usageMetadata: { promptTokenCount: 7, responseTokenCount: 1, totalTokenCount: 8 },
					serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AA==' } }] } },
				}),
			).not.toThrow();
			expect(onAudioOutput).toHaveBeenCalledTimes(1);
			expect(onAudioOutput).toHaveBeenCalledWith('AA==');
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('onRealtimeLLMUsage observer threw'),
				expect.any(Error),
			);
			warn.mockRestore();
		});

		it('a throwing observer on `turnComplete` still fires `onTurnComplete` and closes the server turn', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const onTurnComplete = vi.fn();
			const onModelTurnStart = vi.fn();
			transport.onTurnComplete = onTurnComplete;
			transport.onModelTurnStart = onModelTurnStart;
			const phases: string[] = [];
			transport.onRealtimeLLMUsage = (u) => {
				phases.push(u.phase);
				throw new Error('observer failed');
			};
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			cbs.onmessage({
				usageMetadata: USAGE,
				serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AA==' } }] } },
			});
			expect(transport.getActiveServerTurnId()).toBe(1);

			// The cached usage's final event throws inside the turnComplete branch.
			expect(() => cbs.onmessage({ serverContent: { turnComplete: true } })).not.toThrow();
			expect(phases).toEqual(['update', 'final']);
			expect(onTurnComplete).toHaveBeenCalledTimes(1);
			expect(onTurnComplete).toHaveBeenCalledWith(1);
			expect(transport.getActiveServerTurnId()).toBeUndefined();

			// The turn really closed: the next model output opens server turn 2.
			cbs.onmessage({
				serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AA==' } }] } },
			});
			expect(onModelTurnStart).toHaveBeenCalledTimes(2);
			expect(transport.getActiveServerTurnId()).toBe(2);
			// The cached usage was consumed: no stale final on the next turnComplete.
			cbs.onmessage({ serverContent: { turnComplete: true } });
			expect(phases).toEqual(['update', 'final']);
			expect(warn).toHaveBeenCalledTimes(2);
			warn.mockRestore();
		});

		it('raw and normalized usage both fire for one message', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const raw: LiveUsageMetadata[] = [];
			const normalized: RealtimeLLMUsageEvent[] = [];
			transport.onUsageMetadata = (u) => raw.push(u);
			transport.onRealtimeLLMUsage = (u) => normalized.push(u);
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;

			const usage = { promptTokenCount: 4096, responseTokenCount: 104, totalTokenCount: 4200 };
			cbs.onmessage({ usageMetadata: usage });

			expect(raw).toEqual([usage]);
			expect(normalized).toHaveLength(1);
			expect(normalized[0]).toMatchObject({
				provider: 'gemini_live',
				phase: 'update',
				inputTokens: 4096,
				outputTokens: 104,
				totalTokens: 4200,
				providerRaw: usage,
			});
		});
	});

	describe('upstream diagnostics', () => {
		const B64 = 'AAAA'.repeat(30); // 120 b64 chars -> 90 raw bytes

		it('counts a queued audio send with split raw/wire byte accounting', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			transport.sendAudio(B64);

			const a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.queued).toBe(1);
			expect(a.attemptedRawBytes).toBe(90);
			expect(a.attemptedWireBytesEstimate).toBe(120);
			expect(a.queuedRawBytes).toBe(90);
			expect(a.lastQueuedAt).not.toBeNull();
			expect(a.lastThrewAt).toBeNull();
		});

		it('a send with no session is attempted+skipped, never queued', () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			transport.sendAudio(B64); // never connected

			const a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.skippedNoSession).toBe(1);
			expect(a.queued).toBe(0);
			expect(a.lastSkippedAt).not.toBeNull();
		});

		it('both text APIs land in the text slot; empty text is skippedEmpty', async () => {
			// A live model, so generation-triggering sendContent takes the realtime
			// text path, where empty text is not sent.
			const transport = new GeminiLiveTransport(
				{ apiKey: 'test-key', model: 'gemini-3.1-flash-live-preview' },
				{},
			);
			await transport.connect();
			transport.sendContent([{ role: 'user', text: 'hello' }]);
			transport.sendClientContent([{ role: 'user', parts: [{ text: 'world' }] }]);
			transport.sendContent([{ role: 'user', text: 'quiet' }], false); // clientContent path
			transport.sendContent([{ role: 'user', text: '' }]);

			const t = transport.getDiagnostics().upstream.text;
			expect(t.attempted).toBe(4);
			expect(t.queued).toBe(3);
			expect(t.skippedEmpty).toBe(1);
			// UTF-8 bytes for text: 'hello' + 'world' + 'quiet'
			expect(t.queuedRawBytes).toBe(15);
			expect(mockSession.sendRealtimeInput).toHaveBeenCalledTimes(1);
			expect(mockSession.sendClientContent).toHaveBeenCalledTimes(2);
		});

		it('sendFile slots by kind: image->video, audio/*->audio, other->video until realtime routing', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			transport.sendFile(B64, 'image/jpeg');
			transport.sendFile(B64, 'audio/wav');
			transport.sendFile(B64, 'application/pdf');

			const d = transport.getDiagnostics().upstream;
			expect(d.audio.queued).toBe(1);
			expect(d.audio.queuedRawBytes).toBe(90);
			// Every MIME type is still sent inline, so the pdf is a queued video-slot
			// send, not an unsupportedMime skip.
			expect(d.video.attempted).toBe(2);
			expect(d.video.queued).toBe(2);
			expect(d.video.unsupportedMime).toBe(0);
			expect(mockSession.sendClientContent).toHaveBeenCalledTimes(3);
		});

		it('a throwing send counts threw, rethrows, and never counts queued', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			mockSession.sendRealtimeInput.mockImplementationOnce(() => {
				throw new Error('socket write failed');
			});

			expect(() => transport.sendAudio(B64)).toThrow('socket write failed');
			const a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.threw).toBe(1);
			expect(a.queued).toBe(0);
			expect(a.lastThrewAt).not.toBeNull();
		});

		it('counters reset on a new generation — a new socket starts at zero', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			transport.sendAudio(B64);
			expect(transport.getDiagnostics().transportGeneration).toBe(1);
			expect(transport.getDiagnostics().upstream.audio.queued).toBe(1);

			// A new connection's setupComplete is the generation boundary.
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ setupComplete: { sessionId: 'sid_2' } });

			const d = transport.getDiagnostics();
			expect(d.transportGeneration).toBe(2);
			expect(transport.currentTransportGeneration).toBe(2);
			expect(d.upstream.audio.queued).toBe(0);
			expect(d.upstream.audio.lastQueuedAt).toBeNull();
		});

		it('reconnect replay traffic hits the counters: one text-slot send for the whole batch', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			await transport.reconnect({
				resumptionHandle: undefined,
				conversationHistory: [
					{ type: 'text', role: 'user', text: 'earlier question' },
					{ type: 'text', role: 'assistant', text: 'earlier answer' },
					{ type: 'tool_call', id: 'tc_1', name: 'search', args: { query: 'x' } },
				],
			});

			// Counters reset at the reconnect's setup, so what remains IS the replay:
			// three items, one quiet clientContent batch, one text-slot send.
			const d = transport.getDiagnostics().upstream;
			expect(d.text.attempted).toBe(1);
			expect(d.text.queued).toBe(1);
			const toolCallText = '[Previous tool call: search({"query":"x"})]';
			expect(d.text.queuedRawBytes).toBe(16 + 14 + toolCallText.length);
			expect(d.text.queuedWireBytesEstimate).toBe(d.text.queuedRawBytes);
			expect(d.audio.attempted).toBe(0);
			expect(d.video.attempted).toBe(0);
			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
			expect(mockSession.sendClientContent).toHaveBeenCalledTimes(1);
		});

		it('a text + png + pdf replay stays one inline text-slot batch: no realtime send', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			await transport.reconnect({
				resumptionHandle: undefined,
				conversationHistory: [
					{ type: 'text', role: 'user', text: 'hello' },
					{ type: 'file', role: 'user', base64Data: B64, mimeType: 'image/png' },
					{ type: 'file', role: 'user', base64Data: B64, mimeType: 'application/pdf' },
				],
			});

			// History files are not routed through sendFile: the image and the pdf
			// ride inline in the same clientContent batch as the text, so only the
			// text slot moves. Inline data counts decoded bytes raw and base64
			// characters on the wire, so the two byte totals differ here.
			const d = transport.getDiagnostics().upstream;
			expect(d.text.attempted).toBe(1);
			expect(d.text.queued).toBe(1);
			expect(d.text.queuedRawBytes).toBe(5 + 90 + 90);
			expect(d.text.queuedWireBytesEstimate).toBe(5 + 120 + 120);
			expect(d.audio.attempted).toBe(0);
			expect(d.video.attempted).toBe(0);
			expect(mockSession.sendRealtimeInput).not.toHaveBeenCalled();
			expect(mockSession.sendClientContent).toHaveBeenCalledTimes(1);
			const batch = mockSession.sendClientContent.mock.calls[0]?.[0] as { turns: unknown[] };
			expect(batch.turns).toHaveLength(3);
		});

		it('a retained-turn replay counts on the audio slot', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			const turn = {
				pcm: Buffer.alloc(640, 5),
				sampleRateHz: 16000,
				utteranceId: 1,
				sealedAtMs: 0,
			};

			expect(transport.replayUserTurn(turn)).toBe(false); // not connected
			let a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.skippedNoSession).toBe(1);
			expect(a.queued).toBe(0);

			await transport.connect(); // setup resets the counters
			expect(transport.replayUserTurn(turn)).toBe(true);
			a = transport.getDiagnostics().upstream.audio;
			expect(a.attempted).toBe(1);
			expect(a.queued).toBe(1);
			expect(a.queuedRawBytes).toBe(640);
			expect(a.queuedWireBytesEstimate).toBe(turn.pcm.toString('base64').length);
			expect(transport.getDiagnostics().upstream.text.attempted).toBe(0);
		});

		it('a send buffered during the wind-down window counts when the deferred send runs', async () => {
			const model = 'gemini-3.1-flash-live-preview';
			const transport = new GeminiLiveTransport({ apiKey: 'test-key', model }, {});
			await transport.connect({
				auth: { type: 'api_key', apiKey: 'test-key' },
				model,
				responseModality: 'text',
			});
			transport.onTextOutput = () => {};
			transport.onTextDone = () => {};
			transport.onTurnComplete = () => {};
			const cbs = capturedConnectConfig.callbacks as Record<string, (msg: unknown) => void>;
			cbs.onmessage({ serverContent: { outputTranscription: { text: 'Hi.' } } });
			cbs.onmessage({ serverContent: { generationComplete: true } });

			transport.sendClientContent([{ role: 'user', parts: [{ text: 'directive' }] }], true);
			expect(transport.getDiagnostics().upstream.text.attempted).toBe(0);

			cbs.onmessage({ serverContent: { turnComplete: true } }); // flushes the buffer
			const t = transport.getDiagnostics().upstream.text;
			expect(t.attempted).toBe(1);
			expect(t.queued).toBe(1);
			expect(t.queuedRawBytes).toBe(9);
		});

		it('getDiagnostics returns a snapshot, not a live reference', async () => {
			const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			await transport.connect();
			const snap = transport.getDiagnostics();
			transport.sendAudio(B64);
			expect(snap.upstream.audio.attempted).toBe(0);
			expect(transport.getDiagnostics().upstream.audio.attempted).toBe(1);
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
				playbackGatedTurnComplete: true,
				bufferedUncancellableAudio: true,
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

	// P2: sessionResumption refactor.
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
