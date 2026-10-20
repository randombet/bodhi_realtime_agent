import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAILiveTransport, chunkForAppend } from '../../src/transport/openai-live-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { RealtimeLLMUsageEvent } from '../../src/types/transport.js';

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

const weather: ToolDefinition = {
	name: 'get_weather',
	description: 'Current weather for a city.',
	parameters: z.object({ city: z.string() }),
	execution: 'inline',
	execute: async () => ({ ok: true }),
};

/** 100 ms of PCM16 at 24 kHz: silence, or a 440 Hz tone at the given amplitude. */
function frame(amplitude = 0): string {
	const samples = 2400;
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		const v = amplitude ? Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 24000)) : 0;
		buf.writeInt16LE(v, i * 2);
	}
	return buf.toString('base64');
}
const SILENCE = frame(0);
const SPEECH = frame(3000);

function newTransport(overrides: Record<string, unknown> = {}) {
	return new OpenAILiveTransport({ apiKey: 'sk-test', ...overrides });
}

/** Open the socket and answer session.start with session.started. */
async function connect(
	overrides: Record<string, unknown> = {},
): Promise<[OpenAILiveTransport, InstanceType<typeof MockWebSocket>]> {
	const t = newTransport(overrides);
	const p = t.connect();
	const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
	ws.open();
	ws.msg({
		type: 'session.started',
		event_id: 'ev_1',
		session: { id: 'live_abc', model: 'gpt-live-1', status: 'active', expires_at: 0 },
	});
	await p;
	return [t, ws];
}

function session(ws: InstanceType<typeof MockWebSocket>) {
	return ws.sentOfType('session.start')[0].session as Record<string, unknown>;
}

beforeEach(() => {
	MockWebSocket.instances = [];
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('OpenAILiveTransport: session start', () => {
	it('dials the Live endpoint with the key, sends session.start, resolves on session.started', async () => {
		const t = newTransport({ instructions: 'be terse', voice: 'quartz' });
		let readyId: string | undefined;
		t.onSessionReady = (id) => {
			readyId = id;
		};
		const p = t.connect();
		const ws = MockWebSocket.instances[0];
		expect(ws.url).toBe('wss://api.openai.com/v1/live/sessions');
		expect((ws.options as { headers: Record<string, string> }).headers.Authorization).toBe(
			'Bearer sk-test',
		);
		ws.open();
		const s = session(ws);
		expect(s.model).toBe('gpt-live-1');
		expect(s.instructions).toBe('be terse');
		expect(s.audio).toEqual({
			format: { type: 'audio/pcm', rate: 24000 },
			output: { voice: 'quartz' },
		});
		// Client delegation is the default, said explicitly.
		expect(s.delegation).toEqual({ type: 'client' });
		ws.msg({ type: 'session.started', event_id: 'e', session: { id: 'live_1' } });
		await p;
		expect(t.isConnected).toBe(true);
		expect(readyId).toBe('live_1');
	});

	it('Responses delegation: backend model, prompt and the tools as function tools', async () => {
		const [, ws] = await connect({
			tools: [weather],
			delegation: {
				type: 'responses',
				model: 'gpt-5.6-luna',
				instructions: 'backend rules',
				parallelToolCalls: false,
				maxOutputTokens: 256,
				hostedTools: [{ type: 'web_search' }],
			},
		});
		const d = session(ws).delegation as {
			type: string;
			responses: Record<string, unknown>;
		};
		expect(d.type).toBe('responses');
		expect(d.responses.model).toBe('gpt-5.6-luna');
		expect(d.responses.instructions).toBe('backend rules');
		expect(d.responses.parallel_tool_calls).toBe(false);
		expect(d.responses.max_output_tokens).toBe(256);
		expect(d.responses.tool_choice).toBe('auto');
		expect(d.responses.tools).toEqual([
			{
				type: 'function',
				name: 'get_weather',
				description: 'Current weather for a city.',
				parameters: {
					type: 'object',
					properties: { city: { type: 'string' } },
					required: ['city'],
				},
			},
			{ type: 'web_search' },
		]);
	});

	it('a 16 kHz PCM format is advertised to the framework and sent on the wire', async () => {
		const [t, ws] = await connect({ audioFormat: { type: 'audio/pcm', rate: 16000 } });
		expect(t.audioFormat.inputSampleRate).toBe(16000);
		expect(t.audioFormat.outputSampleRate).toBe(16000);
		expect((session(ws).audio as { format: unknown }).format).toEqual({
			type: 'audio/pcm',
			rate: 16000,
		});
	});

	it('rejects A-law, an odd PCM rate, and Responses delegation without a model', () => {
		expect(() => newTransport({ audioFormat: { type: 'audio/pcma' } })).toThrow(/pcma/);
		expect(() => newTransport({ audioFormat: { type: 'audio/pcm', rate: 8000 } })).toThrow(
			/16000 or 24000/,
		);
		expect(() => newTransport({ delegation: { type: 'responses' } })).toThrow(/backend model/);
	});

	it('rejects connect when session.start is refused, and when the socket closes first', async () => {
		const t = newTransport();
		const p = t.connect();
		const ws = MockWebSocket.instances[0];
		ws.open();
		ws.msg({
			type: 'error',
			event_id: 'e',
			error: { type: 'invalid_request_error', code: 'unknown_parameter', message: 'nope' },
		});
		await expect(p).rejects.toThrow(/unknown_parameter/);

		const t2 = newTransport();
		const p2 = t2.connect();
		const ws2 = MockWebSocket.instances[1];
		ws2.open();
		ws2.close(1006, 'gone');
		await expect(p2).rejects.toThrow(/before session.started/);
	});

	it('capabilities: the model owns barge-in and turn-taking', async () => {
		const [t] = await connect();
		expect(t.capabilities.turnDetection).toBe(true);
		expect(t.capabilities.frameworkOwnsInterrupt).toBe(false);
		expect(t.capabilities.bufferedUncancellableAudio).toBe(false);
		expect(t.capabilities.playbackGatedTurnComplete).toBe(false);
		expect(t.capabilities.quiescible).toBe(true);
		expect(t.capabilities.contextCompression).toBe(true);
		expect(t.capabilities.textResponseModality).toBe(false);
	});

	it('ignores malformed frames', async () => {
		const [, ws] = await connect();
		expect(() => ws.raw('not json{')).not.toThrow();
	});
});

describe('OpenAILiveTransport: audio and turns', () => {
	it('sendAudio appends; nothing is committed', async () => {
		const [t, ws] = await connect();
		t.sendAudio('YWJj');
		t.commitAudio();
		expect(ws.sentOfType('session.input_audio.append')[0].audio).toBe('YWJj');
		expect(ws.sent.filter((m) => String(m.type).includes('commit'))).toEqual([]);
	});

	it('silent output frames are dropped; speech opens a turn, and the gap closes it', async () => {
		const [t, ws] = await connect();
		const events: string[] = [];
		t.onAudioOutput = () => events.push('audio');
		t.onFirstAudioChunk = () => events.push('first');
		t.onModelTurnStart = (id) => events.push(`start:${id}`);
		t.onGenerationStart = (id) => events.push(`gen-start:${id}`);
		t.onGenerationEnd = (id, reason) => events.push(`gen-end:${id}:${reason}`);
		t.onTurnComplete = () => events.push('complete');
		t.onInterrupted = () => events.push('interrupted');

		// The continuous stream while the model is quiet: nothing reaches the framework.
		ws.msg({ type: 'session.output_audio.delta', delta: SILENCE });
		ws.msg({ type: 'session.output_audio.delta', delta: SILENCE });
		expect(events).toEqual([]);

		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		expect(events).toEqual(['gen-start:live_gen_1', 'start:live_gen_1', 'first', 'audio', 'audio']);

		// Trailing silence inside the hangover still passes (tails are not clipped)…
		ws.msg({ type: 'session.output_audio.delta', delta: SILENCE });
		expect(events.filter((e) => e === 'audio')).toHaveLength(3);
		// …but after the hangover it is dropped again.
		vi.advanceTimersByTime(300);
		ws.msg({ type: 'session.output_audio.delta', delta: SILENCE });
		expect(events.filter((e) => e === 'audio')).toHaveLength(3);

		// 700 ms without speech: the turn completes, once.
		vi.advanceTimersByTime(700);
		expect(events.slice(-2)).toEqual(['gen-end:live_gen_1:generationComplete', 'complete']);
		vi.advanceTimersByTime(5_000);
		expect(events.filter((e) => e === 'complete')).toHaveLength(1);

		// The next speech is a new generation.
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		expect(events.slice(-4)).toEqual([
			'gen-start:live_gen_2',
			'start:live_gen_2',
			'first',
			'audio',
		]);
	});

	it('forwardSilence keeps the continuous stream', async () => {
		const [t, ws] = await connect({ forwardSilence: true });
		const chunks: string[] = [];
		t.onAudioOutput = (b) => chunks.push(b);
		ws.msg({ type: 'session.output_audio.delta', delta: SILENCE });
		expect(chunks).toHaveLength(1);
	});

	it('transcript fragments stream to both transcription callbacks and count as speech', async () => {
		const [t, ws] = await connect();
		const inp: string[] = [];
		const out: string[] = [];
		let started = 0;
		let turnStarted = 0;
		t.onInputTranscription = (x) => inp.push(x);
		t.onOutputTranscription = (x) => out.push(x);
		t.onSpeechStarted = () => started++;
		t.onModelTurnStart = () => turnStarted++;
		ws.msg({
			type: 'session.input_transcript.delta',
			delta: 'What is',
			start_ms: 1000,
			end_ms: 1200,
		});
		ws.msg({ type: 'session.input_transcript.delta', delta: ' the', start_ms: 1200, end_ms: 1400 });
		ws.msg({
			type: 'session.output_transcript.delta',
			delta: 'Sure',
			start_ms: 1500,
			end_ms: 1700,
		});
		expect(inp).toEqual(['What is', ' the']);
		expect(out).toEqual(['Sure']);
		// One utterance so far: speech-start evidence fires once.
		expect(started).toBe(1);
		// An assistant transcript fragment is model speech even without a voiced frame (G.711 path).
		expect(turnStarted).toBe(1);
	});

	it('a speaking run that stops right after the user resumed is reported as interrupted', async () => {
		const [t, ws] = await connect();
		const events: string[] = [];
		t.onTurnComplete = () => events.push('complete');
		t.onInterrupted = () => events.push('interrupted');
		t.onGenerationEnd = (_id, reason) => events.push(`end:${reason}`);
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		vi.advanceTimersByTime(300);
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		// The user starts talking over the model; the model yields.
		ws.msg({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 900, end_ms: 1100 });
		vi.advanceTimersByTime(200);
		ws.msg({ type: 'session.output_audio.delta', delta: SILENCE });
		vi.advanceTimersByTime(800);
		expect(events).toEqual(['end:interrupted', 'interrupted']);
	});

	it('quiesce mutes input and holds output; unquiesce restores both', async () => {
		const [t, ws] = await connect();
		const chunks: string[] = [];
		t.onAudioOutput = (b) => chunks.push(b);
		const q = t.quiesce();
		const mute = ws.sentOfType('session.input_audio.mute')[0];
		ws.msg({ type: 'session.input_audio.muted', event_id: 'e', client_event_id: mute.event_id });
		await q;
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		expect(chunks).toEqual([]);
		const u = t.unquiesce();
		const unmute = ws.sentOfType('session.input_audio.unmute')[0];
		ws.msg({
			type: 'session.input_audio.unmuted',
			event_id: 'e',
			client_event_id: unmute.event_id,
		});
		await u;
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		expect(chunks).toHaveLength(1);
	});

	it('cancelResponse is a no-op that never rejects and never calls back', async () => {
		const [t, ws] = await connect();
		let fired = false;
		t.onInterrupted = () => {
			fired = true;
		};
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		const before = ws.sent.length;
		await expect(t.cancelResponse({ waitForDone: true })).resolves.toBeUndefined();
		expect(ws.sent.length).toBe(before);
		expect(fired).toBe(false);
	});
});

describe('OpenAILiveTransport: Responses delegation', () => {
	async function connectResponses() {
		return connect({
			tools: [weather],
			delegation: { type: 'responses', model: 'gpt-5.6-luna' },
		});
	}

	it('a backend function call becomes onToolCall; its result is the output plus one continuation', async () => {
		const [t, ws] = await connectResponses();
		const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
		const events: string[] = [];
		t.onToolCall = (c) => calls.push(...c);
		t.onModelTurnStart = () => events.push('start');
		t.onTurnComplete = () => events.push('complete');

		ws.msg({
			type: 'session.delegation.created',
			event_id: 'e1',
			offset_ms: 5600,
			delegation: { id: 'item_d1', type: 'delegation', target: 'responses', response_id: 'resp_1' },
		});
		// Delegated work is model activity: a turn opens for it.
		expect(events).toEqual(['start']);
		ws.msg({
			type: 'response.event',
			event_id: 'e2',
			delegation_id: 'item_d1',
			event: { type: 'response.created', response: { id: 'resp_1' } },
		});
		ws.msg({
			type: 'response.event',
			event_id: 'e3',
			delegation_id: 'item_d1',
			event: {
				type: 'response.output_item.done',
				item: {
					type: 'function_call',
					call_id: 'call_1',
					name: 'get_weather',
					arguments: '{"city":"Tokyo"}',
				},
			},
		});
		// Not dispatched until the backend response completes (the documented point).
		expect(calls).toEqual([]);
		ws.msg({
			type: 'response.event',
			event_id: 'e4',
			delegation_id: 'item_d1',
			event: {
				type: 'response.completed',
				response: {
					id: 'resp_1',
					status: 'completed',
					output: [],
					usage: {
						input_tokens: 926,
						output_tokens: 30,
						total_tokens: 956,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		});
		expect(calls).toEqual([{ id: 'call_1', name: 'get_weather', args: { city: 'Tokyo' } }]);

		// The model is quiet while the backend waits: the turn stays open.
		vi.advanceTimersByTime(2_000);
		expect(events).toEqual(['start']);

		t.sendToolResult({ id: 'call_1', name: 'get_weather', result: { tempC: 17 } });
		const outs = ws.sentOfType('response.item.create');
		expect(outs).toHaveLength(1);
		expect(outs[0].item).toEqual({
			type: 'function_call_output',
			call_id: 'call_1',
			output: '{"tempC":17}',
		});
		expect(ws.sentOfType('response.create')).toHaveLength(1);
		// The second backend response has no calls: nothing more to wait for.
		ws.msg({
			type: 'response.event',
			event_id: 'e5',
			delegation_id: 'item_d1',
			event: {
				type: 'response.completed',
				response: { id: 'resp_2', status: 'completed', output: [] },
			},
		});
		// The model then speaks the answer; the turn closes after the gap.
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		vi.advanceTimersByTime(700);
		expect(events).toEqual(['start', 'complete']);
	});

	it('a preamble, the backend wait and the answer are one generation with one first-audio', async () => {
		const [t, ws] = await connectResponses();
		const events: string[] = [];
		t.onToolCall = () => events.push('tool');
		t.onFirstAudioChunk = () => events.push('first');
		t.onGenerationStart = (id) => events.push(`gen:${id}`);
		t.onGenerationEnd = (id, r) => events.push(`end:${id}:${r}`);
		ws.msg({
			type: 'session.delegation.created',
			event_id: 'e1',
			offset_ms: 100,
			delegation: { id: 'd', type: 'delegation', target: 'responses', response_id: 'r1' },
		});
		// "Let me check…"
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		vi.advanceTimersByTime(900);
		ws.msg({
			type: 'response.event',
			event_id: 'e2',
			delegation_id: 'd',
			event: { type: 'response.completed', response: { id: 'r1', status: 'completed' } },
		});
		// The answer, after a pause longer than the gap.
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		vi.advanceTimersByTime(700);
		expect(events).toEqual(['gen:live_gen_1', 'first', 'end:live_gen_1:generationComplete']);
	});

	it('parallel calls of one response: one continuation after the last output', async () => {
		const [t, ws] = await connectResponses();
		t.onToolCall = () => {};
		const call = (id: string) => ({
			type: 'response.event',
			event_id: `e_${id}`,
			delegation_id: 'd',
			event: {
				type: 'response.output_item.done',
				item: { type: 'function_call', call_id: id, name: 'get_weather', arguments: '{}' },
			},
		});
		ws.msg(call('c1'));
		ws.msg(call('c2'));
		ws.msg({
			type: 'response.event',
			event_id: 'e_done',
			delegation_id: 'd',
			event: { type: 'response.completed', response: { id: 'resp_p', status: 'completed' } },
		});
		t.sendToolResult({ id: 'c1', name: 'get_weather', result: 'a' });
		expect(ws.sentOfType('response.create')).toHaveLength(0);
		t.sendToolResult({ id: 'c2', name: 'get_weather', result: 'b' });
		expect(ws.sentOfType('response.create')).toHaveLength(1);
	});

	it('a background call without a pendingMessage is answered "started" at once; its real result is commentary', async () => {
		const work = {
			name: 'work',
			description: 'Run a task in the background.',
			parameters: z.object({ task: z.string() }),
			execution: 'background' as const,
			execute: async () => ({}),
		};
		const [t, ws] = await connect({
			tools: [weather, work],
			delegation: { type: 'responses', model: 'gpt-5.6-luna' },
		});
		const calls: string[] = [];
		t.onToolCall = (c) => calls.push(...c.map((x) => x.name));
		ws.msg({
			type: 'response.event',
			event_id: 'e1',
			delegation_id: 'd',
			event: {
				type: 'response.output_item.done',
				item: {
					type: 'function_call',
					call_id: 'work_1',
					name: 'work',
					arguments: '{"task":"count the PRs"}',
				},
			},
		});
		ws.msg({
			type: 'response.event',
			event_id: 'e2',
			delegation_id: 'd',
			event: { type: 'response.completed', response: { id: 'r', status: 'completed' } },
		});
		// The framework still runs the tool, but the backend is not kept waiting for it.
		expect(calls).toEqual(['work']);
		const outputs = ws.sentOfType('response.item.create');
		expect(outputs).toHaveLength(1);
		expect(outputs[0].item).toMatchObject({ type: 'function_call_output', call_id: 'work_1' });
		expect(String((outputs[0].item as { output: string }).output)).toMatch(
			/Started in the background/,
		);
		expect(ws.sentOfType('response.create')).toHaveLength(1);
		// Minutes later: the task's result, under the same call id, is spoken when the model is idle.
		t.sendToolResult({
			id: 'work_1',
			name: 'work',
			result: 'Four PRs are open.',
			scheduling: 'when_idle',
		});
		expect(ws.sentOfType('response.item.create')).toHaveLength(1);
		const said = ws.sentOfType('session.commentary.append');
		expect(said).toHaveLength(1);
		expect(said[0].content).toBe('Four PRs are open.');
	});

	it("a background tool WITH a pendingMessage keeps its call open for the framework's immediate answer", async () => {
		const notify = {
			name: 'notify',
			description: 'Send a notification.',
			parameters: z.object({}),
			execution: 'background' as const,
			pendingMessage: 'Sending it now.',
			execute: async () => ({}),
		};
		const [t, ws] = await connect({
			tools: [notify],
			delegation: { type: 'responses', model: 'gpt-5.6-luna' },
		});
		t.onToolCall = () => {};
		ws.msg({
			type: 'response.event',
			event_id: 'e1',
			delegation_id: 'd',
			event: {
				type: 'response.output_item.done',
				item: { type: 'function_call', call_id: 'n_1', name: 'notify', arguments: '{}' },
			},
		});
		ws.msg({
			type: 'response.event',
			event_id: 'e2',
			delegation_id: 'd',
			event: { type: 'response.completed', response: { id: 'r', status: 'completed' } },
		});
		expect(ws.sentOfType('response.item.create')).toHaveLength(0);
		t.sendToolResult({ id: 'n_1', name: 'notify', result: 'Sending it now.' });
		expect(ws.sentOfType('response.item.create')).toHaveLength(1);
		expect(ws.sentOfType('response.create')).toHaveLength(1);
	});

	it('a second result for a call already answered is spoken as commentary (background tool)', async () => {
		const [t, ws] = await connectResponses();
		t.onToolCall = () => {};
		ws.msg({
			type: 'response.event',
			event_id: 'e1',
			delegation_id: 'd',
			event: {
				type: 'response.output_item.done',
				item: { type: 'function_call', call_id: 'work_1', name: 'work', arguments: '{}' },
			},
		});
		ws.msg({
			type: 'response.event',
			event_id: 'e2',
			delegation_id: 'd',
			event: { type: 'response.completed', response: { id: 'r', status: 'completed' } },
		});
		t.sendToolResult({ id: 'work_1', name: 'work', result: 'Working on it.' });
		t.sendToolResult({
			id: 'work_1',
			name: 'work',
			result: 'The file is written.',
			scheduling: 'when_idle',
		});
		const said = ws.sentOfType('session.commentary.append');
		expect(said).toHaveLength(1);
		expect(said[0].content).toBe('The file is written.');
		// Non-null delegation ids are not accepted with Responses delegation.
		expect(said[0].delegation_id).toBeNull();
	});

	it('backend usage is normalized as openai_live tokens; voice seconds as a duration', async () => {
		const [t, ws] = await connectResponses();
		const got: RealtimeLLMUsageEvent[] = [];
		t.onRealtimeLLMUsage = (u) => got.push(u);
		ws.msg({
			type: 'response.event',
			event_id: 'e',
			delegation_id: 'd',
			event: {
				type: 'response.completed',
				response: {
					id: 'resp_u',
					status: 'completed',
					usage: {
						input_tokens: 982,
						output_tokens: 19,
						total_tokens: 1001,
						input_tokens_details: { cached_tokens: 900 },
					},
				},
			},
		});
		ws.msg({ type: 'session.usage.updated', event_id: 'u', usage: { seconds: 14 } });
		expect(got[0]).toMatchObject({
			provider: 'openai_live',
			unit: 'tokens',
			inputTokens: 982,
			outputTokens: 19,
			providerResponseId: 'resp_u',
			modalityBreakdown: { cachedTokens: 900 },
		});
		expect(got[1]).toMatchObject({
			provider: 'openai_live',
			unit: 'duration_seconds',
			durationSeconds: 14,
			phase: 'update',
		});
	});

	it('typed user text and images go to the backend as items plus a continuation', async () => {
		const [t, ws] = await connectResponses();
		t.sendContent([{ role: 'user', text: 'My order number is A0042.' }], true);
		const items = ws.sentOfType('response.item.create');
		expect(items[0].item).toEqual({
			type: 'message',
			role: 'user',
			content: [{ type: 'input_text', text: 'My order number is A0042.' }],
		});
		expect(ws.sentOfType('response.create')).toHaveLength(1);
		t.sendFile('AAAA', 'image/png');
		expect(
			(ws.sentOfType('response.item.create')[1].item as { content: unknown[] }).content,
		).toEqual([{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]);
		expect(ws.sentOfType('response.create')).toHaveLength(2);
	});

	it('post-connect tool changes update the backend in place and await session.updated', async () => {
		const [t, ws] = await connectResponses();
		const other: ToolDefinition = { ...weather, name: 'book_table' };
		const p = t.updateSession({ tools: [weather, other] });
		// Post-connect updates are serialized on a queue: let the send run.
		await vi.advanceTimersByTimeAsync(0);
		const upd = ws.sentOfType('session.update')[0];
		const tools = (upd.session as { delegation: { responses: { tools: Array<{ name: string }> } } })
			.delegation.responses.tools;
		expect(tools.map((x) => x.name)).toEqual(['get_weather', 'book_table']);
		ws.msg({ type: 'session.updated', event_id: 'e', client_event_id: upd.event_id, session: {} });
		await expect(p).resolves.toBeUndefined();
	});
});

describe('OpenAILiveTransport: client delegation', () => {
	it('a delegation becomes one synthesized tool call carrying the recent transcript', async () => {
		const [t, ws] = await connect({
			clientDelegationTool: { name: 'work', argument: 'task' },
		});
		const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
		t.onToolCall = (c) => calls.push(...c);
		ws.msg({
			type: 'session.output_transcript.delta',
			delta: 'Hi there.',
			start_ms: 500,
			end_ms: 900,
		});
		ws.msg({
			type: 'session.input_transcript.delta',
			delta: 'What is',
			start_ms: 1000,
			end_ms: 1200,
		});
		ws.msg({
			type: 'session.input_transcript.delta',
			delta: ' the weather',
			start_ms: 1200,
			end_ms: 1600,
		});
		ws.msg({
			type: 'session.delegation.created',
			event_id: 'e',
			offset_ms: 1700,
			delegation: { id: 'item_c1', type: 'delegation', target: 'client' },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe('item_c1');
		expect(calls[0].name).toBe('work');
		const task = calls[0].args.task as string;
		expect(task).toContain('Assistant: Hi there.');
		expect(task).toContain('User: What is the weather');
		// Duplicate delivery of the same delegation is ignored.
		ws.msg({
			type: 'session.delegation.created',
			event_id: 'e2',
			offset_ms: 1700,
			delegation: { id: 'item_c1', type: 'delegation', target: 'client' },
		});
		expect(calls).toHaveLength(1);
	});

	it('results are commentary for that delegation; silent ones are thinking; interrupt is an instruction', async () => {
		const [t, ws] = await connect();
		t.onToolCall = () => {};
		ws.msg({
			type: 'session.delegation.created',
			event_id: 'e',
			offset_ms: 100,
			delegation: { id: 'item_c1', type: 'delegation', target: 'client' },
		});
		t.sendToolResult({ id: 'item_c1', name: 'delegate', result: 'Tokyo: light rain, 17 °C.' });
		t.sendToolResult({
			id: 'item_c1',
			name: 'delegate',
			result: { step: 'done' },
			scheduling: 'silent',
		});
		t.sendToolResult({
			id: 'item_c1',
			name: 'delegate',
			result: 'Stop, the flight moved.',
			scheduling: 'interrupt',
		});
		const said = ws.sentOfType('session.commentary.append')[0];
		expect(said.content).toBe('Tokyo: light rain, 17 °C.');
		expect(said.delegation_id).toBe('item_c1');
		const thought = ws.sentOfType('session.thinking.append')[0];
		expect(thought.content).toBe('{"step":"done"}');
		expect(thought.delegation_id).toBe('item_c1');
		const instr = ws.sentOfType('session.instructions.append')[0];
		expect(instr.content).toContain('Stop, the flight moved.');
	});

	it('when_idle results wait until the model stops speaking', async () => {
		const [t, ws] = await connect();
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		t.sendToolResult({ id: 'x', name: 'work', result: 'done', scheduling: 'when_idle' });
		expect(ws.sentOfType('session.commentary.append')).toHaveLength(0);
		vi.advanceTimersByTime(700);
		expect(ws.sentOfType('session.commentary.append')).toHaveLength(1);
	});

	it('long results are split into appends under the 500-token limit', async () => {
		const [t, ws] = await connect();
		const long = Array.from(
			{ length: 60 },
			(_, i) => `Sentence number ${i} of the long answer.`,
		).join(' ');
		t.sendToolResult({ id: 'x', name: 'work', result: long });
		const parts = ws.sentOfType('session.commentary.append').map((m) => m.content as string);
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(p.length).toBeLessThanOrEqual(1200);
		expect(parts.join(' ')).toBe(long);
	});

	it('typed user text is appended as an instruction the model acts on', async () => {
		const [t, ws] = await connect();
		expect(t.sendLiveText([{ role: 'user', text: 'order A0042' }])).toBe(true);
		const instr = ws.sentOfType('session.instructions.append')[0];
		expect(instr.content).toContain('"order A0042"');
		expect(instr.delegation_id).toBeNull();
		// Images have nowhere to go without a backend.
		let err: Error | undefined;
		t.onError = (e) => {
			err = e.error;
		};
		t.sendFile('AAAA', 'image/png');
		expect(err?.message).toMatch(/Responses delegation/);
	});
});

describe('OpenAILiveTransport: lifecycle', () => {
	it('disconnect closes gracefully: session.close, final usage, then the socket', async () => {
		const [t, ws] = await connect();
		const got: RealtimeLLMUsageEvent[] = [];
		t.onRealtimeLLMUsage = (u) => got.push(u);
		let closed = false;
		t.onClose = () => {
			closed = true;
		};
		const p = t.disconnect();
		expect(ws.sentOfType('session.close')).toHaveLength(1);
		ws.msg({
			type: 'session.closed',
			event_id: 'e',
			reason: 'close_requested',
			usage: { seconds: 21 },
			session: {},
		});
		await p;
		expect(got[0]).toMatchObject({ unit: 'duration_seconds', durationSeconds: 21, phase: 'final' });
		expect(ws.closeCalled).toBe(true);
		expect(t.isConnected).toBe(false);
		// A close we asked for is not reported as a loss.
		expect(closed).toBe(false);
	});

	it('an unexpected close reports the session reason when session.closed came first', async () => {
		const [t, ws] = await connect();
		let close: [number | undefined, string | undefined] | undefined;
		t.onClose = (code, reason) => {
			close = [code, reason];
		};
		ws.msg({
			type: 'session.closed',
			event_id: 'e',
			reason: 'expired',
			usage: { seconds: 7100 },
			session: {},
		});
		ws.close(1006, '');
		expect(close).toEqual([1006, 'expired']);
	});

	it('an open generation ends as disconnected when the socket drops', async () => {
		const [t, ws] = await connect();
		const ends: string[] = [];
		t.onGenerationEnd = (_id, reason) => ends.push(reason);
		ws.msg({ type: 'session.output_audio.delta', delta: SPEECH });
		ws.close(1006, '');
		expect(ends).toEqual(['disconnected']);
	});

	it('reconnect seeds the new session with the conversation text', async () => {
		const [t] = await connect();
		const p = t.reconnect({
			conversationHistory: [
				{ type: 'text', role: 'user', text: 'I need help with my order.' },
				{ type: 'tool_call', id: 'c', name: 'lookup', args: {} },
				{ type: 'text', role: 'assistant', text: 'What is the order number?' },
			],
		});
		// disconnect() waits for session.closed (or its timeout) before redialing.
		MockWebSocket.instances[0].msg({
			type: 'session.closed',
			event_id: 'e',
			reason: 'close_requested',
			usage: { seconds: 1 },
			session: {},
		});
		await vi.advanceTimersByTimeAsync(10);
		const ws2 = MockWebSocket.instances[1];
		ws2.open();
		expect(session(ws2).input).toEqual([
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'I need help with my order.' }],
			},
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'What is the order number?' }],
			},
		]);
		ws2.msg({ type: 'session.started', event_id: 'e', session: { id: 'live_2' } });
		await p;
		expect(t.isConnected).toBe(true);
	});

	it('replayHistory after start is quiet context', async () => {
		const [t, ws] = await connect();
		t.replayHistory([{ type: 'text', role: 'user', text: 'earlier words' }]);
		const think = ws.sentOfType('session.thinking.append')[0];
		expect(think.content).toContain('user: earlier words');
		expect(think.delegation_id).toBeNull();
	});

	it('errors surface through onError, with authentication marked unrecoverable', async () => {
		const [t, ws] = await connect();
		const errs: { message: string; recoverable: boolean }[] = [];
		t.onError = (e) => errs.push({ message: e.error.message, recoverable: e.recoverable });
		ws.msg({
			type: 'error',
			event_id: 'e',
			error: { type: 'invalid_request_error', code: 'immutable_field_update', message: 'no' },
		});
		ws.msg({
			type: 'error',
			event_id: 'e',
			error: { type: 'authentication_error', code: 'invalid_api_key', message: 'bad key' },
		});
		expect(errs[0].recoverable).toBe(true);
		expect(errs[1].recoverable).toBe(false);
		expect(errs[1].message).toContain('invalid_api_key');
	});
});

describe('chunkForAppend', () => {
	it('leaves short text whole and splits long text at sentence ends', () => {
		expect(chunkForAppend('hello')).toEqual(['hello']);
		const parts = chunkForAppend('One. Two. Three.', 9);
		expect(parts).toEqual(['One.', 'Two.', 'Three.']);
	});

	it('falls back to a hard cut when there is no boundary', () => {
		const parts = chunkForAppend('x'.repeat(2500), 1000);
		expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500]);
	});
});
