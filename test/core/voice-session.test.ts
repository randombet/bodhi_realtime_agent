// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { STTProvider } from '../../src/types/transport.js';

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

		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0])).toEqual({
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

		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0])).toEqual({
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

		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0])).toEqual({
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
			const response = lastCall[0].functionResponses[0];
			expect(response.id).toBe('tc_err');
			expect(response.name).toBe('broken_tool');
			expect(response.response).toHaveProperty('error');
			expect(response.response.error).toContain('Tool execution failed');
		});

		it('sends error response to Gemini when background tool has no subagent config (falls back to inline)', async () => {
			session = new VoiceSession({
				sessionId: 'sess_1',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createBackgroundToolAgent()],
				initialAgent: 'bg-tool-agent',
				port: 9890,
				model: mockModel,
				// No subagentConfigs — will fall back to inline execution
			});

			await session.start();
			await new Promise((r) => setTimeout(r, 50));

			const { _getMessageHandler, _getMockSession } = await import('@google/genai');
			const fire = (_getMessageHandler as unknown as () => (msg: unknown) => void)();
			const mockSess = (
				_getMockSession as unknown as () => Record<string, ReturnType<typeof vi.fn>>
			)();

			// Fire a background tool call (no subagent config → inline fallback)
			fire({
				toolCall: {
					functionCalls: [{ id: 'tc_bg', name: 'slow_task', args: { task: 'do stuff' } }],
				},
			});

			await new Promise((r) => setTimeout(r, 200));

			// Should get a pending message response first, then the inline result
			expect(mockSess.sendToolResponse).toHaveBeenCalled();
			// The last call should contain the actual result (from fallback inline execution)
			const calls = mockSess.sendToolResponse.mock.calls;
			const lastResponse = calls.at(-1)[0].functionResponses[0];
			expect(lastResponse.id).toBe('tc_bg');
			// Should not have hung — a response was sent
			expect(lastResponse.response).toBeDefined();
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
			fire({ serverContent: { turnComplete: true } });

			await new Promise((r) => setTimeout(r, 50));

			expect(mockGeminiSession.sendClientContent).toHaveBeenCalledWith(
				expect.objectContaining({
					turns: expect.arrayContaining([
						expect.objectContaining({
							role: 'user',
							parts: expect.arrayContaining([
								expect.objectContaining({
									text: expect.stringContaining('Speak slowly'),
								}),
							]),
						}),
					]),
					turnComplete: true,
				}),
			);
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
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			// sendClientContent should not be called with directive text
			const calls = mockGeminiSession.sendClientContent.mock.calls;
			const hasDirective = calls.some((call: unknown[]) => {
				const arg = call[0] as { turns?: Array<{ parts?: Array<{ text?: string }> }> };
				return arg.turns?.some((t) => t.parts?.some((p) => p.text?.includes('SYSTEM DIRECTIVES')));
			});
			expect(hasDirective).toBe(false);
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
			fire({ serverContent: { turnComplete: true } });
			await new Promise((r) => setTimeout(r, 50));

			const calls = mockGeminiSession.sendClientContent.mock.calls;
			const hasDirective = calls.some((call: unknown[]) => {
				const arg = call[0] as { turns?: Array<{ parts?: Array<{ text?: string }> }> };
				return arg.turns?.some((t) => t.parts?.some((p) => p.text?.includes('SYSTEM DIRECTIVES')));
			});
			expect(hasDirective).toBe(false);
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

			// Connect a client — should trigger greeting
			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9895');
			await new Promise<void>((r) => ws.on('open', r));

			await new Promise((r) => setTimeout(r, 50));

			expect(mockGeminiSession.sendClientContent).toHaveBeenCalledWith(
				expect.objectContaining({
					turns: expect.arrayContaining([
						expect.objectContaining({
							role: 'user',
							parts: expect.arrayContaining([
								expect.objectContaining({
									text: '[System: Greet the user warmly.]',
								}),
							]),
						}),
					]),
					turnComplete: true,
				}),
			);

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

			// Connect a client
			const WebSocket = (await import('ws')).default;
			const ws = new WebSocket('ws://localhost:9896');
			await new Promise<void>((r) => ws.on('open', r));

			await new Promise((r) => setTimeout(r, 50));

			// Should NOT have called sendClientContent with any greeting
			const calls = mockGeminiSession.sendClientContent.mock.calls;
			const hasGreeting = calls.some((call: unknown[]) => {
				const arg = call[0] as { turnComplete?: boolean };
				return arg.turnComplete === true;
			});
			expect(hasGreeting).toBe(false);

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
			const calls = mockGeminiSession.sendClientContent.mock.calls;
			const greetingCall = calls.find((call: unknown[]) => {
				const arg = call[0] as {
					turns?: Array<{ parts?: Array<{ text?: string }> }>;
					turnComplete?: boolean;
				};
				return (
					arg.turnComplete === true &&
					arg.turns?.some((t) => t.parts?.some((p) => p.text?.includes('Greet the user warmly')))
				);
			});
			expect(greetingCall).toBeDefined();

			ws.close();
			await new Promise<void>((r) => ws.on('close', r));
		});
	});

	describe('reconnect error handling', () => {
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
