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

	const onceListeners = new Map<string, ((...args: unknown[]) => void)[]>();

	return {
		sent,
		on(event: string, handler: (...args: unknown[]) => void) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event)?.push(handler);
		},
		once(event: string, handler: (...args: unknown[]) => void) {
			if (!onceListeners.has(event)) onceListeners.set(event, []);
			onceListeners.get(event)?.push(handler);
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
			// Fire and remove once-listeners
			const once = onceListeners.get(event)?.splice(0) ?? [];
			for (const handler of once) {
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
				inputSampleRate: 24000,
				outputSampleRate: 24000,
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
		it('uses accumulated buffer from streamed deltas as primary arg source', () => {
			const calls: unknown[] = [];
			transport.onToolCall = (c) => calls.push(...c);

			// Simulate streamed function call arguments
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_1',
				delta: '{"inp',
			});
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_1',
				delta: 'ut":"from_buffer"}',
			});

			// Tool call complete — item.arguments differs from buffer to prove buffer wins
			mockRt.emit('response.output_item.done', {
				item: {
					id: 'item_1',
					type: 'function_call',
					call_id: 'call_1',
					name: 'test_tool',
					arguments: '{"input":"from_done_event"}',
				},
			});

			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual({
				id: 'call_1',
				name: 'test_tool',
				args: { input: 'from_buffer' },
			});
		});

		it('falls back to item.arguments when no deltas were streamed', () => {
			const calls: unknown[] = [];
			transport.onToolCall = (c) => calls.push(...c);

			// No delta events — only the done event with arguments
			mockRt.emit('response.output_item.done', {
				item: {
					id: 'item_2',
					type: 'function_call',
					call_id: 'call_2',
					name: 'test_tool',
					arguments: '{"input":"fallback"}',
				},
			});

			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual({
				id: 'call_2',
				name: 'test_tool',
				args: { input: 'fallback' },
			});
		});

		it('handles interleaved tool calls independently', () => {
			const calls: unknown[] = [];
			transport.onToolCall = (c) => calls.push(...c);

			// Two interleaved streams
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_a',
				delta: '{"x":',
			});
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_b',
				delta: '{"y":',
			});
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_a',
				delta: '1}',
			});
			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_b',
				delta: '2}',
			});

			mockRt.emit('response.output_item.done', {
				item: {
					id: 'item_a',
					type: 'function_call',
					call_id: 'ca',
					name: 'toolA',
					arguments: '{}',
				},
			});
			mockRt.emit('response.output_item.done', {
				item: {
					id: 'item_b',
					type: 'function_call',
					call_id: 'cb',
					name: 'toolB',
					arguments: '{}',
				},
			});

			expect(calls).toHaveLength(2);
			expect(calls[0]).toEqual({ id: 'ca', name: 'toolA', args: { x: 1 } });
			expect(calls[1]).toEqual({ id: 'cb', name: 'toolB', args: { y: 2 } });
		});

		it('fires onError and skips dispatch on malformed JSON args', () => {
			const calls: unknown[] = [];
			const errors: unknown[] = [];
			transport.onToolCall = (c) => calls.push(...c);
			transport.onError = (e) => errors.push(e);

			mockRt.emit('response.function_call_arguments.delta', {
				item_id: 'item_bad',
				delta: '{not valid json',
			});
			mockRt.emit('response.output_item.done', {
				item: {
					id: 'item_bad',
					type: 'function_call',
					call_id: 'call_bad',
					name: 'broken',
					arguments: '{also bad}',
				},
			});

			expect(calls).toHaveLength(0);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({ recoverable: true });
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
		it('sends conversation.item.create and response.create for immediate', () => {
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

		it('sends immediately when_idle and model is NOT generating', () => {
			transport.sendToolResult({
				id: 'call_1',
				name: 'test_tool',
				result: 'done',
				scheduling: 'when_idle',
			});

			expect(mockRt.sent).toContainEqual({
				type: 'conversation.item.create',
				item: expect.objectContaining({ call_id: 'call_1' }),
			});
			expect(mockRt.sent).toContainEqual({ type: 'response.create' });
		});

		it('buffers when_idle result while model is generating, flushes on response.done', () => {
			// Simulate model generating (response.created sets _isModelGenerating)
			mockRt.emit('response.created', {});

			transport.sendToolResult({
				id: 'call_1',
				name: 'test_tool',
				result: 'bg_result',
				scheduling: 'when_idle',
			});

			// Should NOT have sent the tool result yet
			const creates = mockRt.sent.filter((m) => m.type === 'conversation.item.create');
			expect(creates).toHaveLength(0);

			// Model finishes → response.done flushes the queue
			mockRt.emit('response.done', {});

			const afterFlush = mockRt.sent.filter((m) => m.type === 'conversation.item.create');
			expect(afterFlush).toHaveLength(1);
			expect(afterFlush[0]).toMatchObject({
				item: { call_id: 'call_1', output: 'bg_result' },
			});
			expect(mockRt.sent).toContainEqual({ type: 'response.create' });
		});

		it('sends response.cancel before result for interrupt scheduling', () => {
			// Model must be generating for cancel to be sent
			mockRt.emit('response.created', {});

			transport.sendToolResult({
				id: 'call_1',
				name: 'test_tool',
				result: 'urgent',
				scheduling: 'interrupt',
			});

			const cancelIdx = mockRt.sent.findIndex((m) => m.type === 'response.cancel');
			const createIdx = mockRt.sent.findIndex((m) => m.type === 'conversation.item.create');
			expect(cancelIdx).toBeGreaterThanOrEqual(0);
			expect(createIdx).toBeGreaterThan(cancelIdx);
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
		it('sends truncate (but not cancel) on speech_started when model is generating', () => {
			let interrupted = false;
			transport.onInterrupted = () => {
				interrupted = true;
			};

			// Start a response (sets _isModelGenerating)
			mockRt.emit('response.created', {});

			// Simulate assistant output item
			mockRt.emit('response.output_item.added', {
				item: { id: 'asst_item_1', role: 'assistant' },
			});

			// Simulate some audio output (2 bytes = 1 sample at 24kHz ≈ 0.042ms)
			const audioChunk = Buffer.alloc(4800).toString('base64'); // 2400 samples = 100ms
			mockRt.emit('response.output_audio.delta', { delta: audioChunk });

			// User starts speaking — server VAD auto-cancels, so we only truncate
			mockRt.emit('input_audio_buffer.speech_started', {});

			expect(mockRt.sent).toContainEqual({
				type: 'conversation.item.truncate',
				item_id: 'asst_item_1',
				content_index: 0,
				audio_end_ms: 100,
			});
			// No response.cancel — server handles cancellation in server VAD mode
			const cancels = mockRt.sent.filter((m) => m.type === 'response.cancel');
			expect(cancels).toHaveLength(0);
			expect(interrupted).toBe(true);
		});

		it('does not send cancel/truncate when model is idle', () => {
			let interrupted = false;
			transport.onInterrupted = () => {
				interrupted = true;
			};

			// No response.created — model is idle
			mockRt.emit('input_audio_buffer.speech_started', {});

			const cancels = mockRt.sent.filter((m) => m.type === 'response.cancel');
			const truncates = mockRt.sent.filter((m) => m.type === 'conversation.item.truncate');
			expect(cancels).toHaveLength(0);
			expect(truncates).toHaveLength(0);
			expect(interrupted).toBe(false);
		});

		it('resets lastAssistantItemId on response.done so stale truncation is avoided', () => {
			// First response with audio
			mockRt.emit('response.created', {});
			mockRt.emit('response.output_item.added', {
				item: { id: 'asst_old', role: 'assistant' },
			});
			mockRt.emit('response.done', {});

			// User starts speaking after response completed — model is idle
			mockRt.emit('input_audio_buffer.speech_started', {});

			const truncates = mockRt.sent.filter((m) => m.type === 'conversation.item.truncate');
			expect(truncates).toHaveLength(0);
		});

		it('response.created enables interruption even before output_item.added', () => {
			let interrupted = false;
			transport.onInterrupted = () => {
				interrupted = true;
			};

			// Response created but no output items yet
			mockRt.emit('response.created', {});
			mockRt.emit('input_audio_buffer.speech_started', {});

			// onInterrupted should fire (response was active)
			expect(interrupted).toBe(true);

			// No truncation (no assistant item tracked yet) and no cancel (server VAD)
			const truncates = mockRt.sent.filter((m) => m.type === 'conversation.item.truncate');
			const cancels = mockRt.sent.filter((m) => m.type === 'response.cancel');
			expect(truncates).toHaveLength(0);
			expect(cancels).toHaveLength(0);
		});
	});

	describe('audio suppression after interruption', () => {
		it('suppresses audio output after speech_started until next response.created', () => {
			const audioChunks: string[] = [];
			transport.onAudioOutput = (data) => audioChunks.push(data);

			// Start a response and emit audio
			mockRt.emit('response.created', {});
			mockRt.emit('response.output_audio.delta', { delta: 'AQID' }); // chunk 1
			expect(audioChunks).toHaveLength(1);

			// Interruption: speech_started suppresses subsequent audio
			mockRt.emit('response.output_item.added', {
				item: { role: 'assistant', id: 'item_1' },
			});
			mockRt.emit('input_audio_buffer.speech_started', {});
			mockRt.emit('response.output_audio.delta', { delta: 'BAUG' }); // chunk 2 — suppressed
			mockRt.emit('response.output_audio.delta', { delta: 'BwgJ' }); // chunk 3 — suppressed
			expect(audioChunks).toHaveLength(1); // still 1

			// response.done (cancelled) arrives
			mockRt.emit('response.done', {});

			// New response starts — audio resumes
			mockRt.emit('response.created', {});
			mockRt.emit('response.output_audio.delta', { delta: 'CgsM' }); // chunk 4 — forwarded
			expect(audioChunks).toHaveLength(2);
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

		it('fires onOutputTranscription on streaming deltas', () => {
			const chunks: string[] = [];
			transport.onOutputTranscription = (t) => {
				chunks.push(t);
			};

			mockRt.emit('response.output_audio_transcript.delta', {
				delta: 'Hi ',
			});
			mockRt.emit('response.output_audio_transcript.delta', {
				delta: 'there',
			});

			expect(chunks).toEqual(['Hi ', 'there']);
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
		it('marks transient errors as recoverable', () => {
			let err: unknown = null;
			transport.onError = (e) => {
				err = e;
			};

			const error = new Error('rate limit');
			mockRt.emit('error', error);

			expect(err).toEqual({
				error: expect.objectContaining({ message: 'rate limit' }),
				recoverable: true,
			});
		});

		it('marks server_error as recoverable', () => {
			let err: unknown = null;
			transport.onError = (e) => {
				err = e;
			};

			const error = Object.assign(new Error('server error'), {
				error: { type: 'server_error', message: 'internal' },
			});
			mockRt.emit('error', error);
			expect(err).toMatchObject({ recoverable: true });
		});

		it('marks authentication_error as non-recoverable', () => {
			let err: unknown = null;
			transport.onError = (e) => {
				err = e;
			};

			const error = Object.assign(new Error('bad key'), {
				error: { type: 'authentication_error', message: 'invalid key' },
			});
			mockRt.emit('error', error);
			expect(err).toMatchObject({ recoverable: false });
		});

		it('marks invalid_request_error as non-recoverable', () => {
			let err: unknown = null;
			transport.onError = (e) => {
				err = e;
			};

			const error = Object.assign(new Error('bad request'), {
				error: { type: 'invalid_request_error', message: 'malformed' },
			});
			mockRt.emit('error', error);
			expect(err).toMatchObject({ recoverable: false });
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
		it('does NOT fire onSessionReady from session.created event (moved to connect)', () => {
			let sessionId = '';
			transport.onSessionReady = (id) => {
				sessionId = id;
			};

			// session.created via wireEventListeners() should NOT trigger onSessionReady
			// (onSessionReady is now fired at the end of connect() after session.updated)
			mockRt.emit('session.created', { session: { id: 'sess_abc123' } });
			expect(sessionId).toBe('');
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
