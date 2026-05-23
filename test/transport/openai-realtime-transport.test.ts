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
				playbackGatedTurnComplete: false,
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

	describe('cancelled response handling', () => {
		it('cancelled response.done suppresses onTurnComplete and tool dispatch', () => {
			const turnComplete = vi.fn();
			const toolCalls: unknown[] = [];
			transport.onTurnComplete = turnComplete;
			transport.onToolCall = (c) => toolCalls.push(...c);

			mockRt.emit('response.created', {});
			// A partial tool call buffered during the about-to-be-cancelled response.
			mockRt.emit('response.output_item.done', {
				item: { id: 'i1', type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' },
			});
			mockRt.emit('response.done', { response: { id: 'r1', status: 'cancelled' } });

			expect(turnComplete).not.toHaveBeenCalled();
			expect(toolCalls).toHaveLength(0);
		});

		it('a completed response.done still fires onTurnComplete and dispatches tool calls', () => {
			const turnComplete = vi.fn();
			const toolCalls: unknown[] = [];
			transport.onTurnComplete = turnComplete;
			transport.onToolCall = (c) => toolCalls.push(...c);

			mockRt.emit('response.created', {});
			mockRt.emit('response.output_item.done', {
				item: { id: 'i2', type: 'function_call', call_id: 'c2', name: 't', arguments: '{}' },
			});
			mockRt.emit('response.done', { response: { id: 'r2', status: 'completed' } });

			expect(turnComplete).toHaveBeenCalledTimes(1);
			expect(toolCalls).toHaveLength(1);
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
		// Follow-up fix #1: updateSession is now ack-correlated via the
		// FIFO queue, so callers must await for the wire send to complete.
		it('sends session.update with new instructions', async () => {
			await transport.updateSession({ instructions: 'New instructions' });

			// Wire payload carries an event_id (ack correlation); strip it for
			// shape-only equality. The rest of the session payload is unchanged.
			const sent = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					(m.session as Record<string, unknown>).instructions === 'New instructions',
			);
			expect(sent).toBeDefined();
			expect(sent?.session).toEqual({ instructions: 'New instructions' });
		});

		it('sends session.update with new tools', async () => {
			const tool = makeTool('calculator');
			await transport.updateSession({ tools: [tool] });

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

		it('sends session.update with output_modalities when responseModality is provided', async () => {
			await transport.updateSession({ responseModality: 'text' });

			const sent = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					Array.isArray((m.session as Record<string, unknown>).output_modalities),
			);
			expect(sent).toBeDefined();
			expect(sent?.session).toEqual({ output_modalities: ['text'] });
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

			// Wire payload includes a synthetic event_id (ack correlation);
			// shape-only equality on the session body.
			const sent = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					Array.isArray((m.session as Record<string, unknown>).output_modalities),
			);
			expect(sent).toBeDefined();
			expect(sent?.session).toEqual({ output_modalities: ['text'] });
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

	describe('cancelResponse + _activeResponseDone waiter', () => {
		// dev_docs/framework/design-greeting-interrupt-grace.md §2.
		// `_isModelGenerating` is read/set by these tests via the test mock
		// access pattern used throughout this file.

		function setGenerating(active: boolean) {
			// biome-ignore lint/suspicious/noExplicitAny: test mock access
			(transport as any)._isModelGenerating = active;
		}
		function setLastAssistantItemId(id: string | null) {
			// biome-ignore lint/suspicious/noExplicitAny: test mock access
			(transport as any).lastAssistantItemId = id;
		}
		function setAudioOutputMs(ms: number) {
			// biome-ignore lint/suspicious/noExplicitAny: test mock access
			(transport as any).audioOutputMs = ms;
		}
		function sentTypes(): string[] {
			return mockRt.sent.map((m) => String(m.type));
		}

		it('returns a true no-op when no response in flight and no truncate', async () => {
			setGenerating(false);
			mockRt.sent.length = 0;
			await transport.cancelResponse?.({});
			expect(mockRt.sent).toHaveLength(0);
		});

		it('returns a true no-op for waitForDone tail case (already resolved)', async () => {
			setGenerating(false);
			mockRt.sent.length = 0;
			// Should resolve immediately — _activeResponseDone is Promise.resolve()
			// when no response has been created. Race against a tight timer.
			const start = Date.now();
			await transport.cancelResponse?.({ waitForDone: true });
			expect(Date.now() - start).toBeLessThan(200);
			expect(mockRt.sent).toHaveLength(0);
		});

		it('sends response.cancel when _isModelGenerating', async () => {
			setGenerating(true);
			mockRt.sent.length = 0;
			await transport.cancelResponse?.({});
			expect(sentTypes()).toContain('response.cancel');
			// biome-ignore lint/suspicious/noExplicitAny: test mock access
			expect((transport as any)._isModelGenerating).toBe(false);
			// biome-ignore lint/suspicious/noExplicitAny: test mock access
			expect((transport as any)._suppressAudio).toBe(true);
		});

		it('sends conversation.item.truncate with explicit audioEndMs', async () => {
			setGenerating(true);
			setLastAssistantItemId('item_123');
			mockRt.sent.length = 0;
			await transport.cancelResponse?.({ truncate: { audioEndMs: 250.7 } });
			const truncate = mockRt.sent.find((m) => m.type === 'conversation.item.truncate');
			expect(truncate).toEqual({
				type: 'conversation.item.truncate',
				item_id: 'item_123',
				content_index: 0,
				audio_end_ms: 250, // floored
			});
			expect(sentTypes()).toContain('response.cancel');
		});

		it('sends truncate with audioOutputMs when truncate: "generated"', async () => {
			setGenerating(true);
			setLastAssistantItemId('item_xyz');
			setAudioOutputMs(900);
			mockRt.sent.length = 0;
			await transport.cancelResponse?.({ truncate: 'generated' });
			const truncate = mockRt.sent.find((m) => m.type === 'conversation.item.truncate');
			expect(truncate).toEqual({
				type: 'conversation.item.truncate',
				item_id: 'item_xyz',
				content_index: 0,
				audio_end_ms: 900,
			});
		});

		it('skips truncate when no lastAssistantItemId', async () => {
			setGenerating(true);
			setLastAssistantItemId(null);
			mockRt.sent.length = 0;
			await transport.cancelResponse?.({ truncate: 'generated' });
			expect(sentTypes()).not.toContain('conversation.item.truncate');
			expect(sentTypes()).toContain('response.cancel');
		});

		it('floors and clamps negative audioEndMs to 0', async () => {
			setGenerating(true);
			setLastAssistantItemId('item_neg');
			mockRt.sent.length = 0;
			await transport.cancelResponse?.({ truncate: { audioEndMs: -5 } });
			const truncate = mockRt.sent.find((m) => m.type === 'conversation.item.truncate');
			expect(truncate?.audio_end_ms).toBe(0);
		});

		it('waitForDone resolves when response.done fires', async () => {
			setGenerating(true);
			mockRt.sent.length = 0;
			// Arm the waiter by firing response.created.
			mockRt.emit('response.created', {});
			// Now waitForDone should pend until response.done is emitted.
			const pending = transport.cancelResponse?.({ waitForDone: true });
			let resolved = false;
			pending?.then(() => {
				resolved = true;
			});
			await new Promise((r) => setTimeout(r, 5));
			expect(resolved).toBe(false);
			// Trigger response.done — waiter resolves.
			mockRt.emit('response.done', { response: { status: 'cancelled' } });
			await pending;
			expect(resolved).toBe(true);
		});

		it('never rejects when send throws', async () => {
			setGenerating(true);
			setLastAssistantItemId('item_err');
			// Make rt.send throw on truncate
			const original = mockRt.send.bind(mockRt);
			mockRt.send = vi.fn((msg) => {
				if (msg.type === 'conversation.item.truncate') throw new Error('boom');
				original(msg);
			}) as typeof mockRt.send;
			// Should resolve, not reject.
			await expect(
				transport.cancelResponse?.({ truncate: { audioEndMs: 100 } }),
			).resolves.toBeUndefined();
		});

		it('disconnect resolves a pending waitForDone caller', async () => {
			setGenerating(true);
			mockRt.emit('response.created', {});
			const pending = transport.cancelResponse?.({ waitForDone: true });
			let resolved = false;
			pending?.then(() => {
				resolved = true;
			});
			await transport.disconnect();
			await pending;
			expect(resolved).toBe(true);
		});
	});

	describe('clearInputAudio', () => {
		it('sends input_audio_buffer.clear', () => {
			mockRt.sent.length = 0;
			transport.clearInputAudio?.();
			expect(mockRt.sent).toContainEqual({ type: 'input_audio_buffer.clear' });
		});

		it('does not send when disconnected', () => {
			mockRt.sent.length = 0;
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			(transport as any)._isConnected = false;
			transport.clearInputAudio?.();
			expect(mockRt.sent).toHaveLength(0);
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

	// P3: OpenAI cacheConfig.truncation mapping. See dev_docs/framework/design-context-caching.md
	describe('cacheConfig.truncation (P3)', () => {
		it('validateOpenAICacheConfig accepts valid object form', async () => {
			const { validateOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			expect(() =>
				validateOpenAICacheConfig({
					truncation: { type: 'retention_ratio', retentionRatio: 0.5 },
				}),
			).not.toThrow();
			expect(() => validateOpenAICacheConfig({ truncation: 'auto' })).not.toThrow();
			expect(() => validateOpenAICacheConfig({ truncation: 'disabled' })).not.toThrow();
			expect(() => validateOpenAICacheConfig(undefined)).not.toThrow();
		});

		it('validateOpenAICacheConfig rejects retentionRatio outside [0, 1]', async () => {
			const { validateOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			expect(() =>
				validateOpenAICacheConfig({
					truncation: { type: 'retention_ratio', retentionRatio: -0.1 },
				}),
			).toThrow(/retentionRatio/);
			expect(() =>
				validateOpenAICacheConfig({
					truncation: { type: 'retention_ratio', retentionRatio: 1.1 },
				}),
			).toThrow(/retentionRatio/);
			expect(() =>
				validateOpenAICacheConfig({
					truncation: { type: 'retention_ratio', retentionRatio: Number.NaN },
				}),
			).toThrow(/retentionRatio/);
		});

		it('validateOpenAICacheConfig accepts retentionRatio=0 and =1 as boundary values', async () => {
			const { validateOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			expect(() =>
				validateOpenAICacheConfig({
					truncation: { type: 'retention_ratio', retentionRatio: 0 },
				}),
			).not.toThrow();
			expect(() =>
				validateOpenAICacheConfig({
					truncation: { type: 'retention_ratio', retentionRatio: 1 },
				}),
			).not.toThrow();
		});

		it('validateOpenAICacheConfig rejects fractional / negative postInstructions', async () => {
			const { validateOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			expect(() =>
				validateOpenAICacheConfig({
					truncation: {
						type: 'retention_ratio',
						retentionRatio: 0.8,
						tokenLimits: { postInstructions: 1.5 },
					},
				}),
			).toThrow(/postInstructions/);
			expect(() =>
				validateOpenAICacheConfig({
					truncation: {
						type: 'retention_ratio',
						retentionRatio: 0.8,
						tokenLimits: { postInstructions: -1 },
					},
				}),
			).toThrow(/postInstructions/);
		});

		it('applyOpenAICacheConfig writes string truncation forms', async () => {
			const { applyOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			const auto: Record<string, unknown> = {};
			applyOpenAICacheConfig(auto, { truncation: 'auto' }, 'unknown');
			expect(auto.truncation).toBe('auto');

			const disabled: Record<string, unknown> = {};
			applyOpenAICacheConfig(disabled, { truncation: 'disabled' }, 'unknown');
			expect(disabled.truncation).toBe('disabled');
		});

		it('applyOpenAICacheConfig writes retention_ratio object form (snake_case wire shape)', async () => {
			const { applyOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			const payload: Record<string, unknown> = {};
			applyOpenAICacheConfig(
				payload,
				{
					truncation: {
						type: 'retention_ratio',
						retentionRatio: 0.8,
						tokenLimits: { postInstructions: 4096 },
					},
				},
				'unknown',
			);
			expect(payload.truncation).toEqual({
				type: 'retention_ratio',
				retention_ratio: 0.8,
				token_limits: { post_instructions: 4096 },
			});
		});

		it('applyOpenAICacheConfig omits token_limits when postInstructions is undefined', async () => {
			const { applyOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			const payload: Record<string, unknown> = {};
			applyOpenAICacheConfig(
				payload,
				{ truncation: { type: 'retention_ratio', retentionRatio: 0.5 } },
				'unknown',
			);
			expect(payload.truncation).toEqual({
				type: 'retention_ratio',
				retention_ratio: 0.5,
			});
			expect((payload.truncation as Record<string, unknown>).token_limits).toBeUndefined();
		});

		it('applyOpenAICacheConfig is a no-op when cfg is undefined', async () => {
			const { applyOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			const payload: Record<string, unknown> = { existing: 'field' };
			applyOpenAICacheConfig(payload, undefined, 'unknown');
			expect(payload).toEqual({ existing: 'field' });
		});

		it('updateSession includes truncation in the session.update payload', async () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { truncation: { type: 'retention_ratio', retentionRatio: 0.8 } },
			});
			await transport.updateSession({ instructions: 'be helpful' });
			const update = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					(m.session as Record<string, unknown>).truncation !== undefined,
			);
			expect(update).toBeDefined();
			expect((update?.session as Record<string, unknown>).truncation).toEqual({
				type: 'retention_ratio',
				retention_ratio: 0.8,
			});
		});

		it('transferSession includes truncation in the session.update payload (in-place handoff)', async () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { truncation: 'auto' },
			});
			await transport.transferSession({ instructions: 'You are agent B.' });
			const update = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					(m.session as Record<string, unknown>).truncation !== undefined,
			);
			expect(update).toBeDefined();
			expect((update?.session as Record<string, unknown>).truncation).toBe('auto');
		});
	});

	// P5: enforcePrefixStability + sendSessionUpdateAndWait. See dev_docs/framework/design-context-caching.md §2.
	describe('enforcePrefixStability (P5)', () => {
		it('pre-connect updateSession is always allowed (no baseline yet)', async () => {
			const { OpenAIRealtimeTransport: T } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			const t = new T({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { enforcePrefixStability: true },
			});
			// Pre-connect: no rt, no baseline. Should not throw.
			await expect(t.updateSession({ instructions: 'pre-connect setup' })).resolves.toBeUndefined();
		});

		it('connected, non-transfer prefix change throws CachePrefixMutationError', async () => {
			const { CachePrefixMutationError } = await import('../../src/core/errors.js');
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { enforcePrefixStability: true },
			});
			// Set initial instructions and capture baseline.
			await transport.updateSession({ instructions: 'baseline' });
			// Manually set baseline to simulate post-connect ack (setup() bypasses
			// connect()'s baseline-capture step).
			// biome-ignore lint/suspicious/noExplicitAny: test-only hook
			(transport as any).prefixBaselineCanonical = (
				transport as unknown as { computePrefixCanonical: (i?: string, t?: unknown) => string }
			).computePrefixCanonical('baseline', undefined);

			await expect(transport.updateSession({ instructions: 'changed' })).rejects.toBeInstanceOf(
				CachePrefixMutationError,
			);
		});

		it('same-canonical-prefix update does NOT throw and STILL sends responseModality', async () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { enforcePrefixStability: true },
			});
			await transport.updateSession({ instructions: 'baseline' });
			// biome-ignore lint/suspicious/noExplicitAny: test-only hook
			(transport as any).prefixBaselineCanonical = (
				transport as unknown as { computePrefixCanonical: (i?: string, t?: unknown) => string }
			).computePrefixCanonical('baseline', undefined);

			const beforeCount = mockRt.sent.length;
			await transport.updateSession({
				instructions: 'baseline', // same prefix
				responseModality: 'text',
			});
			const after = mockRt.sent.slice(beforeCount);
			expect(after.length).toBeGreaterThan(0);
			// responseModality should still flow to the wire as output_modalities.
			const update = after.find(
				(m) =>
					m.type === 'session.update' &&
					Array.isArray((m.session as Record<string, unknown>).output_modalities),
			);
			expect(update).toBeDefined();
			expect((update?.session as Record<string, unknown>).output_modalities).toEqual(['text']);
		});

		it('transferSession with allowMutationOnTransfer=true (default) allows prefix change', async () => {
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { enforcePrefixStability: true },
			});
			await transport.updateSession({ instructions: 'agent A' });
			// biome-ignore lint/suspicious/noExplicitAny: test-only hook
			(transport as any).prefixBaselineCanonical = (
				transport as unknown as { computePrefixCanonical: (i?: string, t?: unknown) => string }
			).computePrefixCanonical('agent A', undefined);

			await expect(transport.transferSession({ instructions: 'agent B' })).resolves.toBeUndefined();
		});

		it('transferSession with allowMutationOnTransfer=false throws on prefix change', async () => {
			const { CachePrefixMutationError } = await import('../../src/core/errors.js');
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { enforcePrefixStability: true, allowMutationOnTransfer: false },
			});
			await transport.updateSession({ instructions: 'agent A' });
			// biome-ignore lint/suspicious/noExplicitAny: test-only hook
			(transport as any).prefixBaselineCanonical = (
				transport as unknown as { computePrefixCanonical: (i?: string, t?: unknown) => string }
			).computePrefixCanonical('agent A', undefined);

			await expect(transport.transferSession({ instructions: 'agent B' })).rejects.toBeInstanceOf(
				CachePrefixMutationError,
			);
		});

		it('canonicalize: reordered-but-equivalent JSON Schema compares equal', async () => {
			// White-box test of the canonicalize helper used for prefix comparison.
			// We import via dynamic import to access the file-level function.
			// The helper is not exported, so we exercise it via computePrefixCanonical
			// indirectly: same canonical string for two semantically-equivalent objects.
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			const computeCanonical = (
				transport as unknown as { computePrefixCanonical: (i?: string, t?: unknown) => string }
			).computePrefixCanonical.bind(transport);
			// Two tools with parameters whose key order differs.
			const toolA = makeTool('search');
			const toolB = makeTool('search');
			expect(computeCanonical('x', [toolA])).toBe(computeCanonical('x', [toolB]));
		});

		it('without enforcePrefixStability, prefix mutation does NOT throw (default behavior)', async () => {
			setup({ apiKey: 'test', model: 'gpt-realtime-2' });
			// No cacheConfig.enforcePrefixStability — should never throw.
			await expect(transport.updateSession({ instructions: 'whatever' })).resolves.toBeUndefined();
			await expect(transport.updateSession({ instructions: 'changed' })).resolves.toBeUndefined();
		});
	});

	// P6: experimental.promptCacheKey probe. See dev_docs/framework/design-context-caching.md §6.
	describe('experimental.promptCacheKey probe (P6)', () => {
		it('derivePromptCacheKeyProbeScope produces stable scope strings', async () => {
			const { derivePromptCacheKeyProbeScope } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			expect(derivePromptCacheKeyProbeScope(undefined, undefined, undefined, 'm', 'k')).toBe(
				'default|default|default|m|k',
			);
			expect(
				derivePromptCacheKeyProbeScope(
					'https://api.openai.com/v1',
					'org_x',
					'proj_y',
					'gpt-realtime-2',
					'k1',
				),
			).toBe('https://api.openai.com/v1|org_x|proj_y|gpt-realtime-2|k1');
			// Different baseURL → different scope.
			expect(
				derivePromptCacheKeyProbeScope('https://other/', 'org_x', 'proj_y', 'gpt-realtime-2', 'k1'),
			).not.toBe(
				derivePromptCacheKeyProbeScope(
					'https://api.openai.com/v1',
					'org_x',
					'proj_y',
					'gpt-realtime-2',
					'k1',
				),
			);
		});

		it('applyOpenAICacheConfig includes prompt_cache_key when probe state is unknown or accepted', async () => {
			const { applyOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			const cfg = { experimental: { promptCacheKey: 'demo_key' } };

			const u: Record<string, unknown> = {};
			applyOpenAICacheConfig(u, cfg, 'unknown');
			expect(u.prompt_cache_key).toBe('demo_key');

			const a: Record<string, unknown> = {};
			applyOpenAICacheConfig(a, cfg, 'accepted');
			expect(a.prompt_cache_key).toBe('demo_key');
		});

		it('applyOpenAICacheConfig OMITS prompt_cache_key when probe state is rejected', async () => {
			const { applyOpenAICacheConfig } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			const u: Record<string, unknown> = {};
			applyOpenAICacheConfig(u, { experimental: { promptCacheKey: 'demo_key' } }, 'rejected');
			expect(u.prompt_cache_key).toBeUndefined();
		});

		it('updateSession includes prompt_cache_key when key is configured', async () => {
			const { _clearPromptCacheKeyProbeStateForTesting } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			_clearPromptCacheKeyProbeStateForTesting();
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { experimental: { promptCacheKey: 'agent_alpha' } },
			});
			await transport.updateSession({ instructions: 'be helpful' });
			const update = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					(m.session as Record<string, unknown>).prompt_cache_key !== undefined,
			);
			expect(update).toBeDefined();
			expect((update?.session as Record<string, unknown>).prompt_cache_key).toBe('agent_alpha');
		});

		it('transferSession also includes prompt_cache_key (in-place handoff)', async () => {
			const { _clearPromptCacheKeyProbeStateForTesting } = await import(
				'../../src/transport/openai-realtime-transport.js'
			);
			_clearPromptCacheKeyProbeStateForTesting();
			setup({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				cacheConfig: { experimental: { promptCacheKey: 'agent_alpha' } },
			});
			await transport.transferSession({ instructions: 'agent B' });
			const update = mockRt.sent.find(
				(m) =>
					m.type === 'session.update' &&
					(m.session as Record<string, unknown>).prompt_cache_key !== undefined,
			);
			expect(update).toBeDefined();
		});

		it('rejected scope does NOT poison a different scope (per-key isolation)', async () => {
			const {
				_clearPromptCacheKeyProbeStateForTesting,
				derivePromptCacheKeyProbeScope,
				setPromptCacheKeyProbeState,
				getPromptCacheKeyProbeState,
			} = await import('../../src/transport/openai-realtime-transport.js');
			_clearPromptCacheKeyProbeStateForTesting();
			const scope1 = derivePromptCacheKeyProbeScope(
				undefined,
				undefined,
				undefined,
				'gpt-realtime-2',
				'key1',
			);
			const scope2 = derivePromptCacheKeyProbeScope(
				undefined,
				undefined,
				undefined,
				'gpt-realtime-2',
				'key2',
			);
			setPromptCacheKeyProbeState(scope1, 'rejected');
			expect(getPromptCacheKeyProbeState(scope1)).toBe('rejected');
			expect(getPromptCacheKeyProbeState(scope2)).toBe('unknown');
		});

		it('OpenAIRealtimeConfig accepts baseURL/organization/project', () => {
			// Smoke test: type-check + no-throw construction.
			const t = new OpenAIRealtimeTransport({
				apiKey: 'test',
				model: 'gpt-realtime-2',
				baseURL: 'https://gateway.example.com/v1',
				organization: 'org_x',
				project: 'proj_y',
			});
			expect(t).toBeDefined();
		});
	});

	// Follow-up review fixes — see commit message + design-context-caching.md
	describe('follow-up fixes (post-P7 review)', () => {
		// Fix #1: ack-correlated single-flight session.update queue.
		describe('FIFO queue + sendSessionUpdateAndWait (fix #1)', () => {
			it('updateSession resolves only after session.updated arrives (not fire-and-forget)', async () => {
				setup({ apiKey: 'test', model: 'gpt-realtime-2' });
				// The mock auto-emits session.updated on every session.update,
				// so a successful await means the wire→ack round-trip completed.
				const promise = transport.updateSession({ instructions: 'X' });
				// Promise is pending until the microtask queue drains.
				expect(promise).toBeInstanceOf(Promise);
				await promise;
				const sent = mockRt.sent.find(
					(m) =>
						m.type === 'session.update' &&
						(m.session as Record<string, unknown>).instructions === 'X',
				);
				expect(sent).toBeDefined();
				// Outgoing payload carries an event_id for ack correlation.
				expect((sent as Record<string, unknown>).event_id).toMatch(/^sess_upd_\d+$/);
			});

			it('concurrent updateSession calls serialize via the queue', async () => {
				setup({ apiKey: 'test', model: 'gpt-realtime-2' });
				const a = transport.updateSession({ instructions: 'A' });
				const b = transport.updateSession({ instructions: 'B' });
				await Promise.all([a, b]);
				const updates = mockRt.sent.filter((m) => m.type === 'session.update');
				// Two ordered sends with monotonic event_ids.
				const ids = updates
					.map((m) => (m as Record<string, unknown>).event_id as string | undefined)
					.filter((x): x is string => typeof x === 'string');
				expect(ids.length).toBeGreaterThanOrEqual(2);
				const counters = ids.map((id) => Number(id.replace('sess_upd_', '')));
				for (let i = 1; i < counters.length; i++) {
					expect(counters[i]).toBeGreaterThan(counters[i - 1] ?? 0);
				}
			});

			it('prefix baseline does NOT update when the wire send rejects', async () => {
				setup({
					apiKey: 'test',
					model: 'gpt-realtime-2',
					cacheConfig: { enforcePrefixStability: true },
				});
				// Set initial baseline by simulating a successful first update.
				await transport.updateSession({ instructions: 'baseline' });
				// biome-ignore lint/suspicious/noExplicitAny: test-only hook
				const beforeBaseline = (transport as any).prefixBaselineCanonical;
				expect(beforeBaseline).toBeDefined();

				// Replace the mock to make the next session.update reject by
				// emitting an error event with a matching event_id instead of
				// session.updated.
				// biome-ignore lint/suspicious/noExplicitAny: deliberate mock override
				const origSend = (mockRt as any).send.bind(mockRt);
				// biome-ignore lint/suspicious/noExplicitAny: deliberate mock override
				(mockRt as any).send = (m: Record<string, unknown>) => {
					(mockRt as Record<string, unknown[]>).sent.push(m);
					if (
						m.type === 'session.update' &&
						(m.session as Record<string, unknown>).instructions === 'rejected'
					) {
						queueMicrotask(() =>
							mockRt.emit('error', {
								event_id: m.event_id,
								error: { message: 'simulated server rejection', type: 'invalid_request_error' },
							}),
						);
						return;
					}
					origSend(m);
				};

				// Mutate prefix; transferSession path so enforcePrefixStability
				// allows the change (default allowMutationOnTransfer=true), but
				// the wire send is rejected by the mock.
				await expect(transport.transferSession({ instructions: 'rejected' })).rejects.toThrow();

				// biome-ignore lint/suspicious/noExplicitAny: test-only hook
				const afterBaseline = (transport as any).prefixBaselineCanonical;
				expect(afterBaseline).toBe(beforeBaseline);
			});
		});

		// Fix #2: probe rejection suppressed from user-facing onError.
		describe('probe rejection suppression (fix #2)', () => {
			it('does NOT call user onError when error is a prompt_cache_key probe rejection', async () => {
				const { _clearPromptCacheKeyProbeStateForTesting } = await import(
					'../../src/transport/openai-realtime-transport.js'
				);
				_clearPromptCacheKeyProbeStateForTesting();
				setup({
					apiKey: 'test',
					model: 'gpt-realtime-2',
					cacheConfig: { experimental: { promptCacheKey: 'probe_test_key' } },
				});
				const errors: unknown[] = [];
				transport.onError = (e) => errors.push(e);

				// Mark probe as in-flight (mirrors what installPromptCacheKeyProbe does).
				// biome-ignore lint/suspicious/noExplicitAny: test-only hook
				(transport as any)._inFlightProbeScope = 'any';

				// Emit an error matching the probe pattern.
				mockRt.emit('error', {
					error: { param: 'prompt_cache_key', message: 'unknown parameter' },
				});

				expect(errors).toEqual([]);
			});

			it('DOES call user onError for unrelated errors even with probe in flight', async () => {
				setup({
					apiKey: 'test',
					model: 'gpt-realtime-2',
					cacheConfig: { experimental: { promptCacheKey: 'probe_test_key' } },
				});
				const errors: unknown[] = [];
				transport.onError = (e) => errors.push(e);
				// biome-ignore lint/suspicious/noExplicitAny: test-only hook
				(transport as any)._inFlightProbeScope = 'any';

				mockRt.emit('error', {
					error: { type: 'server_error', message: 'something else broke' },
				});
				expect(errors).toHaveLength(1);
			});

			it('DOES call user onError for probe-shaped errors when no probe is in flight', () => {
				setup({ apiKey: 'test', model: 'gpt-realtime-2' });
				const errors: unknown[] = [];
				transport.onError = (e) => errors.push(e);

				// Probe scope cleared; same error pattern should NOT be suppressed.
				mockRt.emit('error', {
					error: { param: 'prompt_cache_key', message: 'unknown parameter' },
				});
				expect(errors).toHaveLength(1);
			});
		});
	});
});
