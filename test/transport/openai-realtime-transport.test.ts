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
				textResponseModality: true,
				parallelToolCalls: false,
				reasoningEffort: false,
				automaticPreambles: false,
				quiescible: true,
			});
		});

		it('reports 24kHz audio format', () => {
			expect(transport.audioFormat).toEqual({
				inputSampleRate: 24000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
				outputBitDepth: 16,
				outputEncoding: 'pcm',
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
			// Phase 1.3: tool-call dispatch is batched on response.done.
			mockRt.emit('response.done', { response: { id: 'resp_1' } });

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
			mockRt.emit('response.done', { response: { id: 'resp_2' } });

			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual({
				id: 'call_2',
				name: 'test_tool',
				args: { input: 'fallback' },
			});
		});

		it('handles interleaved tool calls independently and batches dispatch', () => {
			// Phase 1.3: two parallel function_call items arrive in one response;
			// the transport batches them and dispatches via a single onToolCall(calls[]).
			const dispatches: unknown[][] = [];
			transport.onToolCall = (c) => dispatches.push(c);

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
			mockRt.emit('response.done', { response: { id: 'resp_parallel' } });

			// Single dispatch with both calls — not two separate dispatches.
			expect(dispatches).toHaveLength(1);
			expect(dispatches[0]).toHaveLength(2);
			expect(dispatches[0][0]).toEqual({ id: 'ca', name: 'toolA', args: { x: 1 } });
			expect(dispatches[0][1]).toEqual({ id: 'cb', name: 'toolB', args: { y: 2 } });
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

		it('sends session.update with output_modalities when responseModality is provided', () => {
			transport.updateSession({ responseModality: 'text' });

			expect(mockRt.sent).toContainEqual({
				type: 'session.update',
				session: { output_modalities: ['text'] },
			});
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

		it('includes output_modalities in transfer session.update when responseModality is provided', async () => {
			await transport.transferSession({ responseModality: 'text' });

			expect(mockRt.sent).toContainEqual({
				type: 'session.update',
				session: { output_modalities: ['text'] },
			});
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

	describe('text-mode responses', () => {
		it('fires onTextOutput on text delta events', () => {
			const textOutput = vi.fn();
			transport.onTextOutput = textOutput;

			mockRt.emit('response.output_text.delta', { delta: 'Hello ' });
			mockRt.emit('response.output_text.delta', { delta: 'world' });

			expect(textOutput).toHaveBeenCalledTimes(2);
			expect(textOutput).toHaveBeenCalledWith('Hello ');
			expect(textOutput).toHaveBeenCalledWith('world');
		});

		it('fires onTextDone on text done event', () => {
			const textDone = vi.fn();
			transport.onTextDone = textDone;

			mockRt.emit('response.output_text.done', {});

			expect(textDone).toHaveBeenCalledOnce();
		});

		it('fires onTextDone before onTurnComplete (ordering contract)', () => {
			const order: string[] = [];
			transport.onTextDone = () => order.push('textDone');
			transport.onTurnComplete = () => order.push('turnComplete');

			// onTextDone fires on response.output_text.done
			mockRt.emit('response.output_text.done', {});
			// onTurnComplete fires on response.done
			mockRt.emit('response.done', {});

			expect(order).toEqual(['textDone', 'turnComplete']);
		});

		it('fires onSpeechStarted on speech_started event', () => {
			const speechStarted = vi.fn();
			transport.onSpeechStarted = speechStarted;

			// speech_started fires even when model is not generating (for TTS barge-in)
			mockRt.emit('input_audio_buffer.speech_started', {});

			expect(speechStarted).toHaveBeenCalledOnce();
		});

		it('fires onSpeechStarted even when model is not generating', () => {
			const speechStarted = vi.fn();
			const interrupted = vi.fn();
			transport.onSpeechStarted = speechStarted;
			transport.onInterrupted = interrupted;

			// When model is NOT generating, speech_started still fires onSpeechStarted
			// but does NOT fire onInterrupted
			// biome-ignore lint/suspicious/noExplicitAny: test mock injection
			(transport as any)._isModelGenerating = false;
			mockRt.emit('input_audio_buffer.speech_started', {});

			expect(speechStarted).toHaveBeenCalledOnce();
			expect(interrupted).not.toHaveBeenCalled();
		});

		it('preserves responseModality across applyTransportConfig', () => {
			// biome-ignore lint/suspicious/noExplicitAny: test internal state
			(transport as any).applyTransportConfig({
				auth: { type: 'api_key', apiKey: 'test' },
				model: 'gpt-4o-realtime',
				responseModality: 'text',
			});

			// biome-ignore lint/suspicious/noExplicitAny: test internal state
			expect((transport as any)._textMode).toBe(true);
		});
	});
});

// ---------------------------------------------------------------------------
// Phase 1 features: gpt-realtime-2 reasoning, parallel tools (covered above
// under "tool call handling"), audio format, quiesce/unquiesce, onCacheBust.
// ---------------------------------------------------------------------------

describe('OpenAIRealtimeTransport — Phase 1 features (gpt-realtime-2)', () => {
	let transport: OpenAIRealtimeTransport;
	let mockRt: ReturnType<typeof createMockRt>;

	function setup(config: Parameters<typeof OpenAIRealtimeTransport.prototype.constructor>[0]) {
		transport = new OpenAIRealtimeTransport(config);
		mockRt = createMockRt();
		// biome-ignore lint/suspicious/noExplicitAny: test mock injection
		(transport as any).rt = mockRt;
		// biome-ignore lint/suspicious/noExplicitAny: test mock injection
		(transport as any)._isConnected = true;
		// biome-ignore lint/suspicious/noExplicitAny: test mock injection
		(transport as any).wireEventListeners();
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('capabilities resolve from model', () => {
		it('gpt-realtime-2 enables reasoningEffort, parallelToolCalls, automaticPreambles', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			expect(transport.capabilities.reasoningEffort).toBe(true);
			expect(transport.capabilities.parallelToolCalls).toBe(true);
			expect(transport.capabilities.automaticPreambles).toBe(true);
			expect(transport.capabilities.quiescible).toBe(true);
		});

		it('gpt-realtime (legacy) disables reasoning + parallel tools + preambles', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime' });
			expect(transport.capabilities.reasoningEffort).toBe(false);
			expect(transport.capabilities.parallelToolCalls).toBe(false);
			expect(transport.capabilities.automaticPreambles).toBe(false);
		});

		it('unknown model defaults to all-false on gated flags', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-future' });
			expect(transport.capabilities.reasoningEffort).toBe(false);
			expect(transport.capabilities.parallelToolCalls).toBe(false);
		});
	});

	describe('reasoning serialisation gating', () => {
		it('serialises reasoning into session config for gpt-realtime-2', () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				reasoning: { effort: 'low', summary: 'auto' },
			});
			// biome-ignore lint/suspicious/noExplicitAny: probing build-config output
			const session = (transport as any).buildSessionConfig();
			expect(session.reasoning).toEqual({ effort: 'low', summary: 'auto' });
		});

		it('drops reasoning silently with warn on older model (strict=false)', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			setup({
				apiKey: 'test',
				model: 'gpt-realtime',
				reasoning: { effort: 'low' },
			});
			// biome-ignore lint/suspicious/noExplicitAny: probing build-config output
			const session = (transport as any).buildSessionConfig();
			expect(session.reasoning).toBeUndefined();
			expect(warn).toHaveBeenCalled();
			expect((warn.mock.calls[0]?.[0] as string) ?? '').toContain('reasoning');
		});

		it('throws UNSUPPORTED_FEATURE on older model when strict=true', () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime',
				reasoning: { effort: 'low' },
				strict: true,
			});
			// biome-ignore lint/suspicious/noExplicitAny: probing build-config output
			expect(() => (transport as any).buildSessionConfig()).toThrow(/UNSUPPORTED_FEATURE/);
		});
	});

	describe('reasoning lifecycle callbacks', () => {
		it('fires onReasoningStart/Done with durationMs', async () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const started = vi.fn();
			const done = vi.fn();
			transport.onReasoningStart = started;
			transport.onReasoningDone = done;

			mockRt.emit('response.created', { response: { id: 'r1' } });
			mockRt.emit('response.output_item.added', {
				item: { id: 'r_item', type: 'reasoning' } as unknown,
			});
			expect(started).toHaveBeenCalledOnce();

			await new Promise((r) => setTimeout(r, 5));

			mockRt.emit('response.output_item.done', {
				item: { id: 'r_item', type: 'reasoning' } as unknown,
			});
			expect(done).toHaveBeenCalledOnce();
			const info = done.mock.calls[0]?.[0] as { durationMs: number };
			expect(info.durationMs).toBeGreaterThanOrEqual(0);
		});

		it('streams reasoning summary text to onReasoningSummary', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const chunks: string[] = [];
			transport.onReasoningSummary = (t) => chunks.push(t);

			mockRt.emit('response.reasoning_summary_text.delta', { delta: 'Thinking ' });
			mockRt.emit('response.reasoning_summary_text.delta', { delta: 'about it.' });

			expect(chunks).toEqual(['Thinking ', 'about it.']);
		});
	});

	describe('audio format propagation', () => {
		it('PCM 24 kHz is the default; bytesPerSample = 2', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			expect(transport.audioFormat).toEqual({
				inputSampleRate: 24000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
				outputBitDepth: 16,
				outputEncoding: 'pcm',
			});
		});

		it('G.711 mu-law: input rate = 8000, bitDepth = 8, encoding = pcmu', () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				audioInputFormat: { type: 'audio/pcmu' },
				audioOutputFormat: { type: 'audio/pcmu' },
			});
			expect(transport.audioFormat.encoding).toBe('pcmu');
			expect(transport.audioFormat.bitDepth).toBe(8);
			expect(transport.audioFormat.inputSampleRate).toBe(8000);
			expect(transport.audioFormat.outputSampleRate).toBe(8000);
		});

		it('rejects non-24 kHz PCM rate at build-session-config time', () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				audioInputFormat: { type: 'audio/pcm', rate: 16000 },
			});
			// biome-ignore lint/suspicious/noExplicitAny: probing build-config output
			expect(() => (transport as any).buildSessionConfig()).toThrow(/UNSUPPORTED_SAMPLE_RATE/);
		});

		it('interruption math uses output rate + bytes-per-sample from format', () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				audioInputFormat: { type: 'audio/pcmu' },
				audioOutputFormat: { type: 'audio/pcmu' },
			});
			// Feed 1 second of G.711 audio: 8000 samples × 1 byte = 8000 bytes.
			const oneSecMuLaw = Buffer.alloc(8000).toString('base64');
			mockRt.emit('response.output_audio.delta', { delta: oneSecMuLaw });

			// biome-ignore lint/suspicious/noExplicitAny: probing internal state
			const ms = (transport as any).audioOutputMs as number;
			expect(ms).toBeCloseTo(1000, -1);
		});
	});

	describe('triggerGeneration with reasoning override', () => {
		it('emits response.create with response.reasoning when overrides supplied', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			transport.triggerGeneration('clarify', { reasoning: { effort: 'medium' } });
			const last = mockRt.sent[mockRt.sent.length - 1] as {
				type: string;
				response?: { instructions?: string; reasoning?: { effort?: string } };
			};
			expect(last.type).toBe('response.create');
			expect(last.response?.instructions).toBe('clarify');
			expect(last.response?.reasoning?.effort).toBe('medium');
		});

		it('drops reasoning override silently for models that do not support it', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime' });
			transport.triggerGeneration(undefined, { reasoning: { effort: 'medium' } });
			const last = mockRt.sent[mockRt.sent.length - 1] as {
				type: string;
				response?: { reasoning?: unknown };
			};
			// No response.reasoning landed in the payload.
			expect(last.response?.reasoning).toBeUndefined();
		});

		it('preserves existing behaviour when no overrides are supplied', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			transport.triggerGeneration();
			const last = mockRt.sent[mockRt.sent.length - 1] as { type: string; response?: unknown };
			expect(last.type).toBe('response.create');
			expect(last.response).toBeUndefined();
		});
	});

	describe('quiesce / unquiesce', () => {
		it('quiesce sends response.cancel when a response is in flight and suppresses audio', async () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const audio: string[] = [];
			transport.onAudioOutput = (d) => audio.push(d);

			mockRt.emit('response.created', { response: { id: 'r1' } });
			mockRt.emit('response.output_audio.delta', { delta: Buffer.alloc(4).toString('base64') });
			expect(audio).toHaveLength(1);

			await transport.quiesce?.();

			const cancel = mockRt.sent.find((m) => m.type === 'response.cancel');
			expect(cancel).toBeDefined();

			// Subsequent audio is suppressed.
			mockRt.emit('response.output_audio.delta', { delta: Buffer.alloc(4).toString('base64') });
			expect(audio).toHaveLength(1);

			// Unquiesce — audio flows again.
			await transport.unquiesce?.();
			mockRt.emit('response.output_audio.delta', { delta: Buffer.alloc(4).toString('base64') });
			expect(audio).toHaveLength(2);
		});

		it('quiesce is a no-op (no response.cancel) when nothing is generating', async () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			await transport.quiesce?.();
			expect(mockRt.sent.find((m) => m.type === 'response.cancel')).toBeUndefined();
		});

		it('quiesce / unquiesce are idempotent', async () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			mockRt.emit('response.created', { response: { id: 'r1' } });
			await transport.quiesce?.();
			await transport.quiesce?.();
			// Only one response.cancel because second call sees _isModelGenerating=false.
			const cancels = mockRt.sent.filter((m) => m.type === 'response.cancel');
			expect(cancels).toHaveLength(1);

			await transport.unquiesce?.();
			await transport.unquiesce?.();
			// No-op pair; nothing extra sent.
			expect(mockRt.sent.filter((m) => m.type === 'response.cancel')).toHaveLength(1);
		});

		it('defers when_idle response.create until unquiesce (no leak during dictation mode)', async () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });

			// Simulate: model is generating in agent mode → a when_idle tool result
			// arrives → it's buffered in _pendingWhenIdle.
			mockRt.emit('response.created', { response: { id: 'r1' } });
			transport.sendToolResult({
				id: 'call_bg',
				name: 'background_task',
				result: { ok: true },
				scheduling: 'when_idle',
			});
			// Nothing flushed yet — model is still generating.
			expect(mockRt.sent.filter((m) => m.type === 'conversation.item.create')).toHaveLength(0);

			// Session flips to transcription mode (e.g., via VoiceSession).
			await transport.quiesce?.();

			// While quiesced, response.done arrives — flush MUST NOT fire response.create.
			mockRt.emit('response.done', { response: { id: 'r1' } });
			expect(mockRt.sent.filter((m) => m.type === 'response.create')).toHaveLength(0);
			expect(mockRt.sent.filter((m) => m.type === 'conversation.item.create')).toHaveLength(0);

			// Unquiesce drains the deferred queue: one item.create + one response.create.
			await transport.unquiesce?.();
			expect(mockRt.sent.filter((m) => m.type === 'conversation.item.create')).toHaveLength(1);
			expect(mockRt.sent.filter((m) => m.type === 'response.create')).toHaveLength(1);
		});
	});

	describe('onCacheBust telemetry', () => {
		it('fires instructions_changed on updateSession({ instructions })', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const reasons: string[] = [];
			transport.onCacheBust = (r) => reasons.push(r);

			transport.updateSession({ instructions: 'be helpful' });
			expect(reasons).toEqual(['instructions_changed']);
		});

		it('fires tools_changed on updateSession({ tools })', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const reasons: string[] = [];
			transport.onCacheBust = (r) => reasons.push(r);

			transport.updateSession({ tools: [makeTool('a')] });
			expect(reasons).toEqual(['tools_changed']);
		});

		it('prefers instructions_changed when both fields change in one call', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const reasons: string[] = [];
			transport.onCacheBust = (r) => reasons.push(r);

			transport.updateSession({ instructions: 'x', tools: [makeTool('a')] });
			expect(reasons).toEqual(['instructions_changed']);
		});

		it('does not fire on sendContent (tail append, no prefix mutation)', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const reasons: string[] = [];
			transport.onCacheBust = (r) => reasons.push(r);

			transport.sendContent([{ role: 'user', text: 'hi' }], true);
			expect(reasons).toEqual([]);
		});

		it('does not fire on responseModality-only updates', () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const reasons: string[] = [];
			transport.onCacheBust = (r) => reasons.push(r);

			transport.updateSession({ responseModality: 'text' });
			expect(reasons).toEqual([]);
		});
	});
});
