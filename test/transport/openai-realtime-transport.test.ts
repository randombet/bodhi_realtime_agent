// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAIRealtimeTransport } from '../../src/transport/openai-realtime-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';

/**
 * Mock for the OpenAI SDK's realtime connection.
 * Simulates the event-based interface of OpenAIRealtimeWS.
 */
function createMockRt() {
	const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	const socketListeners = new Map<string, ((...args: unknown[]) => void)[]>();
	const sent: Record<string, unknown>[] = [];

	return {
		sent,
		on(event: string, handler: (...args: unknown[]) => void) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event)?.push(handler);
		},
		send(message: Record<string, unknown>) {
			sent.push(message);

			// Auto-respond to session.update with session.updated
			if (message.type === 'session.update') {
				queueMicrotask(() => this.emit('session.updated', {}));
			}
		},
		close: vi.fn(),
		emit(event: string, data: unknown) {
			for (const handler of listeners.get(event) ?? []) {
				handler(data);
			}
		},
		// Raw WebSocket mock — close events fire here
		socket: {
			on(event: string, handler: (...args: unknown[]) => void) {
				if (!socketListeners.has(event)) socketListeners.set(event, []);
				socketListeners.get(event)?.push(handler);
			},
			emit(event: string, ...args: unknown[]) {
				for (const handler of socketListeners.get(event) ?? []) {
					handler(...args);
				}
			},
		},
	};
}

/** Helper: create a minimal ToolDefinition for testing. */
function makeTool(name: string): ToolDefinition {
	return {
		name,
		description: `Test tool ${name}`,
		parameters: z.object({ input: z.string() }),
		execution: 'inline',
		execute: async () => 'result',
	};
}

describe('OpenAIRealtimeTransport', () => {
	let transport: OpenAIRealtimeTransport;
	let mockRt: ReturnType<typeof createMockRt>;

	beforeEach(() => {
		transport = new OpenAIRealtimeTransport({ apiKey: 'test-key', model: 'gpt-realtime' });
		mockRt = createMockRt();

		// Inject mock rt by overriding the connect flow
		// biome-ignore lint/suspicious/noExplicitAny: test mock injection
		(transport as any).rt = mockRt;
		// biome-ignore lint/suspicious/noExplicitAny: test mock injection
		(transport as any)._isConnected = true;
		// Wire event listeners manually since we bypassed connect()
		// biome-ignore lint/suspicious/noExplicitAny: test mock injection
		(transport as any).wireEventListeners();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('capabilities and audioFormat', () => {
		it('reports correct capabilities', () => {
			expect(transport.capabilities).toEqual({
				messageTruncation: true,
				turnDetection: true,
				userTranscription: true,
				inPlaceSessionUpdate: true,
				sessionResumption: false,
				contextCompression: false,
				groundingMetadata: false,
			});
		});

		it('reports 24kHz audio format', () => {
			expect(transport.audioFormat).toEqual({
				sampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			});
		});
	});

	describe('sendAudio', () => {
		it('sends input_audio_buffer.append event', () => {
			transport.sendAudio('dGVzdA==');
			expect(mockRt.sent).toContainEqual({
				type: 'input_audio_buffer.append',
				audio: 'dGVzdA==',
			});
		});

		it('does not send when disconnected', () => {
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			(transport as any)._isConnected = false;
			transport.sendAudio('dGVzdA==');
			expect(mockRt.sent).toHaveLength(0);
		});
	});

	describe('commitAudio and clearAudio', () => {
		it('sends commit event', () => {
			transport.commitAudio();
			expect(mockRt.sent).toContainEqual({ type: 'input_audio_buffer.commit' });
		});

		it('sends clear event', () => {
			transport.clearAudio();
			expect(mockRt.sent).toContainEqual({ type: 'input_audio_buffer.clear' });
		});
	});

	describe('tool call handling', () => {
		it('accumulates streamed args and fires onToolCall on output_item.done', () => {
			const calls: unknown[] = [];
			transport.onToolCall = (c) => calls.push(...c);

			// Simulate streamed function call arguments
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_1',
				delta: '{"inp',
			});
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_1',
				delta: 'ut":"hello"}',
			});

			// Tool call complete
			mockRt.emit('response.output_item.done', {
				item: {
					id: 'item_1',
					type: 'function_call',
					call_id: 'call_1',
					name: 'test_tool',
					arguments: '{"input":"hello"}',
				},
			});

			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual({
				id: 'call_1',
				name: 'test_tool',
				args: { input: 'hello' },
			});
		});

		it('ignores non-function_call output items', () => {
			const calls: unknown[] = [];
			transport.onToolCall = (c) => calls.push(...c);

			mockRt.emit('response.output_item.done', {
				item: { id: 'item_1', type: 'message', role: 'assistant' },
			});

			expect(calls).toHaveLength(0);
		});
	});

	describe('sendToolResult', () => {
		it('sends conversation.item.create and response.create', () => {
			transport.sendToolResult({
				id: 'call_1',
				name: 'test_tool',
				result: { answer: 42 },
			});

			expect(mockRt.sent).toContainEqual({
				type: 'conversation.item.create',
				item: {
					type: 'function_call_output',
					call_id: 'call_1',
					output: '{"answer":42}',
				},
			});
			expect(mockRt.sent).toContainEqual({ type: 'response.create' });
		});

		it('skips response.create for silent scheduling', () => {
			transport.sendToolResult({
				id: 'call_1',
				name: 'test_tool',
				result: 'done',
				scheduling: 'silent',
			});

			const responseCreates = mockRt.sent.filter((m) => m.type === 'response.create');
			expect(responseCreates).toHaveLength(0);
		});

		it('sends response.create for when_idle scheduling', () => {
			transport.sendToolResult({
				id: 'call_1',
				name: 'test_tool',
				result: 'done',
				scheduling: 'when_idle',
			});

			expect(mockRt.sent).toContainEqual({ type: 'response.create' });
		});
	});

	describe('sendContent', () => {
		it('creates conversation items and triggers response', () => {
			transport.sendContent([{ role: 'user', text: 'Hello!' }], true);

			expect(mockRt.sent).toContainEqual({
				type: 'conversation.item.create',
				item: {
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text: 'Hello!' }],
				},
			});
			expect(mockRt.sent).toContainEqual({ type: 'response.create' });
		});

		it('skips response.create when turnComplete is false', () => {
			transport.sendContent([{ role: 'user', text: 'context' }], false);

			const responseCreates = mockRt.sent.filter((m) => m.type === 'response.create');
			expect(responseCreates).toHaveLength(0);
		});

		it('sends multiple turns with correct content types', () => {
			transport.sendContent([
				{ role: 'user', text: 'Hi' },
				{ role: 'assistant', text: 'Hello' },
			]);

			const items = mockRt.sent.filter((m) => m.type === 'conversation.item.create');
			expect(items).toHaveLength(2);

			// User message should use input_text
			expect(items[0]).toMatchObject({
				item: { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
			});
			// Assistant message should use output_text
			expect(items[1]).toMatchObject({
				item: { role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] },
			});
		});
	});

	describe('triggerGeneration', () => {
		it('sends response.create without instructions', () => {
			transport.triggerGeneration();
			expect(mockRt.sent).toContainEqual({ type: 'response.create' });
		});

		it('sends response.create with per-response instructions', () => {
			transport.triggerGeneration('Greet the user warmly.');
			expect(mockRt.sent).toContainEqual({
				type: 'response.create',
				response: { instructions: 'Greet the user warmly.' },
			});
		});
	});

	describe('updateSession', () => {
		it('sends session.update with new instructions', () => {
			transport.updateSession({ instructions: 'New instructions' });

			expect(mockRt.sent).toContainEqual({
				type: 'session.update',
				session: { instructions: 'New instructions' },
			});
		});

		it('sends session.update with new tools', () => {
			const tool = makeTool('calculator');
			transport.updateSession({ tools: [tool] });

			const sessionUpdate = mockRt.sent.find(
				(m) => m.type === 'session.update' && (m.session as Record<string, unknown>).tools,
			);
			expect(sessionUpdate).toBeDefined();
			const tools = (sessionUpdate?.session as Record<string, unknown>).tools as Record<
				string,
				unknown
			>[];
			expect(tools[0]).toMatchObject({ type: 'function', name: 'calculator' });
		});
	});

	describe('transferSession', () => {
		it('sends session.update (in-place, no reconnect)', async () => {
			const tool = makeTool('math');
			await transport.transferSession({
				instructions: 'You are a math expert.',
				tools: [tool],
			});

			const update = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					(m.session as Record<string, unknown>).instructions === 'You are a math expert.',
			);
			expect(update).toBeDefined();

			// Verify no disconnect was called
			expect(mockRt.close).not.toHaveBeenCalled();
		});
	});

	describe('interruption handling', () => {
		it('sends truncate and cancel on speech_started', () => {
			let interrupted = false;
			transport.onInterrupted = () => {
				interrupted = true;
			};

			// Simulate assistant output item
			mockRt.emit('response.output_item.added', {
				item: { id: 'asst_item_1', role: 'assistant' },
			});

			// Simulate some audio output (2 bytes = 1 sample at 24kHz ≈ 0.042ms)
			const audioChunk = Buffer.alloc(4800).toString('base64'); // 2400 samples = 100ms
			mockRt.emit('response.output_audio.delta', { delta: audioChunk });

			// User starts speaking
			mockRt.emit('input_audio_buffer.speech_started', {});

			expect(mockRt.sent).toContainEqual({
				type: 'conversation.item.truncate',
				item_id: 'asst_item_1',
				content_index: 0,
				audio_end_ms: 100,
			});
			expect(mockRt.sent).toContainEqual({ type: 'response.cancel' });
			expect(interrupted).toBe(true);
		});
	});

	describe('transcription callbacks', () => {
		it('fires onInputTranscription', () => {
			let transcript = '';
			transport.onInputTranscription = (t) => {
				transcript = t;
			};

			mockRt.emit('conversation.item.input_audio_transcription.completed', {
				transcript: 'Hello world',
			});

			expect(transcript).toBe('Hello world');
		});

		it('fires onOutputTranscription', () => {
			let transcript = '';
			transport.onOutputTranscription = (t) => {
				transcript = t;
			};

			mockRt.emit('response.output_audio_transcript.done', {
				transcript: 'Hi there',
			});

			expect(transcript).toBe('Hi there');
		});
	});

	describe('turn complete', () => {
		it('fires onTurnComplete on response.done', () => {
			let turnComplete = false;
			transport.onTurnComplete = () => {
				turnComplete = true;
			};

			mockRt.emit('response.done', {});
			expect(turnComplete).toBe(true);
		});
	});

	describe('error and close', () => {
		it('fires onError on error event', () => {
			let err: unknown = null;
			transport.onError = (e) => {
				err = e;
			};

			// The emitter passes OpenAIRealtimeError (extends Error) to the error handler
			const error = new Error('rate limit');
			mockRt.emit('error', error);

			expect(err).toEqual({
				error: expect.objectContaining({ message: 'rate limit' }),
				recoverable: true,
			});
		});

		it('fires onClose on socket close event', () => {
			let closeCode: number | undefined;
			let closeReason: string | undefined;
			transport.onClose = (code, reason) => {
				closeCode = code;
				closeReason = reason;
			};

			// Close events come via the raw WebSocket, not the typed emitter
			mockRt.socket.emit('close', 1000, Buffer.from('normal'));

			expect(closeCode).toBe(1000);
			expect(closeReason).toBe('normal');
		});

		it('sets isConnected to false on close', () => {
			expect(transport.isConnected).toBe(true);
			mockRt.socket.emit('close', 1000, Buffer.from(''));
			expect(transport.isConnected).toBe(false);
		});
	});

	describe('session ready', () => {
		it('fires onSessionReady on session.created', () => {
			let sessionId = '';
			transport.onSessionReady = (id) => {
				sessionId = id;
			};

			mockRt.emit('session.created', { session: { id: 'sess_abc123' } });
			expect(sessionId).toBe('sess_abc123');
		});
	});

	describe('disconnect', () => {
		it('clears state and closes connection', async () => {
			await transport.disconnect();

			expect(transport.isConnected).toBe(false);
			expect(mockRt.close).toHaveBeenCalled();
		});
	});
});
