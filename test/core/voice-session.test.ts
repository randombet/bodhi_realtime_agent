import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { VoiceSession } from '../../src/core/voice-session.js';
import { InMemoryPostSessionPipeline } from '../../src/post-session/pipeline.js';
import { type PostSessionContext, PostSessionProcessor } from '../../src/post-session/types.js';
import { DEFAULT_GEMINI_REALTIME_INPUT_CONFIG } from '../../src/transport/gemini-live-transport.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	STTProvider,
	TransportCapabilities,
} from '../../src/types/transport.js';

declare module '@google/genai' {
	function _getMessageHandler(): ((message: unknown) => void) | null;
	function _getMockSession(): Record<string, ReturnType<typeof vi.fn>> | null;
}

// Mock the external deps
vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	let mockSession: Record<string, ReturnType<typeof vi.fn>> | null = null;

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					// Fire setupComplete so connect() resolves (it awaits this)
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					mockSession = {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
					return mockSession;
				}),
			},
		})),
		_getMessageHandler: () => messageHandler,
		_getMockSession: () => mockSession,
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async (opts: { onStepFinish?: (step: unknown) => void }) => {
		opts.onStepFinish?.({ toolCalls: [], usage: { totalTokens: 10 } });
		return { text: 'subagent done' };
	}),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function mockGeminiSessionSentText(
	mockGeminiSession: Record<string, ReturnType<typeof vi.fn>>,
	predicate: (text: string) => boolean,
): boolean {
	const realtimeCalls = mockGeminiSession.sendRealtimeInput.mock.calls;
	for (const call of realtimeCalls) {
		const arg = call[0] as { text?: string };
		if (typeof arg.text === 'string' && predicate(arg.text)) return true;
	}

	const clientContentCalls = mockGeminiSession.sendClientContent.mock.calls;
	for (const call of clientContentCalls) {
		const arg = call[0] as { turns?: Array<{ parts?: Array<{ text?: string }> }> };
		if (arg.turns?.some((t) => t.parts?.some((p) => p.text && predicate(p.text)))) {
			return true;
		}
	}

	return false;
}

function createEchoAgent(): MainAgent {
	return {
		name: 'echo',
		instructions: 'You are an echo agent',
		tools: [],
	};
}

function createGreetingAgent(): MainAgent {
	return {
		name: 'greeter',
		instructions: 'You are a greeting agent',
		greeting: '[System: Greet the user warmly.]',
		tools: [],
	};
}

function createToolAgent(): MainAgent {
	return {
		name: 'tool-agent',
		instructions: 'You have tools',
		tools: [
			{
				name: 'get_weather',
				description: 'Get weather',
				parameters: z.object({ city: z.string() }),
				execution: 'inline',
				execute: async () => ({ temp: 72, unit: 'F' }),
			},
		],
	};
}

function createFailingToolAgent(): MainAgent {
	return {
		name: 'failing-tool-agent',
		instructions: 'Agent with a tool that throws',
		tools: [
			{
				name: 'broken_tool',
				description: 'A tool that always throws',
				parameters: z.object({ input: z.string() }),
				execution: 'inline',
				execute: async () => {
					throw new Error('Tool execution failed');
				},
			},
		],
	};
}

function createBackgroundToolAgent(): MainAgent {
	return {
		name: 'bg-tool-agent',
		instructions: 'Agent with background tool',
		tools: [
			{
				name: 'slow_task',
				description: 'A slow background task',
				parameters: z.object({ task: z.string() }),
				execution: 'background',
				pendingMessage: 'Working on it...',
				execute: async () => ({ done: true }),
			},
		],
	};
}

function createMutableServerTurnTransport(): LLMTransport & {
	activeServerTurnId: number | undefined;
	reconnect: ReturnType<typeof vi.fn>;
} {
	return {
		activeServerTurnId: undefined,
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
			contextCompression: true,
			groundingMetadata: true,
			textResponseModality: true,
		} satisfies TransportCapabilities,
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		} satisfies AudioFormatSpec,
		isConnected: false,
		connect: vi.fn(async function (this: LLMTransport) {
			this.onSessionReady?.('test-session');
		}),
		disconnect: vi.fn(async () => {}),
		reconnect: vi.fn(async () => {}),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn(async () => {}),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
		getActiveServerTurnId() {
			return this.activeServerTurnId;
		},
	};
}

describe('VoiceSession', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	it('creates with all components', () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9870,
			model: mockModel,
		});

		expect(session.eventBus).toBeDefined();
		expect(session.sessionManager).toBeDefined();
		expect(session.conversationContext).toBeDefined();
	});

	it('notifyBackground forwards to notification queue with default label/priority', () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9876,
			model: mockModel,
		});

		const notificationQueue = (
			session as unknown as { notificationQueue: { sendOrQueue: (...args: unknown[]) => void } }
		).notificationQueue;
		const sendOrQueueSpy = vi.spyOn(notificationQueue, 'sendOrQueue');

		session.notifyBackground('Task queued');

		expect(sendOrQueueSpy).toHaveBeenCalledWith(
			[{ role: 'user', parts: [{ text: '[SUBAGENT UPDATE]: Task queued' }] }],
			true,
			{ priority: 'normal' },
		);
	});

	it('starts and transitions to ACTIVE', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9871,
			model: mockModel,
		});

		// start() awaits connect(), which resolves after setupComplete
		await session.start();

		expect(session.sessionManager.state).toBe('ACTIVE');
	});

	it('close transitions to CLOSED', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9872,
			model: mockModel,
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));
		await session.close();

		expect(session.sessionManager.state).toBe('CLOSED');
	});

	describe('no-TTS text mode (responseModality: "text")', () => {
		it('routes model text output to the transcript and marks the router text-mode', () => {
			const transport = createMutableServerTurnTransport();
			session = new VoiceSession({
				sessionId: 'sess_text',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9899,
				model: mockModel,
				transport,
				responseModality: 'text',
			});

			const internals = session as unknown as {
				agentRouter: { responseModality: string };
				transcriptManager: { handleOutput: (t: string) => void };
			};
			// Router is in text mode without any TTS provider.
			expect(internals.agentRouter.responseModality).toBe('text');
			// onTextOutput is wired at construction (wireTransportCallbacks).
			expect(typeof transport.onTextOutput).toBe('function');

			// Model text flows to the transcript manager (which emits the normal
			// `{ type:'transcript', role:'assistant' }` client events).
			const spy = vi.spyOn(internals.transcriptManager, 'handleOutput');
			transport.onTextOutput?.('Hello from the model');
			expect(spy).toHaveBeenCalledWith('Hello from the model');
		});

		it('start() rejects when the transport lacks textResponseModality', async () => {
			const transport = createMutableServerTurnTransport();
			(transport as { capabilities: TransportCapabilities }).capabilities = {
				...transport.capabilities,
				textResponseModality: false,
			};
			session = new VoiceSession({
				sessionId: 'sess_text2',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9898,
				model: mockModel,
				transport,
				responseModality: 'text',
			});
			await expect(session.start()).rejects.toThrow(/textResponseModality/);
		});
	});

	it('close reaches CLOSED and resolves even when a teardown step throws', async () => {
		// P1: the close funnel (session.close + post-session dispatch) runs BEFORE
		// fallible teardown, and teardown is isolated — a throwing disconnect must
		// not prevent CLOSED nor reject close().
		session = new VoiceSession({
			sessionId: 'sess_td',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9873,
			model: mockModel,
		});
		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const transportRef = (session as unknown as { transport: { disconnect: () => Promise<void> } })
			.transport;
		vi.spyOn(transportRef, 'disconnect').mockRejectedValueOnce(new Error('disconnect boom'));

		await expect(session.close()).resolves.toBeUndefined();
		expect(session.sessionManager.state).toBe('CLOSED');
	});

	it('post-session snapshot transferPath reflects multi-hop transfers', async () => {
		// P3: transferPath is reconstructed from the transfer timeline, preserving
		// multi-hop and A→B→A returns.
		let captured: readonly string[] | undefined;
		class CaptureProcessor extends PostSessionProcessor {
			readonly name = 'capture';
			async run(ctx: PostSessionContext) {
				captured = ctx.transferPath;
			}
		}
		const pipeline = new InMemoryPostSessionPipeline();
		pipeline.register(new CaptureProcessor());
		pipeline.freeze();

		session = new VoiceSession({
			sessionId: 'sess_tp',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9874,
			model: mockModel,
			postSessionPipeline: pipeline,
			drainPostSession: true,
		});
		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		session.conversationContext.addAgentTransfer('echo', 'specialist');
		session.conversationContext.addAgentTransfer('specialist', 'echo');
		await session.close();

		expect(captured).toEqual(['echo', 'specialist', 'echo']);
	});

	it('registers hooks from config', async () => {
		const onSessionStart = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9873,
			model: mockModel,
			hooks: { onSessionStart },
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		expect(onSessionStart).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess_1' }));
	});

	it('publishes raw latency facts on the EventBus (§11): response.started/first_audio, origins, close ordering', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9945,
			model: mockModel,
		});

		const started: Array<{ turnId: string; atMs: number; origin: string }> = [];
		const firstAudio: Array<{ turnId: string; atMs: number }> = [];
		const lifecycle: string[] = [];
		session.eventBus.subscribe('response.started', (p) => started.push(p));
		session.eventBus.subscribe('response.first_audio', (p) => firstAudio.push(p));
		session.eventBus.subscribe('session.reset', (p) => lifecycle.push(`reset:${p.reason}`));
		session.eventBus.subscribe('turn.end', () => lifecycle.push('turn.end'));

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9945');
		await new Promise<void>((r) => ws.on('open', r));

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

		// Audio-bearing model response → response.started (default user_audio) + first_audio.
		fire({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
		await new Promise((r) => setTimeout(r, 20));

		expect(started).toHaveLength(1);
		expect(started[0].origin).toBe('user_audio');
		expect(typeof started[0].atMs).toBe('number');
		expect(firstAudio).toHaveLength(1);
		expect(firstAudio[0].turnId).toBe(started[0].turnId);
		expect(firstAudio[0].atMs).toBeGreaterThanOrEqual(started[0].atMs);

		// Complete the turn, then drive a text-input response → origin user_text.
		fire({ serverContent: { turnComplete: true } });
		await new Promise((r) => setTimeout(r, 30));
		ws.send(JSON.stringify({ type: 'text_input', text: 'hello' }));
		await new Promise((r) => setTimeout(r, 80));
		fire({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'BBBB' } }] } } });
		await new Promise((r) => setTimeout(r, 20));

		expect(started).toHaveLength(2);
		expect(started[1].origin).toBe('user_text');

		// close(): session.reset{'close'} must precede the teardown turn.end.
		lifecycle.length = 0;
		await session.close();
		session = null;
		expect(lifecycle[0]).toBe('reset:close');
		expect(lifecycle).toContain('turn.end');
		expect(lifecycle.indexOf('reset:close')).toBeLessThan(lifecycle.indexOf('turn.end'));

		ws.close();
	});

	it('throwing observability hooks do not disrupt the turn (fire-and-forget isolation)', async () => {
		// FrameworkHooks contract: exceptions are caught and logged. A throwing
		// user hook must not abort the path that emitted it — here, a throwing
		// onTranscriptReady fires mid-transcript-flush and must not prevent the
		// assistant final transcript or turn completion from reaching the client.
		const boom = () => {
			throw new Error('user hook exploded');
		};
		const onTranscriptReady = vi.fn(boom);
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9944,
			model: mockModel,
			hooks: {
				onTranscriptReady,
				onUserSpeechEnd: boom,
				onBargeInDetected: boom,
				onJumpIn: boom,
				onAgentReentry: boom,
				onTurnFinalized: boom,
			},
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9944');
		await new Promise<void>((r) => ws.on('open', r));

		const received: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) received.push(data.toString());
		});

		const { _getMessageHandler } = await import('@google/genai');
		const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

		fire({ serverContent: { inputTranscription: { text: 'Hello there' } } });
		fire({ serverContent: { outputTranscription: { text: 'Hi! How can I help?' } } });
		fire({ serverContent: { turnComplete: true } });

		await new Promise((r) => setTimeout(r, 100));

		const messages = received.map((r) => JSON.parse(r)) as Record<string, unknown>[];
		const assistantFinal = messages.find(
			(m) => m.type === 'transcript' && m.role === 'assistant' && m.partial === false,
		);
		const turnEnd = messages.find((m) => m.type === 'turn.end');

		// The throwing hook actually fired (the test is meaningful)...
		expect(onTranscriptReady).toHaveBeenCalled();
		// ...and the turn still completed cleanly despite it.
		expect(assistantFinal).toBeDefined();
		expect(assistantFinal?.text).toBe('Hi! How can I help?');
		expect(turnEnd).toBeDefined();

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('sends session.config and session.ready for local demo clients', async () => {
		session = new VoiceSession({
			sessionId: 'sess_ready',
			userId: 'user_ready',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9926,
			model: mockModel,
		});

		await session.start();

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9926');
		const received: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) received.push(data.toString());
		});
		await new Promise<void>((r) => ws.on('open', r));
		await new Promise((r) => setTimeout(r, 50));

		const messages = received.map((m) => JSON.parse(m));
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'session.config',
					clientMedia: { kind: 'websocket' },
					clientSignalSource: 'websocket_json',
					clientAudioSource: 'websocket_pcm',
				}),
				expect.objectContaining({
					type: 'session.ready',
					userId: 'user_ready',
					sessionId: 'sess_ready',
					agentProfile: 'echo',
					clientMedia: { kind: 'websocket' },
					clientSignalSource: 'websocket_json',
					clientAudioSource: 'websocket_pcm',
				}),
			]),
		);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('does not send session.ready from server-owned client sessions', async () => {
		const sendJson = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_server_owned',
			userId: 'user_server_owned',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			clientSender: { sendAudio: vi.fn(), sendJson },
			model: mockModel,
		});

		await session.start();
		session.notifyClientConnected();

		const messageTypes = sendJson.mock.calls.map((call) => call[0]?.type);
		expect(messageTypes).toContain('session.config');
		expect(messageTypes).not.toContain('session.ready');
		expect(sendJson).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'session.config',
				clientMedia: { kind: 'websocket' },
				clientSignalSource: 'websocket_json',
				clientAudioSource: 'websocket_pcm',
			}),
		);
	});

	it('forwards gui.update events to the client as JSON', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9877,
			model: mockModel,
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		// Connect a WebSocket client to capture sent messages
		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9877');
		await new Promise<void>((r) => ws.on('open', r));

		const received: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) received.push(data.toString());
		});

		// Publish gui.update on EventBus — it should be forwarded to client
		session.eventBus.publish('gui.update', {
			sessionId: 'sess_1',
			data: { screen: 'dashboard' },
		});

		await new Promise((r) => setTimeout(r, 50));

		// Filter to gui.update: other client frames can race into the window; there
		// must be exactly one forwarded gui.update (still catches a double-forward).
		const updates = received.map((m) => JSON.parse(m)).filter((m) => m.type === 'gui.update');
		expect(updates).toHaveLength(1);
		expect(updates[0]).toEqual({
			type: 'gui.update',
			payload: { sessionId: 'sess_1', data: { screen: 'dashboard' } },
		});

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('forwards gui.notification events to the client as JSON', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9878,
			model: mockModel,
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9878');
		await new Promise<void>((r) => ws.on('open', r));

		const received: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) received.push(data.toString());
		});

		session.eventBus.publish('gui.notification', {
			sessionId: 'sess_1',
			message: 'Task completed',
		});

		await new Promise((r) => setTimeout(r, 50));

		// Filter to gui.notification specifically: other client frames (e.g. an initial
		// agent turn) can race into the window, but there must be exactly one forwarded
		// gui.notification (this still catches a double-forward regression).
		const notifications = received
			.map((m) => JSON.parse(m))
			.filter((m) => m.type === 'gui.notification');
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toEqual({
			type: 'gui.notification',
			payload: { sessionId: 'sess_1', message: 'Task completed' },
		});

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('forwards subagent.ui.send events to the client as ui.payload', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9879,
			model: mockModel,
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9879');
		await new Promise<void>((r) => ws.on('open', r));

		const received: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) received.push(data.toString());
		});

		session.eventBus.publish('subagent.ui.send', {
			sessionId: 'sess_1',
			payload: { type: 'choice', requestId: 'req_1', data: { options: ['A', 'B'] } },
		});

		await new Promise((r) => setTimeout(r, 50));

		// Filter to ui.payload: other client frames can race into the window; there
		// must be exactly one forwarded ui.payload (still catches a double-forward).
		const payloads = received.map((m) => JSON.parse(m)).filter((m) => m.type === 'ui.payload');
		expect(payloads).toHaveLength(1);
		expect(payloads[0]).toEqual({
			type: 'ui.payload',
			payload: { type: 'choice', requestId: 'req_1', data: { options: ['A', 'B'] } },
		});

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('publishes subagent.ui.response when client sends ui.response JSON', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9880,
			model: mockModel,
		});

		const uiResponseHandler = vi.fn();
		session.eventBus.subscribe('subagent.ui.response', uiResponseHandler);

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9880');
		await new Promise<void>((r) => ws.on('open', r));

		ws.send(
			JSON.stringify({
				type: 'ui.response',
				payload: { requestId: 'req_1', selectedOptionId: 'opt_A' },
			}),
		);

		await new Promise((r) => setTimeout(r, 50));

		expect(uiResponseHandler).toHaveBeenCalledOnce();
		expect(uiResponseHandler.mock.calls[0][0]).toEqual({
			sessionId: 'sess_1',
			response: { requestId: 'req_1', selectedOptionId: 'opt_A' },
		});

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('handles text_input from client and records in conversation', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9881,
			model: mockModel,
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9881');
		await new Promise<void>((r) => ws.on('open', r));

		const received: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) received.push(data.toString());
		});

		// Send text input
		ws.send(JSON.stringify({ type: 'text_input', text: 'Hello agent' }));

		await new Promise((r) => setTimeout(r, 100));

		// Check conversation context has the user message
		const items = session.conversationContext.items;
		expect(items.some((i) => i.content === 'Hello agent' && i.role === 'user')).toBe(true);

		// No transcript echo for text input — the web client displays typed text locally.
		// Verify no user transcript was sent back.
		const transcripts = received
			.map((r) => JSON.parse(r))
			.filter((m) => m.type === 'transcript' && m.role === 'user');
		expect(transcripts).toHaveLength(0);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('handles file_upload from client and records in conversation', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9882,
			model: mockModel,
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const WebSocket = (await import('ws')).default;
		const ws = new WebSocket('ws://localhost:9882');
		await new Promise<void>((r) => ws.on('open', r));

		// Send file upload
		ws.send(
			JSON.stringify({
				type: 'file_upload',
				data: { base64: 'aW1hZ2VkYXRh', mimeType: 'image/png', fileName: 'test.png' },
			}),
		);

		await new Promise((r) => setTimeout(r, 100));

		// Check conversation context has the upload
		const items = session.conversationContext.items;
		expect(items.some((i) => i.content.includes('Uploaded file: test.png'))).toBe(true);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('publishes turn events on EventBus', async () => {
		session = new VoiceSession({
			sessionId: 'sess_1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9874,
			model: mockModel,
		});

		const turnEndHandler = vi.fn();
		session.eventBus.subscribe('turn.end', turnEndHandler);

		await session.start();
		await new Promise((r) => setTimeout(r, 50));
		await session.close('test');

		// close() fires turn.end when turnId > 0
		// Since we haven't had any turns, turnId is 0, so no turn.end
		// This tests that the EventBus is properly wired
		expect(session.sessionManager.state).toBe('CLOSED');
	});

	// =========================================================================
	// Transcript buffering tests
	// =========================================================================

	describe('transcript buffering', () => {
		it('accumulates input transcription chunks and sends partial updates to client', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9883,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9883');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			// Simulate Gemini sending transcription chunks
			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { inputTranscription: { text: 'sear' } } });
			fire({ serverContent: { inputTranscription: { text: 'ch the ' } } });
			fire({ serverContent: { inputTranscription: { text: 'weather' } } });

			await new Promise((r) => setTimeout(r, 50));

			// Each chunk should send a partial transcript with accumulated text
			const transcripts = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.type === 'transcript');

			expect(transcripts).toHaveLength(3);
			expect(transcripts[0]).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'sear',
				partial: true,
			});
			expect(transcripts[1]).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'search the',
				partial: true,
			});
			expect(transcripts[2]).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'search the weather',
				partial: true,
			});

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('accumulates output transcription chunks and sends partial updates', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9884,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9884');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { outputTranscription: { text: 'The weather ' } } });
			fire({ serverContent: { outputTranscription: { text: 'is sunny today.' } } });

			await new Promise((r) => setTimeout(r, 50));

			const transcripts = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.type === 'transcript');

			expect(transcripts).toHaveLength(2);
			expect(transcripts[0]).toEqual({
				type: 'transcript',
				role: 'assistant',
				text: 'The weather',
				partial: true,
			});
			expect(transcripts[1]).toEqual({
				type: 'transcript',
				role: 'assistant',
				text: 'The weather is sunny today.',
				partial: true,
			});

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('flushes buffers on turnComplete with partial: false and adds to ConversationContext', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9885,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9885');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Send input + output transcription chunks
			fire({ serverContent: { inputTranscription: { text: 'Hello ' } } });
			fire({ serverContent: { inputTranscription: { text: 'there' } } });
			fire({ serverContent: { outputTranscription: { text: 'Hi! How ' } } });
			fire({ serverContent: { outputTranscription: { text: 'can I help?' } } });

			// Fire turn complete to flush
			fire({ serverContent: { turnComplete: true } });

			await new Promise((r) => setTimeout(r, 100));

			const transcripts = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.type === 'transcript');

			// Should have 4 partials + 2 finals
			const userPartials = transcripts.filter(
				(t: Record<string, unknown>) => t.role === 'user' && t.partial === true,
			);
			const userFinals = transcripts.filter(
				(t: Record<string, unknown>) => t.role === 'user' && t.partial === false,
			);
			const assistantPartials = transcripts.filter(
				(t: Record<string, unknown>) => t.role === 'assistant' && t.partial === true,
			);
			const assistantFinals = transcripts.filter(
				(t: Record<string, unknown>) => t.role === 'assistant' && t.partial === false,
			);

			expect(userPartials).toHaveLength(2);
			expect(userFinals).toHaveLength(1);
			expect(userFinals[0].text).toBe('Hello there');
			expect(assistantPartials).toHaveLength(2);
			expect(assistantFinals).toHaveLength(1);
			expect(assistantFinals[0].text).toBe('Hi! How can I help?');

			// Verify ConversationContext has the messages
			const items = session.conversationContext.items;
			expect(items.some((i) => i.role === 'user' && i.content === 'Hello there')).toBe(true);
			expect(items.some((i) => i.role === 'assistant' && i.content === 'Hi! How can I help?')).toBe(
				true,
			);

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('flushes buffers on interrupted', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9886,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { outputTranscription: { text: 'Let me tell you about ' } } });
			fire({ serverContent: { outputTranscription: { text: 'the wea—' } } });

			// Interrupted by user
			fire({ serverContent: { interrupted: true } });

			await new Promise((r) => setTimeout(r, 50));

			const items = session.conversationContext.items;
			expect(
				items.some((i) => i.role === 'assistant' && i.content === 'Let me tell you about the wea—'),
			).toBe(true);
		});

		it('sends turn.interrupted JSON to client on interrupt', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9898,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9898');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { outputTranscription: { text: 'Hello there—' } } });
			fire({ serverContent: { interrupted: true } });

			await new Promise((r) => setTimeout(r, 50));

			const messages = received.map((r) => JSON.parse(r));
			expect(messages.some((m) => m.type === 'turn.interrupted')).toBe(true);

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('flushes buffers on session close', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9887,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { inputTranscription: { text: 'Good' } } });
			fire({ serverContent: { inputTranscription: { text: 'bye' } } });

			// Close without turnComplete — close() should flush
			await session.close();

			const items = session.conversationContext.items;
			expect(items.some((i) => i.role === 'user' && i.content === 'Goodbye')).toBe(true);
		});

		it('resets buffers after flush so next turn starts fresh', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9888,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9888');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// First turn
			fire({ serverContent: { inputTranscription: { text: 'Hello' } } });
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			// Second turn — should NOT contain "Hello" from first turn
			received.length = 0;
			fire({ serverContent: { inputTranscription: { text: 'World' } } });

			await new Promise((r) => setTimeout(r, 50));

			const transcripts = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.type === 'transcript' && m.role === 'user');

			// Should be "World", not "HelloWorld"
			expect(transcripts[0].text).toBe('World');

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('deduplicates output transcription across tool call boundary', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createToolAgent()],
				initialAgent: 'tool-agent',
				port: 9892,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9892');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Simulate Gemini transcription that leaks post-tool text pre-tool
			fire({ serverContent: { outputTranscription: { text: 'Sure. ' } } });
			fire({ serverContent: { outputTranscription: { text: 'The answer is 42.' } } });

			// Tool call arrives — buffer is saved and cleared
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_1', name: 'get_weather', args: { city: 'SF' } }],
				},
			});

			// Wait for tool result to be sent back
			await new Promise((r) => setTimeout(r, 100));

			// Post-tool transcription re-sends overlapping text
			fire({ serverContent: { outputTranscription: { text: 'The answer is 42.' } } });
			fire({ serverContent: { outputTranscription: { text: ' Is that helpful?' } } });

			// Turn complete
			fire({ serverContent: { turnComplete: true } });

			await new Promise((r) => setTimeout(r, 100));

			// Find the final (partial: false) assistant transcript
			const finals = received
				.map((r) => JSON.parse(r))
				.filter(
					(m: Record<string, unknown>) =>
						m.type === 'transcript' && m.role === 'assistant' && m.partial === false,
				);

			expect(finals).toHaveLength(1);
			// Should NOT have "The answer is 42." duplicated
			expect(finals[0].text).toBe('Sure. The answer is 42. Is that helpful?');

			// ConversationContext should also have deduplicated text
			const items = session.conversationContext.items;
			const assistantItems = items.filter((i) => i.role === 'assistant');
			expect(assistantItems[0]?.content).toBe('Sure. The answer is 42. Is that helpful?');

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('handles tool call with no overlapping transcription', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createToolAgent()],
				initialAgent: 'tool-agent',
				port: 9893,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Pre-tool transcription
			fire({ serverContent: { outputTranscription: { text: 'Let me check. ' } } });

			// Tool call
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_2', name: 'get_weather', args: { city: 'NY' } }],
				},
			});

			await new Promise((r) => setTimeout(r, 100));

			// Post-tool transcription — completely new text, no overlap
			fire({ serverContent: { outputTranscription: { text: 'It is 72 degrees.' } } });

			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			const items = session.conversationContext.items;
			const assistantItems = items.filter((i) => i.role === 'assistant');
			expect(assistantItems[0]?.content).toBe('Let me check. It is 72 degrees.');
		});
		it('flushes user input transcript before tool calls', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createToolAgent()],
				initialAgent: 'tool-agent',
				port: 9892,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// User speaks
			fire({ serverContent: { inputTranscription: { text: 'What is the weather?' } } });

			// Gemini calls a tool — user input should be flushed to context BEFORE tool call
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_flush', name: 'get_weather', args: { city: 'SF' } }],
				},
			});

			await new Promise((r) => setTimeout(r, 100));

			// Check that user message appears before tool call in conversation context
			const items = session.conversationContext.items;
			const userIdx = items.findIndex(
				(i) => i.role === 'user' && i.content === 'What is the weather?',
			);
			const toolIdx = items.findIndex(
				(i) => i.role === 'tool_call' && i.content.includes('get_weather'),
			);

			expect(userIdx).toBeGreaterThanOrEqual(0);
			expect(toolIdx).toBeGreaterThanOrEqual(0);
			expect(userIdx).toBeLessThan(toolIdx);
		});
	});

	// =========================================================================
	// Turn lifecycle (Turn entity — idempotent finalization)
	// =========================================================================

	describe('Turn lifecycle', () => {
		it('a repeated interrupt for the same turn publishes turn.interrupted exactly once', async () => {
			session = new VoiceSession({
				sessionId: 'sess_tl1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9940,
				model: mockModel,
			});
			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			let interruptedCount = 0;
			session.eventBus.subscribe('turn.interrupted', () => {
				interruptedCount++;
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { outputTranscription: { text: 'Telling you about—' } } });
			// One physical barge-in observed twice (e.g. server VAD then a mirror).
			fire({ serverContent: { interrupted: true } });
			fire({ serverContent: { interrupted: true } });
			await new Promise((r) => setTimeout(r, 50));

			expect(interruptedCount).toBe(1);
		});

		it('interrupt then the trailing turnComplete: one turn.interrupted + one turn.end, shared id', async () => {
			session = new VoiceSession({
				sessionId: 'sess_tl2',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9941,
				model: mockModel,
			});
			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const interrupted: string[] = [];
			const ended: string[] = [];
			session.eventBus.subscribe('turn.interrupted', (e) => {
				interrupted.push((e as { turnId: string }).turnId);
			});
			session.eventBus.subscribe('turn.end', (e) => {
				ended.push((e as { turnId: string }).turnId);
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { outputTranscription: { text: 'Half a sen—' } } });
			fire({ serverContent: { interrupted: true } });
			// The server's trailing turnComplete for the same server turn — a no-op.
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			expect(interrupted).toHaveLength(1);
			expect(ended).toHaveLength(1);
			expect(interrupted[0]).toBe(ended[0]);
		});

		it('close() mid-turn finalizes the active turn with exactly one turn.end', async () => {
			session = new VoiceSession({
				sessionId: 'sess_tl3',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9942,
				model: mockModel,
			});
			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			let endCount = 0;
			session.eventBus.subscribe('turn.end', () => {
				endCount++;
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			fire({ serverContent: { outputTranscription: { text: 'mid turn' } } });
			await new Promise((r) => setTimeout(r, 20));

			await session.close();
			expect(endCount).toBe(1);
		});
	});

	// =========================================================================
	// Tool call error handling tests
	// =========================================================================

	describe('tool call error handling', () => {
		it('sends error response to Gemini when inline tool throws', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createFailingToolAgent()],
				initialAgent: 'failing-tool-agent',
				port: 9889,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler, _getMockSession } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			const mockSess = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			// Fire a tool call for the broken tool
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_err', name: 'broken_tool', args: { input: 'test' } }],
				},
			});

			// Wait for the async .catch() to fire
			await new Promise((r) => setTimeout(r, 100));

			// Verify sendToolResponse was called with an error (not left hanging)
			expect(mockSess.sendToolResponse).toHaveBeenCalled();
			const lastCall = mockSess.sendToolResponse.mock.calls.at(-1);
			expect(lastCall).toBeDefined();
			if (!lastCall) throw new Error('expected tool response');
			const response = lastCall[0].functionResponses[0];
			expect(response.id).toBe('tc_err');
			expect(response.name).toBe('broken_tool');
			expect(response.response).toHaveProperty('error');
			expect(response.response.error).toContain('Tool execution failed');
		});

		it('runs background tool without subagent config asynchronously after immediate acknowledgement', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createBackgroundToolAgent()],
				initialAgent: 'bg-tool-agent',
				port: 9890,
				model: mockModel,
				// No subagentConfigs — runs as local background execution
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler, _getMockSession } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			const mockSess = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			// Fire a background tool call (no subagent config → local background execution)
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_bg', name: 'slow_task', args: { task: 'do stuff' } }],
				},
			});

			await new Promise((r) => setTimeout(r, 200));

			// Should get an immediate pending response so the LLM is not blocked.
			expect(mockSess.sendToolResponse).toHaveBeenCalled();
			const calls = mockSess.sendToolResponse.mock.calls;
			const lastCall = calls.at(-1);
			expect(lastCall).toBeDefined();
			if (!lastCall) throw new Error('expected tool response');
			const lastResponse = lastCall[0].functionResponses[0];
			expect(lastResponse.id).toBe('tc_bg');
			expect(lastResponse.response).toMatchObject({ status: 'still_in_progress' });
		});

		it('fires onToolResult hook with error status when tool throws', async () => {
			const onToolResult = vi.fn();
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createFailingToolAgent()],
				initialAgent: 'failing-tool-agent',
				port: 9891,
				model: mockModel,
				hooks: { onToolResult },
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_hook', name: 'broken_tool', args: { input: 'test' } }],
				},
			});

			await new Promise((r) => setTimeout(r, 100));

			expect(onToolResult).toHaveBeenCalled();
			expect(onToolResult).toHaveBeenCalledWith(
				expect.objectContaining({
					toolCallId: 'tc_hook',
					status: 'error',
					error: 'Tool execution failed',
				}),
			);
		});
	});

	describe('active directives', () => {
		it('tool can set directive via setDirective and it is injected on turn complete', async () => {
			let capturedSetDirective:
				| ((key: string, value: string | null, scope?: 'session' | 'agent') => void)
				| undefined;
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [
					{
						name: 'directive-agent',
						instructions: 'Agent with directive tool',
						tools: [
							{
								name: 'set_pace',
								description: 'Set pacing',
								parameters: z.object({ speed: z.string() }),
								execution: 'inline',
								execute: async (_args, ctx) => {
									capturedSetDirective = ctx.setDirective;
									ctx.setDirective?.('pacing', 'Speak slowly');
									return { ok: true };
								},
							},
						],
					},
				],
				initialAgent: 'directive-agent',
				port: 9892,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler, _getMockSession } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			const mockGeminiSession = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			// Fire tool call
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_d1', name: 'set_pace', args: { speed: 'slow' } }],
				},
			});

			await new Promise((r) => setTimeout(r, 100));

			expect(capturedSetDirective).toBeDefined();

			// Fire turn complete — should inject directive
			mockGeminiSession.sendClientContent.mockClear();
			mockGeminiSession.sendRealtimeInput.mockClear();
			fire({ serverContent: { turnComplete: true } });

			await new Promise((r) => setTimeout(r, 50));

			expect(
				mockGeminiSessionSentText(mockGeminiSession, (text) => text.includes('Speak slowly')),
			).toBe(true);
		});

		it('reinforcement injects the directive without triggering a new generation (turnComplete=false)', async () => {
			// Regression: reinforceDirectives must NOT request a model response.
			// A generation-triggering injection makes the model speak an unsolicited
			// "self-talk" turn in reply to its own directive reminder. So the directive
			// is appended with turnComplete=false (no response requested); the user's
			// next audio turn commits it via server VAD.
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [
					{
						name: 'directive-agent',
						instructions: 'Agent with directive tool',
						tools: [
							{
								name: 'set_pace',
								description: 'Set pacing',
								parameters: z.object({ speed: z.string() }),
								execution: 'inline',
								execute: async (_args, ctx) => {
									ctx.setDirective?.('pacing', 'Speak slowly');
									return { ok: true };
								},
							},
						],
					},
				],
				initialAgent: 'directive-agent',
				port: 9892,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler, _getMockSession } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			const mockGeminiSession = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_d1', name: 'set_pace', args: { speed: 'slow' } }],
				},
			});

			await new Promise((r) => setTimeout(r, 100));

			mockGeminiSession.sendClientContent.mockClear();
			mockGeminiSession.sendRealtimeInput.mockClear();
			fire({ serverContent: { turnComplete: true } });

			await new Promise((r) => setTimeout(r, 50));

			// The directive is appended via sendClientContent...
			const directiveCall = mockGeminiSession.sendClientContent.mock.calls.find((call) => {
				const arg = call[0] as { turns?: Array<{ parts?: Array<{ text?: string }> }> };
				return arg.turns?.some((t) => t.parts?.some((p) => p.text?.includes('Speak slowly')));
			});
			expect(directiveCall).toBeDefined();
			// ...with turnComplete=false so it does NOT trigger a new generation.
			expect((directiveCall?.[0] as { turnComplete?: boolean }).turnComplete).toBe(false);
			// And it must NOT be sent via the generation-triggering realtime-input path.
			expect(
				mockGeminiSession.sendRealtimeInput.mock.calls.some((c) =>
					(c[0] as { text?: string }).text?.includes('Speak slowly'),
				),
			).toBe(false);
		});

		it('clearing a directive stops injection on next turn', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [
					{
						name: 'clear-agent',
						instructions: 'Agent that clears directive',
						tools: [
							{
								name: 'toggle_pace',
								description: 'Toggle pacing',
								parameters: z.object({ on: z.boolean() }),
								execution: 'inline',
								execute: async (args, ctx) => {
									const { on } = args as { on: boolean };
									ctx.setDirective?.('pacing', on ? 'Speak slowly' : null);
									return { ok: true };
								},
							},
						],
					},
				],
				initialAgent: 'clear-agent',
				port: 9893,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler, _getMockSession } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			const mockGeminiSession = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			// Set directive
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_t1', name: 'toggle_pace', args: { on: true } }],
				},
			});
			await new Promise((r) => setTimeout(r, 100));

			// Clear directive
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_t2', name: 'toggle_pace', args: { on: false } }],
				},
			});
			await new Promise((r) => setTimeout(r, 100));

			// Fire turn complete — should NOT inject (directive was cleared)
			mockGeminiSession.sendClientContent.mockClear();
			mockGeminiSession.sendRealtimeInput.mockClear();
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			expect(
				mockGeminiSessionSentText(mockGeminiSession, (text) => text.includes('SYSTEM DIRECTIVES')),
			).toBe(false);
		});

		it('no directives means no injection on turn complete', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9894,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler, _getMockSession } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			const mockGeminiSession = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			mockGeminiSession.sendClientContent.mockClear();
			mockGeminiSession.sendRealtimeInput.mockClear();
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			expect(
				mockGeminiSessionSentText(mockGeminiSession, (text) => text.includes('SYSTEM DIRECTIVES')),
			).toBe(false);
		});
	});

	describe('agent greeting', () => {
		it('sends greeting when client connects after Gemini is active', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createGreetingAgent()],
				initialAgent: 'greeter',
				port: 9895,
				model: mockModel,
			});

			// start() awaits setupComplete — Gemini is ACTIVE on return
			await session.start();

			const { _getMockSession } = await import('@google/genai');
			const mockGeminiSession = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			mockGeminiSession.sendClientContent.mockClear();
			mockGeminiSession.sendRealtimeInput.mockClear();

			// Connect a client — should trigger greeting
			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9895');
			await new Promise<void>((r) => ws.on('open', r));

			await new Promise((r) => setTimeout(r, 50));

			expect(
				mockGeminiSessionSentText(mockGeminiSession, (text) =>
					text.includes('[System: Greet the user warmly.]'),
				),
			).toBe(true);

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('does not send greeting when agent has no greeting configured', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9896,
				model: mockModel,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMockSession } = await import('@google/genai');
			const mockGeminiSession = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			mockGeminiSession.sendClientContent.mockClear();
			mockGeminiSession.sendRealtimeInput.mockClear();

			// Connect a client
			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9896');
			await new Promise<void>((r) => ws.on('open', r));

			await new Promise((r) => setTimeout(r, 50));

			expect(mockGeminiSessionSentText(mockGeminiSession, (text) => text.includes('Greet'))).toBe(
				false,
			);

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('sends greeting when Gemini becomes active after client is already connected', async () => {
			// start() awaits connect(), which resolves after setupComplete.
			// The client connects after start() returns, so Gemini is already ACTIVE.
			// The greeting fires from handleClientConnected (Gemini already ready).
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createGreetingAgent()],
				initialAgent: 'greeter',
				port: 9897,
				model: mockModel,
			});

			// Start the session (WS server + Gemini connect, awaits setupComplete)
			await session.start();

			// Connect client after Gemini is already ACTIVE
			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9897');
			await new Promise<void>((r) => ws.on('open', r));

			// Wait for greeting to be sent
			await new Promise((r) => setTimeout(r, 100));

			const { _getMockSession } = await import('@google/genai');
			const mockGeminiSession = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			// Greeting should have been sent (from either handleClientConnected or handleSetupComplete)
			expect(
				mockGeminiSessionSentText(mockGeminiSession, (text) =>
					text.includes('Greet the user warmly'),
				),
			).toBe(true);

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});
	});

	describe('watchdog replay recovery — retained utterance lifecycle', () => {
		function getRetainer(s: VoiceSession) {
			return (
				s as unknown as {
					utteranceRetainer?: {
						markSpeechStart(): void;
						feed(data: Buffer): void;
						seal(): boolean;
						peek(maxAgeMs: number): unknown;
					};
				}
			).utteranceRetainer;
		}

		it('does not construct the retainer when the flag is off (dark rollout)', () => {
			session = new VoiceSession({
				sessionId: 'sess_retainer_off',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				model: mockModel,
				transport: createMutableServerTurnTransport(),
			});
			expect(getRetainer(session)).toBeUndefined();
		});

		it('clears retained content on correlated model activity but NOT on a stale trailing model-start', () => {
			const transport = createMutableServerTurnTransport();
			session = new VoiceSession({
				sessionId: 'sess_retainer_clear',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				model: mockModel,
				transport,
				watchdogReplayRecovery: true,
				responseWatchdogMs: 0,
			});
			session.sessionManager.transitionTo('CONNECTING');
			session.sessionManager.transitionTo('ACTIVE');
			const retainer = getRetainer(session);
			expect(retainer).toBeDefined();
			if (!retainer) return;

			// Assistant turn 1 starts, then the user barges in (turn finalized).
			transport.activeServerTurnId = 1;
			transport.onModelTurnStart?.();
			transport.onInterrupted?.(1);

			// The barge-in utterance seals after finalization (VAD completes late).
			retainer.markSpeechStart();
			retainer.feed(Buffer.alloc(320, 1));
			expect(retainer.seal()).toBe(true);
			expect(retainer.peek(30_000)).not.toBeNull();

			// Stale trailing model-start for the SAME finalized server turn —
			// ensureCurrent() resolves to the just-finalized turn (null) and the
			// retained utterance must survive (it is the recovery content).
			transport.onModelTurnStart?.();
			expect(retainer.peek(30_000)).not.toBeNull();

			// Genuinely new model response (new server turn) — the utterance was
			// consumed by the provider: cleared.
			transport.activeServerTurnId = 2;
			transport.onModelTurnStart?.();
			expect(retainer.peek(30_000)).toBeNull();
		});
	});

	describe('reconnect error handling', () => {
		it('keeps the response watchdog armed across stale turnComplete for a finalized turn', async () => {
			vi.useFakeTimers();
			try {
				const transport = createMutableServerTurnTransport();
				session = new VoiceSession({
					sessionId: 'sess_watchdog_stale_complete',
					userId: 'user_1',
					apiKey: 'test-key',
					agents: [createEchoAgent()],
					initialAgent: 'echo',
					clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
					model: mockModel,
					transport,
					responseWatchdogMs: 10,
				});
				session.sessionManager.transitionTo('CONNECTING');
				session.sessionManager.transitionTo('ACTIVE');
				session.sessionManager.updateResumptionHandle('handle_watchdog');

				transport.activeServerTurnId = 1;
				transport.onModelTurnStart?.();
				transport.onInterrupted?.(1);

				(
					session as unknown as { reconnector: { armResponseWatchdog: () => void } }
				).reconnector.armResponseWatchdog();
				const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
				transport.onTurnComplete?.(1);

				// The stale completion must log that it did NOT disarm the watchdog.
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringContaining(
						'[Watchdog] Ignored turnComplete for already-finalized/superseded turn',
					),
				);
				logSpy.mockRestore();

				await vi.advanceTimersByTimeAsync(10);

				expect(session.sessionManager.state).toBe('RECONNECTING');
				expect(transport.reconnect).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('keeps the response watchdog armed across stale interrupted for a finalized turn', async () => {
			vi.useFakeTimers();
			try {
				const transport = createMutableServerTurnTransport();
				session = new VoiceSession({
					sessionId: 'sess_watchdog_stale_interrupt',
					userId: 'user_1',
					apiKey: 'test-key',
					agents: [createEchoAgent()],
					initialAgent: 'echo',
					clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
					model: mockModel,
					transport,
					responseWatchdogMs: 10,
				});
				session.sessionManager.transitionTo('CONNECTING');
				session.sessionManager.transitionTo('ACTIVE');
				session.sessionManager.updateResumptionHandle('handle_watchdog');

				transport.activeServerTurnId = 1;
				transport.onModelTurnStart?.();
				transport.onTurnComplete?.(1);

				(
					session as unknown as { reconnector: { armResponseWatchdog: () => void } }
				).reconnector.armResponseWatchdog();
				const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
				transport.onInterrupted?.(1);

				// The stale interrupt must log that it did NOT disarm the watchdog.
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringContaining(
						'[Watchdog] Ignored interrupted for already-finalized/superseded turn',
					),
				);
				logSpy.mockRestore();

				await vi.advanceTimersByTimeAsync(10);

				expect(session.sessionManager.state).toBe('RECONNECTING');
				expect(transport.reconnect).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('keeps the response watchdog armed across trailing output transcription for a finalized turn', async () => {
			vi.useFakeTimers();
			try {
				const transport = createMutableServerTurnTransport();
				session = new VoiceSession({
					sessionId: 'sess_watchdog_stale_output_txn',
					userId: 'user_1',
					apiKey: 'test-key',
					agents: [createEchoAgent()],
					initialAgent: 'echo',
					clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
					model: mockModel,
					transport,
					responseWatchdogMs: 10,
				});
				session.sessionManager.transitionTo('CONNECTING');
				session.sessionManager.transitionTo('ACTIVE');
				session.sessionManager.updateResumptionHandle('handle_watchdog');

				transport.activeServerTurnId = 1;
				transport.onModelTurnStart?.();
				transport.onTurnComplete?.(1);

				(
					session as unknown as { reconnector: { armResponseWatchdog: () => void } }
				).reconnector.armResponseWatchdog();
				const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
				transport.onOutputTranscription?.('trailing text');

				// Trailing output transcription for the finalized turn must NOT disarm the watchdog.
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringContaining(
						'[Watchdog] Ignored output transcription for already-finalized turn',
					),
				);
				logSpy.mockRestore();

				await vi.advanceTimersByTimeAsync(10);

				expect(session.sessionManager.state).toBe('RECONNECTING');
				expect(transport.reconnect).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('keeps the response watchdog armed across trailing output audio for a finalized turn', async () => {
			vi.useFakeTimers();
			try {
				const transport = createMutableServerTurnTransport();
				session = new VoiceSession({
					sessionId: 'sess_watchdog_stale_output_audio',
					userId: 'user_1',
					apiKey: 'test-key',
					agents: [createEchoAgent()],
					initialAgent: 'echo',
					clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
					model: mockModel,
					transport,
					responseWatchdogMs: 10,
				});
				session.sessionManager.transitionTo('CONNECTING');
				session.sessionManager.transitionTo('ACTIVE');
				session.sessionManager.updateResumptionHandle('handle_watchdog');

				transport.activeServerTurnId = 1;
				transport.onModelTurnStart?.();
				transport.onTurnComplete?.(1);

				(
					session as unknown as { reconnector: { armResponseWatchdog: () => void } }
				).reconnector.armResponseWatchdog();
				const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
				transport.onAudioOutput?.(Buffer.from([0, 0, 0, 0]).toString('base64'));

				// Trailing output audio for the finalized turn must NOT disarm the watchdog.
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringContaining('[Watchdog] Ignored output audio for already-finalized turn'),
				);
				logSpy.mockRestore();

				await vi.advanceTimersByTimeAsync(10);

				expect(session.sessionManager.state).toBe('RECONNECTING');
				expect(transport.reconnect).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('logs when goAway reconnect completes', async () => {
			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			try {
				session = new VoiceSession({
					sessionId: 'sess_1',
					userId: 'user_1',
					apiKey: 'test-key',
					agents: [createEchoAgent()],
					initialAgent: 'echo',
					port: 9906,
					model: mockModel,
				});

				await session.start();
				await new Promise((r) => setTimeout(r, 50));

				session.sessionManager.updateResumptionHandle('handle_success');

				const transportRef = (
					session as unknown as { transport: { reconnect: () => Promise<void> } }
				).transport;
				vi.spyOn(transportRef, 'reconnect').mockResolvedValueOnce(undefined);

				const { _getMessageHandler } = await import('@google/genai');
				const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
				fire({ goAway: { timeLeft: '30s' } });

				await new Promise((r) => setTimeout(r, 100));

				expect(session.sessionManager.state).toBe('ACTIVE');
				expect(logSpy).toHaveBeenCalledWith(
					expect.stringContaining('[VoiceSession] Reconnect complete; session ACTIVE'),
				);
			} finally {
				logSpy.mockRestore();
			}
		});

		it('transitions to CLOSED when goAway reconnect fails', async () => {
			const onError = vi.fn();
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9904,
				model: mockModel,
				hooks: { onError },
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			// Set a resumption handle so reconnect path is taken
			session.sessionManager.updateResumptionHandle('handle_1');

			// Spy on transport.reconnect to make it reject
			const transportRef = (session as unknown as { transport: { reconnect: () => Promise<void> } })
				.transport;
			vi.spyOn(transportRef, 'reconnect').mockRejectedValueOnce(new Error('reconnect failed'));

			// Fire goAway — triggers handleGoAway which calls reconnect
			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			fire({ goAway: { timeLeft: '30s' } });

			await new Promise((r) => setTimeout(r, 100));

			expect(transportRef.reconnect).toHaveBeenCalledWith(
				expect.objectContaining({
					resumptionHandle: 'handle_1',
					conversationHistory: expect.any(Array),
				}),
			);
			expect(session.sessionManager.state).toBe('CLOSED');
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'reconnect',
					error: expect.objectContaining({ message: 'reconnect failed' }),
				}),
			);
		});

		it('transitions to CLOSED when unexpected-close reconnect fails', async () => {
			const onError = vi.fn();
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9905,
				model: mockModel,
				hooks: { onError },
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			// Set a resumption handle so reconnect path is taken
			session.sessionManager.updateResumptionHandle('handle_2');

			// Spy on transport.reconnect to make it reject
			const transportRef = (session as unknown as { transport: { reconnect: () => Promise<void> } })
				.transport;
			vi.spyOn(transportRef, 'reconnect').mockRejectedValueOnce(new Error('reconnect failed'));

			// Directly invoke the private handleTransportClose since the WebSocket onclose
			// callback is internal to the transport and not exposed through the mock
			(session as unknown as { handleTransportClose: () => void }).handleTransportClose();

			// Wait for backoff delay (1000ms for first attempt) + reconnect execution
			await new Promise((r) => setTimeout(r, 1500));

			expect(transportRef.reconnect).toHaveBeenCalledWith(
				expect.objectContaining({
					resumptionHandle: 'handle_2',
					conversationHistory: expect.any(Array),
				}),
			);
			expect(session.sessionManager.state).toBe('CLOSED');
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'reconnect',
					error: expect.objectContaining({ message: 'reconnect failed' }),
				}),
			);
		});
	});

	// Background tool completion timing vs Gemini turn boundaries: verify with real server + web client (E2E).

	// =========================================================================
	// STT provider wiring tests
	// =========================================================================

	describe('STT provider wiring', () => {
		function createMockSTTProvider(): STTProvider & {
			configure: ReturnType<typeof vi.fn>;
			start: ReturnType<typeof vi.fn>;
			stop: ReturnType<typeof vi.fn>;
			feedAudio: ReturnType<typeof vi.fn>;
			commit: ReturnType<typeof vi.fn>;
			handleInterrupted: ReturnType<typeof vi.fn>;
			handleTurnComplete: ReturnType<typeof vi.fn>;
		} {
			return {
				configure: vi.fn(),
				start: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
				feedAudio: vi.fn(),
				commit: vi.fn(),
				handleInterrupted: vi.fn(),
				handleTurnComplete: vi.fn(),
				onTranscript: undefined,
				onPartialTranscript: undefined,
			};
		}

		it('configure() called with transport audioFormat on construction', () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9910,
				model: mockModel,
				sttProvider: stt,
			});

			expect(stt.configure).toHaveBeenCalledWith({
				sampleRate: 16000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
		});

		it('start() and stop() lifecycle', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9911,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			expect(stt.start).toHaveBeenCalled();

			await session.close();
			expect(stt.stop).toHaveBeenCalled();
			session = null; // prevent double-close in afterEach
		});

		it('feedAudio() called when client sends audio', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9912,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9912');
			await new Promise<void>((r) => ws.on('open', r));

			const audioData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
			ws.send(audioData);
			await new Promise((r) => setTimeout(r, 50));

			expect(stt.feedAudio).toHaveBeenCalledWith(audioData.toString('base64'));

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('commit() called via onModelTurnStart with current turnId', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9913,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
				},
			});

			await new Promise((r) => setTimeout(r, 50));

			expect(stt.commit).toHaveBeenCalledWith(0);
		});

		it('commit() fires only once per turn via onModelTurnStart guard', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9914,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Fire multiple model outputs in same turn
			fire({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
				},
			});
			fire({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'BBBB' } }] },
				},
			});

			await new Promise((r) => setTimeout(r, 50));

			// commit should be called exactly once (not twice)
			expect(stt.commit).toHaveBeenCalledTimes(1);
			expect(stt.commit).toHaveBeenCalledWith(0);
		});

		it('handleTurnComplete() called on turn complete', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9915,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			expect(stt.handleTurnComplete).toHaveBeenCalled();
		});

		it('handleInterrupted() called on interrupted', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9916,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { interrupted: true } });
			await new Promise((r) => setTimeout(r, 50));

			expect(stt.handleInterrupted).toHaveBeenCalled();
		});

		it('safety-net commit on turnComplete when onModelTurnStart did not fire', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9917,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Don't fire any model output — just turnComplete directly
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			// commit should be called as safety-net
			expect(stt.commit).toHaveBeenCalledWith(0);
			expect(stt.handleTurnComplete).toHaveBeenCalled();
		});

		it('accepts late results from the immediately preceding turn', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9918,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Complete turn 0 → turnId becomes 1
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			// Late result from turn 0 arrives after turnId incremented to 1.
			// Batch STT providers commonly fire results slightly late.
			// Rule: turnId < this.turnId - 1 → 0 < 0 = false → ACCEPTED
			stt.onTranscript?.('late but valid', 0);

			// Flush via turnComplete so text appears in context
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			const items = session.conversationContext.items;
			expect(items.some((i) => i.content === 'late but valid')).toBe(true);
		});

		it('drops truly stale turnId results (2+ turns old)', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9923,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Complete 2 turns: turnId goes 0 → 1 → 2
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			// Result from turn 0 is now truly stale (2 turns old)
			// Rule: turnId < this.turnId - 1 → 0 < 1 = true → DROPPED
			stt.onTranscript?.('stale text', 0);

			// Flush via turnComplete to ensure any buffered text would appear
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			const items = session.conversationContext.items;
			expect(items.some((i) => i.content === 'stale text')).toBe(false);
		});

		it('accepts current turnId results from STT provider', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9919,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Complete a turn to increment turnId from 0 to 1
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			// Invoke onTranscript with current turnId (1)
			stt.onTranscript?.('current text', 1);

			// Flush via turnComplete so the text appears in conversation context
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			const items = session.conversationContext.items;
			expect(items.some((i) => i.content === 'current text')).toBe(true);
		});

		it('Gemini inputTranscription corrects STT transcript when sttProvider is set', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9920,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9920');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			// STT provides initial transcript
			stt.onTranscript?.('Hola mi nombre es Juan', 0);
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Gemini provides authoritative correction
			fire({ serverContent: { inputTranscription: { text: 'Hello my name is John' } } });
			await new Promise((r) => setTimeout(r, 50));

			const transcripts = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.type === 'transcript' && m.role === 'user');

			// Should have STT partial + Gemini correction
			expect(transcripts.length).toBeGreaterThanOrEqual(2);
			const correction = transcripts.find((t: Record<string, unknown>) => t.corrected === true);
			expect(correction).toBeDefined();
			expect(correction?.text).toBe('Hello my name is John');

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('drops late STT transcript after Gemini correction was finalized before a tool call', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt_tool_dedup',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createToolAgent()],
				initialAgent: 'tool-agent',
				model: mockModel,
				sttProvider: stt,
				orchestrationMode: 'actor',
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			fire({ serverContent: { inputTranscription: { text: 'What time is it?' } } });
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_1', name: 'get_weather', args: { city: 'SF' } }],
				},
			});
			await new Promise((r) => setTimeout(r, 50));

			stt.onTranscript?.('Uh, what time is it?', 0);
			fire({ serverContent: { outputTranscription: { text: 'It is sunny.' } } });
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 100));

			const userItems = session.conversationContext.items
				.filter((i) => i.role === 'user')
				.map((i) => i.content);
			expect(userItems).toEqual(['What time is it?']);
		});

		it('skips Gemini transcript correction on interrupted turns', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9924,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9924');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			// STT provides transcript
			stt.onTranscript?.('user speech', 0);
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Simulate interruption
			fire({ serverContent: { interrupted: true } });
			await new Promise((r) => setTimeout(r, 50));

			// Gemini sends inputTranscription after interruption — should be skipped
			fire({ serverContent: { inputTranscription: { text: 'incomplete transcript' } } });
			await new Promise((r) => setTimeout(r, 50));

			const corrections = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.corrected === true);
			expect(corrections).toHaveLength(0);

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		// Regression (PR #39): on a barge-in, the user's utterance is transcribed
		// correctly by streaming STT but a later provider "correction" overwrote it.
		// The interrupted turn's own streaming STT lands AFTER the interrupt (tagged
		// numericId-1); it must NOT clear the interrupted-gate, or the provider's
		// post-hoc clipped transcript replaces the good one with corrected:true.
		it('barge-in: late STT for the interrupted turn keeps the correction gate armed', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9943,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9943');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Greeting turn (turn 0) emits output, then the user barges in: the turn
			// is finalized (interrupted) and the counter advances to numericId=1.
			fire({ serverContent: { outputTranscription: { text: 'Hi there! How can—' } } });
			fire({ serverContent: { interrupted: true } });
			await new Promise((r) => setTimeout(r, 50));

			// The barge-in utterance's streaming STT lands now, tagged with the
			// just-finalized turn's id (0 = numericId-1). It shows the good transcript
			// but must leave the interrupted-gate armed.
			stt.onTranscript?.("How's it going?", 0);
			await new Promise((r) => setTimeout(r, 50));

			// Provider's post-hoc transcription of the same clipped barge-in audio.
			// With the gate still armed it is display-only, NOT a corrected overwrite.
			fire({ serverContent: { inputTranscription: { text: 'are doing' } } });
			await new Promise((r) => setTimeout(r, 50));

			const corrections = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.corrected === true);
			expect(corrections).toHaveLength(0);

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('resets interrupted flag on next turnComplete so correction resumes', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9925,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9925');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Turn 1: interrupted — correction skipped
			stt.onTranscript?.('turn one', 0);
			fire({ serverContent: { interrupted: true } });
			await new Promise((r) => setTimeout(r, 50));

			fire({ serverContent: { inputTranscription: { text: 'skipped correction' } } });
			await new Promise((r) => setTimeout(r, 50));

			// Turn 2: normal turn completes — resets flag
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			// New turn: STT + Gemini correction should work
			stt.onTranscript?.('turn two stt', 1);
			fire({ serverContent: { inputTranscription: { text: 'turn two corrected' } } });
			await new Promise((r) => setTimeout(r, 50));

			const corrections = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.corrected === true);
			expect(corrections).toHaveLength(1);
			expect(corrections[0].text).toBe('turn two corrected');

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('partial transcripts from STT provider reach client', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9921,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9921');
			await new Promise<void>((r) => ws.on('open', r));

			const received: string[] = [];
			ws.on('message', (data, isBinary) => {
				if (!isBinary) received.push(data.toString());
			});

			// Invoke onPartialTranscript — should reach client as partial transcript
			stt.onPartialTranscript?.('partial speech');
			await new Promise((r) => setTimeout(r, 50));

			const transcripts = received
				.map((r) => JSON.parse(r))
				.filter((m: Record<string, unknown>) => m.type === 'transcript' && m.role === 'user');
			expect(transcripts).toHaveLength(1);
			expect(transcripts[0]).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'partial speech',
				partial: true,
			});

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});

		it('_commitFiredForTurn resets after turnComplete for next turn', async () => {
			const stt = createMockSTTProvider();
			session = new VoiceSession({
				sessionId: 'sess_stt',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				port: 9922,
				model: mockModel,
				sttProvider: stt,
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();

			// Turn 0: model starts → commit(0) via onModelTurnStart
			fire({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] },
				},
			});
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			expect(stt.commit).toHaveBeenCalledWith(0);

			// Turn 1: model starts again → should commit(1)
			fire({
				serverContent: {
					modelTurn: { parts: [{ inlineData: { data: 'CCCC' } }] },
				},
			});
			await new Promise((r) => setTimeout(r, 50));

			expect(stt.commit).toHaveBeenCalledWith(1);
			expect(stt.commit).toHaveBeenCalledTimes(2);
		});
	});
});

describe('VoiceSession realtimeInputConfig defaulting', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	function createMockTransport(): LLMTransport {
		return {
			capabilities: {
				messageTruncation: false,
				turnDetection: true,
				userTranscription: true,
				inPlaceSessionUpdate: false,
				sessionResumption: true,
				contextCompression: true,
				groundingMetadata: true,
				textResponseModality: true,
			} satisfies TransportCapabilities,
			audioFormat: {
				inputSampleRate: 16000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			} satisfies AudioFormatSpec,
			isConnected: false,
			connect: vi.fn().mockResolvedValue(undefined),
			disconnect: vi.fn().mockResolvedValue(undefined),
			reconnect: vi.fn().mockResolvedValue(undefined),
			sendAudio: vi.fn(),
			commitAudio: vi.fn(),
			clearAudio: vi.fn(),
			updateSession: vi.fn(async () => {}),
			transferSession: vi.fn().mockResolvedValue(undefined),
			sendContent: vi.fn(),
			sendFile: vi.fn(),
			sendToolResult: vi.fn(),
			triggerGeneration: vi.fn(),
		};
	}

	function getResolved(s: VoiceSession): unknown {
		return (s as unknown as { resolvedRealtimeInputConfig?: unknown }).resolvedRealtimeInputConfig;
	}

	it('applies the framework default on the built-in Gemini path when realtimeInputConfig is omitted', () => {
		session = new VoiceSession({
			sessionId: 'sess_default',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9881,
			model: mockModel,
		});

		expect(getResolved(session)).toEqual(DEFAULT_GEMINI_REALTIME_INPUT_CONFIG);
	});

	it('deep-merges a partial user override with the default', () => {
		session = new VoiceSession({
			sessionId: 'sess_partial',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9882,
			model: mockModel,
			realtimeInputConfig: {
				automaticActivityDetection: { silenceDurationMs: 800 },
			},
		});

		const aad = (getResolved(session) as Record<string, Record<string, unknown>>)
			.automaticActivityDetection;
		expect(aad).toEqual({
			endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
			silenceDurationMs: 800,
		});
	});

	it('does NOT apply the default when an external transport is injected', () => {
		const injected = createMockTransport();
		session = new VoiceSession({
			sessionId: 'sess_injected',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port: 9883,
			model: mockModel,
			transport: injected,
			// User-supplied realtimeInputConfig is silently ignored on the injected
			// path today (status quo) — the resolver must not run here.
			realtimeInputConfig: {
				automaticActivityDetection: { silenceDurationMs: 999 },
			},
		});

		expect(getResolved(session)).toBeUndefined();
		// The injected transport's connect was not pre-called with VAD args; we just
		// confirm it was used by VoiceSession (updateSession was invoked at construct).
		expect(injected.updateSession).toHaveBeenCalled();
	});
});
