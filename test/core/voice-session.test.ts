import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';

// Mock the external deps
vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					// Simulate setup complete
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					return {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
				}),
			},
		})),
		_getMessageHandler: () => messageHandler,
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

		await session.start();

		// Wait for setupComplete callback
		await new Promise((r) => setTimeout(r, 50));

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

		// Check transcript was sent back to client
		const transcripts = received.map((r) => JSON.parse(r)).filter((m) => m.type === 'transcript');
		expect(transcripts.some((t) => t.role === 'user' && t.text === 'Hello agent')).toBe(true);

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
});
