// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CartesiaTTSProvider } from '../../src/transport/cartesia-tts-provider.js';

// ─── WebSocket Mock (hoisted for vi.mock factory) ─────────────────────────────

type EventHandler = (...args: unknown[]) => void;

const { MockWebSocket } = vi.hoisted(() => {
	class MockWebSocket {
		static instances: MockWebSocket[] = [];
		static OPEN = 1;

		url: string;
		options: Record<string, unknown> | undefined;
		readyState = 0; // CONNECTING
		handlers = new Map<string, EventHandler>();
		sent: string[] = [];
		closeCalled = false;
		closeCode?: number;
		closeReason?: string;

		constructor(url: string, options?: Record<string, unknown>) {
			this.url = url;
			this.options = options;
			MockWebSocket.instances.push(this);
		}

		on(event: string, handler: EventHandler) {
			this.handlers.set(event, handler);
		}

		send(data: string) {
			this.sent.push(data);
		}

		close(code?: number, reason?: string) {
			this.closeCalled = true;
			this.closeCode = code;
			this.closeReason = reason;
			this.readyState = 3; // CLOSED
		}

		// Test helpers
		triggerOpen() {
			this.readyState = 1; // OPEN
			this.handlers.get('open')?.();
		}

		triggerMessage(data: string | Record<string, unknown>) {
			const raw = typeof data === 'string' ? data : JSON.stringify(data);
			this.handlers.get('message')?.(raw);
		}

		triggerClose(code: number, reason: string) {
			this.readyState = 3;
			this.handlers.get('close')?.(code, Buffer.from(reason));
		}

		triggerError(err: Error) {
			this.handlers.get('error')?.(err);
		}
	}
	return { MockWebSocket };
});

vi.mock('ws', () => ({
	WebSocket: MockWebSocket,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function lastInstance(): MockWebSocket {
	return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function createProvider(
	overrides?: Partial<{
		modelId: string;
		language: string;
		speed: 'slowest' | 'slow' | 'normal' | 'fast' | 'fastest' | number;
		emotion: string[];
	}>,
): CartesiaTTSProvider {
	const p = new CartesiaTTSProvider({
		apiKey: 'test-api-key',
		voiceId: 'test-voice-id',
		...overrides,
	});
	p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcm' });
	return p;
}

/** Start the provider and connect the WebSocket. */
async function startProvider(p: CartesiaTTSProvider): Promise<MockWebSocket> {
	const startPromise = p.start();
	const ws = lastInstance();
	ws.triggerOpen();
	await startPromise;
	return ws;
}

function parseSent(ws: MockWebSocket): Record<string, unknown>[] {
	return ws.sent.map((s) => JSON.parse(s));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CartesiaTTSProvider', () => {
	beforeEach(() => {
		MockWebSocket.instances = [];
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ── Constructor ───────────────────────────────────────────────────────

	describe('constructor', () => {
		it('throws if apiKey is empty', () => {
			expect(() => new CartesiaTTSProvider({ apiKey: '', voiceId: 'v1' })).toThrow(
				'non-empty apiKey',
			);
		});

		it('throws if apiKey is whitespace only', () => {
			expect(() => new CartesiaTTSProvider({ apiKey: '   ', voiceId: 'v1' })).toThrow(
				'non-empty apiKey',
			);
		});

		it('throws if voiceId is empty', () => {
			expect(() => new CartesiaTTSProvider({ apiKey: 'key', voiceId: '' })).toThrow(
				'non-empty voiceId',
			);
		});

		it('throws if voiceId is whitespace only', () => {
			expect(() => new CartesiaTTSProvider({ apiKey: 'key', voiceId: '   ' })).toThrow(
				'non-empty voiceId',
			);
		});

		it('uses default modelId, language, speed, emotion', () => {
			const p = new CartesiaTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			expect(p).toBeDefined();
		});

		it('accepts custom config', () => {
			const p = new CartesiaTTSProvider({
				apiKey: 'key',
				voiceId: 'v1',
				modelId: 'sonic-english',
				language: 'es',
				speed: 'fast',
				emotion: ['cheerful'],
			});
			expect(p).toBeDefined();
		});
	});

	// ── Configure ─────────────────────────────────────────────────────────

	describe('configure', () => {
		it('returns exact match when preferred rate is supported', () => {
			const p = new CartesiaTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 24000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			expect(result.sampleRate).toBe(24000);
			expect(result.bitDepth).toBe(16);
			expect(result.channels).toBe(1);
			expect(result.encoding).toBe('pcm');
		});

		it('returns closest supported rate for 44100', () => {
			const p = new CartesiaTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 44100,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			expect(result.sampleRate).toBe(44100);
		});

		it('selects closest rate for unsupported rate (e.g. 32000 → 24000)', () => {
			const p = new CartesiaTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 32000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			// 32000 is closer to 24000 (diff=8000) than 44100 (diff=12100)
			expect(result.sampleRate).toBe(24000);
		});

		it('selects closest rate for low rate (e.g. 11000 → 8000)', () => {
			const p = new CartesiaTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 11000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			// 11000 is closer to 8000 (diff=3000) than 16000 (diff=5000)
			expect(result.sampleRate).toBe(8000);
		});

		it('selects 16000 for 16000', () => {
			const p = new CartesiaTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 16000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			expect(result.sampleRate).toBe(16000);
		});
	});

	// ── Start ─────────────────────────────────────────────────────────────

	describe('start', () => {
		it('opens WebSocket with correct URL params', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();

			const url = new URL(ws.url);
			expect(url.origin).toBe('wss://api.cartesia.ai');
			expect(url.pathname).toBe('/tts/websocket');
			expect(url.searchParams.get('api_key')).toBe('test-api-key');
			expect(url.searchParams.get('cartesia_version')).toBe('2024-06-10');

			ws.triggerOpen();
			await startPromise;
		});

		it('resolves on WebSocket open', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();

			ws.triggerOpen();
			await expect(startPromise).resolves.toBeUndefined();
		});

		it('rejects on WebSocket error during connect', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();

			ws.triggerError(new Error('Connection refused'));
			await expect(startPromise).rejects.toThrow('Connection refused');
		});

		it('rejects on connection timeout', async () => {
			const p = createProvider();
			const startPromise = p.start();

			// Advance past timeout (10s)
			vi.advanceTimersByTime(10_001);

			await expect(startPromise).rejects.toThrow('connection timeout');
		});

		it('is idempotent when already started', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// Second start() should be a no-op
			await p.start();
			expect(MockWebSocket.instances).toHaveLength(1);
			expect(ws).toBeDefined();
		});

		it('throws if configure() was not called', async () => {
			const p = new CartesiaTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			await expect(p.start()).rejects.toThrow('configure() must be called before start()');
		});
	});

	// ── Synthesize ────────────────────────────────────────────────────────

	describe('synthesize', () => {
		it('buffers text until sentence boundary', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('Hello', 1);
			p.synthesize(' world', 1);

			// No complete sentence yet — nothing sent
			expect(ws.sent).toHaveLength(0);
		});

		it('sends text on sentence boundary', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('Hello world. ', 1);

			expect(ws.sent).toHaveLength(1);
			const msg = JSON.parse(ws.sent[0]);
			expect(msg.transcript).toBe('Hello world. ');
			expect(msg.continue).toBe(true);
			expect(msg.context_id).toMatch(/^ctx-/);
			expect(msg.model_id).toBe('sonic-2');
			expect(msg.voice).toEqual({ mode: 'id', id: 'test-voice-id' });
			expect(msg.output_format).toEqual({
				container: 'raw',
				encoding: 'pcm_s16le',
				sample_rate: 24000,
			});
			expect(msg.language).toBe('en');
			expect(msg.add_timestamps).toBe(true);
		});

		it('flushes remaining text when flush option is true', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('Hello world', 1);
			// No sentence boundary yet
			expect(ws.sent).toHaveLength(0);

			p.synthesize('', 1, { flush: true });

			// Should send the buffered text with continue: false
			expect(ws.sent).toHaveLength(1);
			const msg = JSON.parse(ws.sent[0]);
			expect(msg.transcript).toBe('Hello world');
			expect(msg.continue).toBe(false);
		});

		it('sends empty final chunk on flush when buffer is already empty', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// Send a complete sentence, then flush
			p.synthesize('Done. ', 1);
			expect(ws.sent).toHaveLength(1); // sentence sent with continue: true

			p.synthesize('', 1, { flush: true });
			expect(ws.sent).toHaveLength(2);
			const msg = JSON.parse(ws.sent[1]);
			expect(msg.transcript).toBe('');
			expect(msg.continue).toBe(false);
		});

		it('uses same context_id for same requestId', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('First. ', 1);
			p.synthesize('Second. ', 1);

			const msgs = parseSent(ws);
			expect(msgs[0].context_id).toBe(msgs[1].context_id);
		});

		it('creates new context when requestId changes', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// First request — send a sentence
			p.synthesize('Hello. ', 1);
			const firstContextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			// Switch to a new requestId
			p.synthesize('World. ', 2);

			// Should have finalized the old context (empty continue:false) + sent new sentence
			const msgs = parseSent(ws);
			// msgs[0]: "Hello. " continue:true ctx-1
			// msgs[1]: "" continue:false ctx-1 (finalization)
			// msgs[2]: "World. " continue:true ctx-2
			expect(msgs).toHaveLength(3);
			expect(msgs[1].context_id).toBe(firstContextId);
			expect(msgs[1].continue).toBe(false);
			expect(msgs[2].context_id).not.toBe(firstContextId);
		});

		it('silently drops when not connected', () => {
			const p = createProvider();
			// Not started yet
			expect(() => p.synthesize('test', 1)).not.toThrow();
		});

		it('includes speed control when not normal', async () => {
			const p = createProvider({ speed: 'fast' });
			const ws = await startProvider(p);

			p.synthesize('Hello world. ', 1);

			const msg = JSON.parse(ws.sent[0]);
			expect((msg.voice as Record<string, unknown>).__experimental_controls).toEqual({
				speed: 'fast',
			});
		});

		it('includes emotion control when set', async () => {
			const p = createProvider({ emotion: ['cheerful', 'friendly'] });
			const ws = await startProvider(p);

			p.synthesize('Hello world. ', 1);

			const msg = JSON.parse(ws.sent[0]);
			expect((msg.voice as Record<string, unknown>).__experimental_controls).toEqual({
				emotion: ['cheerful', 'friendly'],
			});
		});

		it('includes both speed and emotion when both set', async () => {
			const p = createProvider({ speed: 'fast', emotion: ['cheerful'] });
			const ws = await startProvider(p);

			p.synthesize('Hello world. ', 1);

			const msg = JSON.parse(ws.sent[0]);
			const controls = (msg.voice as Record<string, unknown>).__experimental_controls as Record<
				string,
				unknown
			>;
			expect(controls.speed).toBe('fast');
			expect(controls.emotion).toEqual(['cheerful']);
		});

		it('sends multiple sentences from a single token', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('First sentence. Second sentence. ', 1);

			const msgs = parseSent(ws);
			expect(msgs).toHaveLength(2);
			expect(msgs[0].transcript).toBe('First sentence. ');
			expect(msgs[1].transcript).toBe('Second sentence. ');
		});
	});

	// ── Cancel ────────────────────────────────────────────────────────────

	describe('cancel', () => {
		it('sends cancel message for current context', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('Hello. ', 1);
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			p.cancel();

			const msgs = parseSent(ws);
			const cancelMsg = msgs[msgs.length - 1];
			expect(cancelMsg.context_id).toBe(contextId);
			expect(cancelMsg.cancel).toBe(true);
		});

		it('suppresses onAudio for cancelled requestId', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			p.synthesize('Hello. ', 1);
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			p.cancel();

			// Late audio for the cancelled context should be suppressed
			ws.triggerMessage({
				type: 'chunk',
				context_id: contextId,
				data: 'AQID', // some base64 audio
			});

			expect(onAudio).not.toHaveBeenCalled();
		});

		it('fires onDone for new requestId after cancel', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			// Start first request
			p.synthesize('Hello. ', 1);

			p.cancel();

			// Start new request
			p.synthesize('New. ', 2, { flush: true });
			const msgs = parseSent(ws);
			// Find the new context_id (the last text message)
			const newContextId = msgs[msgs.length - 1].context_id;

			// Server sends done for the new context
			ws.triggerMessage({ type: 'done', context_id: newContextId });

			expect(onDone).toHaveBeenCalledWith(2);
			expect(onDone).toHaveBeenCalledTimes(1);
		});

		it('is a no-op when not connected', () => {
			const p = createProvider();
			expect(() => p.cancel()).not.toThrow();
		});

		it('is a no-op when no active context', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// No synthesize() call — cancel should be a no-op
			p.cancel();
			expect(ws.sent).toHaveLength(0);
		});

		it('clears sentence buffer on cancel', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// Buffer some text without a sentence boundary
			p.synthesize('Buffered text', 1);
			expect(ws.sent).toHaveLength(0); // nothing sent yet (no boundary)

			p.cancel();

			// Now start new synthesis — should not contain old buffered text
			p.synthesize('New. ', 2);
			const msgs = parseSent(ws);
			// Only the cancel message + new sentence
			const textMsgs = msgs.filter((m) => m.transcript !== undefined);
			expect(textMsgs).toHaveLength(1);
			expect(textMsgs[0].transcript).toBe('New. ');
		});
	});

	// ── Receive: Audio Chunks ─────────────────────────────────────────────

	describe('receive: audio chunks', () => {
		it('fires onAudio with correct requestId and duration', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			p.synthesize('Hello. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			// 480 bytes of base64 = 360 raw bytes = 180 samples
			// At 24000 Hz: 180/24000 * 1000 = 7.5ms
			const base64Audio = 'A'.repeat(480);
			ws.triggerMessage({
				type: 'chunk',
				context_id: contextId,
				data: base64Audio,
			});

			expect(onAudio).toHaveBeenCalledTimes(1);
			expect(onAudio).toHaveBeenCalledWith(base64Audio, expect.closeTo(7.5, 1), 1);
		});

		it('fires onAudio multiple times for multiple chunks', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			p.synthesize('Hello. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			ws.triggerMessage({ type: 'chunk', context_id: contextId, data: 'AQID' });
			ws.triggerMessage({ type: 'chunk', context_id: contextId, data: 'BAUG' });

			expect(onAudio).toHaveBeenCalledTimes(2);
		});

		it('ignores chunks with no data field', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			p.synthesize('Hello. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			ws.triggerMessage({ type: 'chunk', context_id: contextId });
			expect(onAudio).not.toHaveBeenCalled();
		});

		it('ignores chunks with unknown context_id', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			ws.triggerMessage({
				type: 'chunk',
				context_id: 'unknown-ctx',
				data: 'AQID',
			});

			expect(onAudio).not.toHaveBeenCalled();
		});
	});

	// ── Receive: Word Boundaries ──────────────────────────────────────────

	describe('receive: word boundaries', () => {
		it('fires onWordBoundary from chunk word_timestamps', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onWordBoundary = vi.fn();
			p.onWordBoundary = onWordBoundary;

			p.synthesize('Hello world. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			ws.triggerMessage({
				type: 'chunk',
				context_id: contextId,
				data: 'AQID',
				word_timestamps: {
					words: ['Hello', 'world'],
					start: [0.0, 0.5],
					end: [0.5, 1.0],
				},
			});

			expect(onWordBoundary).toHaveBeenCalledTimes(2);
			expect(onWordBoundary).toHaveBeenCalledWith('Hello', 0, 1);
			expect(onWordBoundary).toHaveBeenCalledWith('world', 500, 1);
		});

		it('fires onWordBoundary from standalone timestamps message', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onWordBoundary = vi.fn();
			p.onWordBoundary = onWordBoundary;

			p.synthesize('Hi. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			ws.triggerMessage({
				type: 'timestamps',
				context_id: contextId,
				word_timestamps: {
					words: ['Hi'],
					start: [0.1],
					end: [0.3],
				},
			});

			expect(onWordBoundary).toHaveBeenCalledWith('Hi', 100, 1);
		});

		it('ignores timestamps without words array', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onWordBoundary = vi.fn();
			p.onWordBoundary = onWordBoundary;

			p.synthesize('Hi. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			ws.triggerMessage({
				type: 'timestamps',
				context_id: contextId,
				word_timestamps: {},
			});

			expect(onWordBoundary).not.toHaveBeenCalled();
		});
	});

	// ── Receive: Done ─────────────────────────────────────────────────────

	describe('receive: done', () => {
		it('fires onDone with correct requestId', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			p.synthesize('Hello. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			ws.triggerMessage({ type: 'done', context_id: contextId });

			expect(onDone).toHaveBeenCalledWith(1);
			expect(onDone).toHaveBeenCalledTimes(1);
		});

		it('fires onDone once per requestId', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			// First request
			p.synthesize('First. ', 1, { flush: true });
			const ctx1 = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			// Second request
			p.synthesize('Second. ', 2, { flush: true });
			const msgs = parseSent(ws);
			// Find ctx for request 2 — it's in the last text message
			const textMsgs = msgs.filter((m) => m.transcript !== undefined);
			const ctx2 = textMsgs[textMsgs.length - 1].context_id;

			ws.triggerMessage({ type: 'done', context_id: ctx1 });
			ws.triggerMessage({ type: 'done', context_id: ctx2 });

			expect(onDone).toHaveBeenCalledTimes(2);
			expect(onDone).toHaveBeenNthCalledWith(1, 1);
			expect(onDone).toHaveBeenNthCalledWith(2, 2);
		});

		it('cleans up context mapping after done', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			const onAudio = vi.fn();
			p.onDone = onDone;
			p.onAudio = onAudio;

			p.synthesize('Hello. ', 1, { flush: true });
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			ws.triggerMessage({ type: 'done', context_id: contextId });

			// Late audio after done — context is already cleaned up, should be ignored
			ws.triggerMessage({
				type: 'chunk',
				context_id: contextId,
				data: 'AQID',
			});

			expect(onAudio).not.toHaveBeenCalled();
		});

		it('ignores done for unknown context', async () => {
			const p = createProvider();
			await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			// Trigger a done without ever matching ws triggerMessage for unknown context
			// The mock triggers message handler directly
			const ws = lastInstance();
			ws.triggerMessage({ type: 'done', context_id: 'unknown-ctx' });

			expect(onDone).not.toHaveBeenCalled();
		});
	});

	// ── Receive: Errors ───────────────────────────────────────────────────

	describe('receive: errors', () => {
		it('fires onError for server error message', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			ws.triggerMessage({ type: 'error', message: 'Rate limit exceeded' });

			expect(onError).toHaveBeenCalledTimes(1);
			const [err, fatal] = onError.mock.calls[0];
			expect(err).toBeInstanceOf(Error);
			expect(err.message).toBe('Rate limit exceeded');
			expect(fatal).toBe(false);
		});

		it('fires onError with error field fallback', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			ws.triggerMessage({ type: 'error', error: 'Invalid voice ID' });

			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError.mock.calls[0][0].message).toBe('Invalid voice ID');
		});

		it('handles malformed JSON gracefully', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			expect(() => ws.triggerMessage('not json{')).not.toThrow();
		});

		it('handles unknown message types gracefully', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			expect(() => ws.triggerMessage({ type: 'some_new_type', data: 'test' })).not.toThrow();
		});
	});

	// ── WebSocket Close ───────────────────────────────────────────────────

	describe('WebSocket close', () => {
		it('fires onError(fatal=true) on unexpected close', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			ws.triggerClose(1006, 'abnormal');

			expect(onError).toHaveBeenCalledTimes(1);
			const [err, fatal] = onError.mock.calls[0];
			expect(err).toBeInstanceOf(Error);
			expect(err.message).toContain('closed unexpectedly');
			expect(err.message).toContain('1006');
			expect(fatal).toBe(true);
		});

		it('does not fire onError when stopped', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			await p.stop();
			ws.triggerClose(1000, 'normal');

			expect(onError).not.toHaveBeenCalled();
		});
	});

	// ── Stop ──────────────────────────────────────────────────────────────

	describe('stop', () => {
		it('closes WebSocket with code 1000', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			await p.stop();

			expect(ws.closeCalled).toBe(true);
			expect(ws.closeCode).toBe(1000);
		});

		it('clears context mappings', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			p.synthesize('Hello. ', 1, { flush: true });

			await p.stop();

			// After stop, messages should not trigger callbacks
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;
			ws.triggerMessage({ type: 'done', context_id: contextId });
			expect(onDone).not.toHaveBeenCalled();
		});

		it('is idempotent', async () => {
			const p = createProvider();
			await startProvider(p);

			await p.stop();
			await p.stop(); // No error
		});

		it('synthesize is a no-op after stop', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			await p.stop();

			// Should not throw and should not send anything new
			const sentBefore = ws.sent.length;
			p.synthesize('test. ', 1);
			expect(ws.sent.length).toBe(sentBefore);
		});
	});

	// ── Context Mapping: requestId → context_id ───────────────────────────

	describe('context mapping', () => {
		it('maps sequential requestIds to unique context_ids', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			// Request 1
			p.synthesize('First. ', 1, { flush: true });
			// Request 2
			p.synthesize('Second. ', 2, { flush: true });
			// Request 3
			p.synthesize('Third. ', 3, { flush: true });

			const msgs = parseSent(ws);
			const textMsgs = msgs.filter((m) => m.transcript !== undefined);
			const contextIds = new Set(textMsgs.map((m) => m.context_id));

			// Each requestId should have a different context_id
			// (context changes produce finalization messages too, but the IDs should be unique)
			expect(contextIds.size).toBeGreaterThanOrEqual(3);
		});

		it('done for cancelled context cleans up mapping', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			p.synthesize('Hello. ', 1);
			const contextId = (JSON.parse(ws.sent[0]) as Record<string, unknown>).context_id;

			p.cancel();

			// Server sends done for cancelled context — should clean up without firing onDone
			ws.triggerMessage({ type: 'done', context_id: contextId });

			expect(onDone).not.toHaveBeenCalled();
		});
	});

	// ── Edge Cases ────────────────────────────────────────────────────────

	describe('edge cases', () => {
		it('handles empty text synthesize', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// Empty text should not crash
			p.synthesize('', 1);
			expect(ws.sent).toHaveLength(0);
		});

		it('handles WebSocket error after connection (fires onError)', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			ws.triggerError(new Error('Network failure'));

			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError.mock.calls[0][0].message).toBe('Network failure');
			expect(onError.mock.calls[0][1]).toBe(true);
		});

		it('numeric speed value is included in controls', async () => {
			const p = createProvider({ speed: 1.5 });
			const ws = await startProvider(p);

			p.synthesize('Hello. ', 1);

			const msg = JSON.parse(ws.sent[0]);
			expect((msg.voice as Record<string, unknown>).__experimental_controls).toEqual({
				speed: 1.5,
			});
		});

		it('custom modelId and language are sent in messages', async () => {
			const p = createProvider({ modelId: 'sonic-english', language: 'fr' });
			const ws = await startProvider(p);

			p.synthesize('Bonjour. ', 1);

			const msg = JSON.parse(ws.sent[0]);
			expect(msg.model_id).toBe('sonic-english');
			expect(msg.language).toBe('fr');
		});
	});
});
