// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { QwenRealtimeTransport } from '../../src/transport/qwen-realtime-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';

type EventHandler = (...args: unknown[]) => void;

const { MockWebSocket } = vi.hoisted(() => {
	class MockWebSocket {
		static instances: MockWebSocket[] = [];
		static OPEN = 1;
		url: string;
		options: Record<string, unknown> | undefined;
		readyState = 0;
		handlers = new Map<string, EventHandler>();
		sent: Record<string, unknown>[] = [];
		closeCalled = false;
		constructor(url: string, options?: Record<string, unknown>) {
			this.url = url;
			this.options = options;
			MockWebSocket.instances.push(this);
		}
		on(event: string, handler: EventHandler) {
			this.handlers.set(event, handler);
		}
		removeAllListeners() {
			this.handlers.clear();
		}
		send(data: string) {
			this.sent.push(JSON.parse(data));
		}
		close(code?: number, reason?: string) {
			this.closeCalled = true;
			this.readyState = 3;
			this.handlers.get('close')?.(code ?? 1000, Buffer.from(reason ?? ''));
		}
		// helpers
		open() {
			this.readyState = 1;
			this.handlers.get('open')?.();
		}
		msg(data: Record<string, unknown>) {
			this.handlers.get('message')?.(Buffer.from(JSON.stringify(data)));
		}
		raw(s: string) {
			this.handlers.get('message')?.(Buffer.from(s));
		}
		err(e: Error) {
			this.handlers.get('error')?.(e);
		}
		lastSent() {
			return this.sent[this.sent.length - 1];
		}
		sentOfType(t: string) {
			return this.sent.filter((m) => m.type === t);
		}
	}
	return { MockWebSocket };
});

vi.mock('ws', () => ({ WebSocket: MockWebSocket }));

function newTransport(overrides = {}) {
	return new QwenRealtimeTransport({
		apiKey: 'sk-test',
		model: 'qwen3.5-omni-plus-realtime',
		...overrides,
	});
}

/** Connect helper: open socket, ack first session.update. Returns [transport, ws]. */
async function connect(
	overrides = {},
): Promise<[QwenRealtimeTransport, InstanceType<typeof MockWebSocket>]> {
	const t = newTransport(overrides);
	const p = t.connect();
	const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
	ws.open();
	ws.msg({ type: 'session.created', session: { id: 'sess_1' } });
	ws.msg({ type: 'session.updated' });
	await p;
	return [t, ws];
}

beforeEach(() => {
	MockWebSocket.instances = [];
});
afterEach(() => {
	vi.clearAllMocks();
});

describe('QwenRealtimeTransport', () => {
	it('connects: sends session.update, resolves on session.updated, fires onSessionReady', async () => {
		const t = newTransport({ voice: 'Tina', instructions: 'be terse' });
		let readyId: string | undefined;
		t.onSessionReady = (id) => {
			readyId = id;
		};
		const p = t.connect();
		const ws = MockWebSocket.instances[0];
		expect(ws.url).toContain('model=qwen3.5-omni-plus-realtime');
		expect((ws.options as { headers: Record<string, string> }).headers.Authorization).toBe(
			'Bearer sk-test',
		);
		ws.open();
		const su = ws.sentOfType('session.update')[0];
		expect((su.session as Record<string, unknown>).modalities).toEqual(['text', 'audio']);
		expect((su.session as Record<string, unknown>).voice).toBe('Tina');
		expect((su.session as Record<string, unknown>).turn_detection).toEqual({ type: 'server_vad' });
		ws.msg({ type: 'session.created', session: { id: 'sess_abc' } });
		ws.msg({ type: 'session.updated' });
		await p;
		expect(t.isConnected).toBe(true);
		expect(readyId).toBe('sess_abc');
	});

	it('rejects connect on close before session.updated', async () => {
		const t = newTransport();
		const p = t.connect();
		const ws = MockWebSocket.instances[0];
		ws.open();
		ws.close(1006, 'gone');
		await expect(p).rejects.toThrow();
	});

	it('ignores malformed (non-JSON) frames', async () => {
		const [, ws] = await connect();
		expect(() => ws.raw('not json{')).not.toThrow();
	});

	it('audio: sendAudio appends; response.audio.delta → onAudioOutput', async () => {
		const [t, ws] = await connect();
		t.sendAudio('YWJj');
		expect(ws.sentOfType('input_audio_buffer.append')[0].audio).toBe('YWJj');
		const chunks: string[] = [];
		t.onAudioOutput = (b) => chunks.push(b);
		ws.msg({ type: 'response.created' });
		ws.msg({ type: 'response.audio.delta', delta: 'AAAA' });
		expect(chunks).toEqual(['AAAA']);
	});

	it('input transcription: emits once on completed, not on delta', async () => {
		const [t, ws] = await connect();
		const got: string[] = [];
		t.onInputTranscription = (text) => got.push(text);
		ws.msg({ type: 'conversation.item.input_audio_transcription.delta', stash: 'partial' });
		expect(got).toEqual([]);
		ws.msg({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: 'final text',
		});
		expect(got).toEqual(['final text']);
	});

	it('output transcript streams via onOutputTranscription', async () => {
		const [t, ws] = await connect();
		const got: string[] = [];
		t.onOutputTranscription = (text) => got.push(text);
		ws.msg({ type: 'response.created' });
		ws.msg({ type: 'response.audio_transcript.delta', delta: 'Hello ' });
		ws.msg({ type: 'response.audio_transcript.delta', delta: 'world' });
		expect(got).toEqual(['Hello ', 'world']);
	});

	it('provider-owned interrupt: speech_started during generation fires onInterrupted + suppresses audio', async () => {
		const [t, ws] = await connect();
		const events: string[] = [];
		t.onSpeechStarted = () => events.push('speech');
		t.onInterrupted = () => events.push('interrupted');
		t.onAudioOutput = () => events.push('audio');
		ws.msg({ type: 'response.created' }); // model generating
		ws.msg({ type: 'input_audio_buffer.speech_started' });
		ws.msg({ type: 'response.audio.delta', delta: 'late' }); // should be suppressed
		expect(events).toEqual(['speech', 'interrupted']);
		expect(events).not.toContain('audio');
	});

	it('tools: function_call flow assembles args and dispatches onToolCall, then onTurnComplete', async () => {
		const [t, ws] = await connect();
		const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
		let turnDone = false;
		t.onToolCall = (c) => calls.push(...c);
		t.onTurnComplete = () => {
			turnDone = true;
		};
		ws.msg({ type: 'response.created' });
		ws.msg({
			type: 'response.output_item.added',
			item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '' },
		});
		ws.msg({
			type: 'response.function_call_arguments.delta',
			call_id: 'call_1',
			delta: '{"city":',
		});
		ws.msg({
			type: 'response.function_call_arguments.delta',
			call_id: 'call_1',
			delta: '"Tokyo"}',
		});
		ws.msg({
			type: 'response.function_call_arguments.done',
			call_id: 'call_1',
			name: 'get_weather',
			arguments: '{"city":"Tokyo"}',
		});
		ws.msg({
			type: 'response.done',
			response: {
				id: 'resp_1',
				status: 'completed',
				usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
			},
		});
		expect(calls).toEqual([{ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } }]);
		expect(turnDone).toBe(true);
	});

	it('sendToolResult emits function_call_output + response.create (and skips create when silent)', async () => {
		const [t, ws] = await connect();
		t.sendToolResult({ id: 'call_1', name: 'get_weather', result: { tempC: 21 } });
		const out = ws.sentOfType('conversation.item.create')[0];
		expect((out.item as Record<string, unknown>).type).toBe('function_call_output');
		expect((out.item as Record<string, unknown>).call_id).toBe('call_1');
		expect(ws.sentOfType('response.create').length).toBe(1);
		t.sendToolResult({ id: 'call_2', name: 'x', result: 'ok', scheduling: 'silent' });
		expect(ws.sentOfType('response.create').length).toBe(1); // unchanged — silent
	});

	it('usage: response.done → onRealtimeLLMUsage normalized for qwen_realtime', async () => {
		const [t, ws] = await connect();
		let usage: { provider?: string; inputTokens?: number; modalityBreakdown?: unknown } | null =
			null;
		t.onRealtimeLLMUsage = (u) => {
			usage = u;
		};
		ws.msg({ type: 'response.created' });
		ws.msg({
			type: 'response.done',
			response: {
				id: 'resp_x',
				status: 'completed',
				usage: {
					total_tokens: 535,
					input_tokens: 501,
					output_tokens: 34,
					input_tokens_details: { text_tokens: 473, audio_tokens: 28 },
					output_tokens_details: { text_tokens: 8, audio_tokens: 26 },
				},
			},
		});
		expect(usage).not.toBeNull();
		expect(usage?.provider).toBe('qwen_realtime');
		expect(usage?.inputTokens).toBe(501);
		expect(usage?.modalityBreakdown).toMatchObject({
			inputTextTokens: 473,
			inputAudioTokens: 28,
			outputTextTokens: 8,
			outputAudioTokens: 26,
		});
	});

	it('cancelled response.done does NOT fire onTurnComplete', async () => {
		const [t, ws] = await connect();
		let turnDone = false;
		t.onTurnComplete = () => {
			turnDone = true;
		};
		ws.msg({ type: 'response.created' });
		ws.msg({ type: 'response.done', response: { id: 'r', status: 'cancelled' } });
		expect(turnDone).toBe(false);
	});

	it('text mode: response.text.delta/done → onTextOutput/onTextDone', async () => {
		const [t, ws] = await connect({ responseModality: 'text' });
		// modalities should be ['text'] in the session.update
		const su = ws.sentOfType('session.update')[0];
		expect((su.session as Record<string, unknown>).modalities).toEqual(['text']);
		const out: string[] = [];
		let done = false;
		t.onTextOutput = (x) => out.push(x);
		t.onTextDone = () => {
			done = true;
		};
		ws.msg({ type: 'response.created' });
		ws.msg({ type: 'response.text.delta', delta: 'Paris' });
		ws.msg({ type: 'response.text.done' });
		expect(out).toEqual(['Paris']);
		expect(done).toBe(true);
	});

	it('tools session.update carries JSON-schema tool entries', async () => {
		const tool: ToolDefinition = {
			name: 'get_weather',
			description: 'weather',
			parameters: z.object({ city: z.string() }),
			execution: 'inline',
			execute: async () => ({}),
		};
		const [, ws] = await connect({ tools: [tool] });
		const su = ws.sentOfType('session.update')[0];
		const tools = (su.session as Record<string, unknown>).tools as Array<Record<string, unknown>>;
		expect(tools[0]).toMatchObject({ type: 'function', name: 'get_weather' });
		expect((tools[0].parameters as Record<string, unknown>).type).toBe('object');
		expect((su.session as Record<string, unknown>).tool_choice).toBe('auto');
	});

	it('transcription disable: input:false sets null and suppresses onInputTranscription', async () => {
		const [t, ws] = await connect();
		const up = t.updateSession({ transcription: { input: false } });
		await new Promise((r) => setTimeout(r, 0)); // flush queue microtask so the waiter registers
		ws.msg({ type: 'session.updated' }); // ack the post-connect update
		await up;
		const lastUpdate = ws.sentOfType('session.update').at(-1);
		expect((lastUpdate?.session as Record<string, unknown>).input_audio_transcription).toBeNull();
		let fired = false;
		t.onInputTranscription = () => {
			fired = true;
		};
		ws.msg({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'x' });
		expect(fired).toBe(false);
	});

	it('updateSession post-connect awaits the session.updated ack', async () => {
		const [t, ws] = await connect();
		let resolved = false;
		const p = t.updateSession({ instructions: 'new' }).then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false); // waiting on ack
		ws.msg({ type: 'session.updated' });
		await p;
		expect(resolved).toBe(true);
	});

	it('sendFile throws (unsupported in V1)', async () => {
		const [t] = await connect();
		expect(() => t.sendFile('data', 'image/jpeg')).toThrow();
	});

	it('capabilities reflect Phase 0 findings', () => {
		const t = newTransport();
		expect(t.capabilities.turnDetection).toBe(true);
		expect(t.capabilities.userTranscription).toBe(true);
		expect(t.capabilities.inPlaceSessionUpdate).toBe(true);
		expect(t.capabilities.textResponseModality).toBe(true);
		expect(t.capabilities.frameworkOwnsInterrupt).toBe(false);
		expect(t.audioFormat).toMatchObject({
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			encoding: 'pcm',
		});
	});
});
