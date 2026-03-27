// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsTTSProvider } from '../../src/transport/elevenlabs-tts-provider.js';

// ─── WebSocket Mock (hoisted for vi.mock factory) ─────────────────────────────

type EventHandler = (...args: unknown[]) => void;

const { MockWebSocket } = vi.hoisted(() => {
	class MockWebSocket {
		static instances: MockWebSocket[] = [];
		static OPEN = 1;
		static CONNECTING = 0;

		url: string;
		options: Record<string, unknown> | undefined;
		readyState = 0; // CONNECTING
		handlers = new Map<string, EventHandler[]>();
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
			const list = this.handlers.get(event) ?? [];
			list.push(handler);
			this.handlers.set(event, list);
		}

		removeAllListeners(event: string) {
			this.handlers.delete(event);
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
			const handlers = this.handlers.get('open') ?? [];
			for (const h of handlers) h();
		}

		triggerMessage(data: string | Record<string, unknown>) {
			const raw = typeof data === 'string' ? data : JSON.stringify(data);
			const handlers = this.handlers.get('message') ?? [];
			for (const h of handlers) h(raw);
		}

		triggerClose(code: number, reason: string) {
			this.readyState = 3;
			const handlers = this.handlers.get('close') ?? [];
			for (const h of handlers) h(code, Buffer.from(reason));
		}

		triggerError(err: Error) {
			const handlers = this.handlers.get('error') ?? [];
			for (const h of handlers) h(err);
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

/** Create and configure provider with defaults. */
function createProvider(
	overrides?: Partial<{
		modelId: string;
		stability: number;
		similarityBoost: number;
		style: number;
		useSpeakerBoost: boolean;
		languageCode: string;
	}>,
): ElevenLabsTTSProvider {
	const p = new ElevenLabsTTSProvider({
		apiKey: 'test-api-key',
		voiceId: 'test-voice-id',
		...overrides,
	});
	p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcm' });
	return p;
}

/** Connect provider: open WebSocket. */
async function startProvider(p: ElevenLabsTTSProvider): Promise<MockWebSocket> {
	const startPromise = p.start();
	const ws = lastInstance();
	ws.triggerOpen();
	await startPromise;
	return ws;
}

/** Parse all sent JSON messages from a WebSocket. */
function parseSent(ws: MockWebSocket): Record<string, unknown>[] {
	return ws.sent.map((s) => JSON.parse(s));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ElevenLabsTTSProvider', () => {
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
			expect(() => new ElevenLabsTTSProvider({ apiKey: '', voiceId: 'v1' })).toThrow(
				'non-empty apiKey',
			);
		});

		it('throws if apiKey is whitespace only', () => {
			expect(() => new ElevenLabsTTSProvider({ apiKey: '   ', voiceId: 'v1' })).toThrow(
				'non-empty apiKey',
			);
		});

		it('throws if voiceId is empty', () => {
			expect(() => new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: '' })).toThrow(
				'non-empty voiceId',
			);
		});

		it('throws if voiceId is whitespace only', () => {
			expect(() => new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: '  ' })).toThrow(
				'non-empty voiceId',
			);
		});

		it('accepts valid config with defaults', () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			expect(p).toBeDefined();
		});

		it('accepts custom config values', () => {
			const p = new ElevenLabsTTSProvider({
				apiKey: 'key',
				voiceId: 'v1',
				modelId: 'eleven_multilingual_v2',
				stability: 0.8,
				similarityBoost: 0.9,
				style: 0.3,
				useSpeakerBoost: false,
				languageCode: 'es',
			});
			expect(p).toBeDefined();
		});
	});

	// ── Configure ─────────────────────────────────────────────────────────

	describe('configure', () => {
		it('returns pcm_24000 for 24kHz preferred', () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 24000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			expect(result).toEqual({
				sampleRate: 24000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
		});

		it('returns pcm_16000 for 16kHz preferred', () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 16000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			expect(result.sampleRate).toBe(16000);
		});

		it('returns pcm_44100 for 44100Hz preferred', () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 44100,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			expect(result.sampleRate).toBe(44100);
		});

		it('falls back to 24kHz for unsupported sample rate', () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			const result = p.configure({
				sampleRate: 48000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			expect(result.sampleRate).toBe(24000);
		});
	});

	// ── Start ─────────────────────────────────────────────────────────────

	describe('start', () => {
		it('opens WebSocket with correct URL containing voiceId', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			expect(ws.url).toContain(
				'wss://api.elevenlabs.io/v1/text-to-speech/test-voice-id/stream-input',
			);
		});

		it('includes model_id and output_format in URL', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			expect(ws.url).toContain('model_id=eleven_flash_v2_5');
			expect(ws.url).toContain('output_format=pcm_24000');
		});

		it('passes xi-api-key header', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			expect((ws.options as Record<string, Record<string, string>>).headers['xi-api-key']).toBe(
				'test-api-key',
			);
		});

		it('sends BOS message on open', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			const messages = parseSent(ws);
			expect(messages.length).toBeGreaterThanOrEqual(1);

			const bos = messages[0];
			expect(bos.text).toBe(' ');
			expect(bos.xi_api_key).toBe('test-api-key');
			expect(bos.voice_settings).toEqual({
				stability: 0.5,
				similarity_boost: 0.75,
				style: 0.0,
				use_speaker_boost: true,
			});
			expect(bos.generation_config).toEqual({ flush: true });
		});

		it('includes languageCode in BOS when configured', async () => {
			const p = createProvider({ languageCode: 'es' });
			const ws = await startProvider(p);

			const bos = parseSent(ws)[0];
			expect(bos.language_code).toBe('es');
		});

		it('omits languageCode in BOS when not configured', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			const bos = parseSent(ws)[0];
			expect(bos.language_code).toBeUndefined();
		});

		it('uses custom voice settings from config', async () => {
			const p = createProvider({
				stability: 0.8,
				similarityBoost: 0.9,
				style: 0.3,
				useSpeakerBoost: false,
			});
			const ws = await startProvider(p);

			const bos = parseSent(ws)[0];
			expect(bos.voice_settings).toEqual({
				stability: 0.8,
				similarity_boost: 0.9,
				style: 0.3,
				use_speaker_boost: false,
			});
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

			// Advance past timeout
			vi.advanceTimersByTime(10_001);
			await expect(startPromise).rejects.toThrow('connection timeout');
		});

		it('is idempotent when already started', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// Second start() should be a no-op
			await p.start();
			expect(MockWebSocket.instances).toHaveLength(1);
		});

		it('throws if configure() was not called', async () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			await expect(p.start()).rejects.toThrow('configure() must be called');
		});
	});

	// ── Synthesize ────────────────────────────────────────────────────────

	describe('synthesize', () => {
		it('buffers text until sentence boundary', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const sentBeforeSynth = ws.sent.length; // BOS message

			p.synthesize('Hello world', 1);
			// No sentence boundary — should not send text yet
			expect(parseSent(ws).length).toBe(sentBeforeSynth);

			// Complete sentence
			p.synthesize('. ', 1);
			const messages = parseSent(ws);
			const textMessages = messages.filter(
				(m) => typeof m.text === 'string' && m.text !== ' ' && m.try_trigger_generation,
			);
			expect(textMessages.length).toBe(1);
			expect(textMessages[0].text).toBe('Hello world. ');
		});

		it('sends text with try_trigger_generation flag', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('Hello world. ', 1);
			const messages = parseSent(ws).filter((m) => m.try_trigger_generation === true);
			expect(messages.length).toBe(1);
			expect(messages[0].text).toBe('Hello world. ');
		});

		it('flushes remaining text with flush option', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const sentBeforeSynth = ws.sent.length;

			p.synthesize('partial text', 1, { flush: true });

			// Should have sent the text + a flush signal
			const messages = parseSent(ws).slice(sentBeforeSynth);
			const textMessages = messages.filter(
				(m) => typeof m.text === 'string' && m.text !== '' && m.text !== ' ',
			);
			expect(textMessages.length).toBe(1);
			expect(textMessages[0].text).toBe('partial text');

			// Should also send flush signal (empty text with flush: true)
			const flushMessages = messages.filter((m) => m.text === '' && m.flush === true);
			expect(flushMessages.length).toBe(1);
		});

		it('flushes previous requestId buffer when new requestId arrives', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const sentBeforeSynth = ws.sent.length;

			// Buffer some text for requestId 1
			p.synthesize('buffered text', 1);
			// Now switch to requestId 2 — should flush "buffered text"
			p.synthesize('New sentence. ', 2);

			const messages = parseSent(ws).slice(sentBeforeSynth);
			const textMessages = messages.filter(
				(m) =>
					typeof m.text === 'string' && m.text !== '' && m.text !== ' ' && m.try_trigger_generation,
			);
			// Should have: "buffered text" (flushed) + "New sentence. " (sentence boundary)
			expect(textMessages.length).toBe(2);
			expect(textMessages[0].text).toBe('buffered text');
			expect(textMessages[1].text).toBe('New sentence. ');
		});

		it('silently drops when not connected', () => {
			const p = createProvider();
			// Never started — should not throw
			p.synthesize('text', 1);
			expect(MockWebSocket.instances).toHaveLength(0);
		});
	});

	// ── Backpressure ──────────────────────────────────────────────────────

	describe('backpressure', () => {
		it('drops input when pending chars exceed 10,000 limit', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const sentBeforeSynth = ws.sent.length;

			// Send a large chunk that exceeds the limit in one go
			// SentenceBuffer will flush at 200 chars, so this sends one 10,001-char message
			const bigText = 'A'.repeat(10_001);
			p.synthesize(bigText, 1);

			const messagesAfter = parseSent(ws).slice(sentBeforeSynth);
			const textMessages = messagesAfter.filter(
				(m) => typeof m.text === 'string' && m.try_trigger_generation === true,
			);
			expect(textMessages.length).toBe(1);
			expect((textMessages[0].text as string).length).toBe(10_001);

			// Now pending chars = 10,001 (above limit)
			// Next synthesize should be dropped
			const sentBeforeDrop = ws.sent.length;
			p.synthesize('This should be dropped. ', 1);
			expect(ws.sent.length).toBe(sentBeforeDrop);
		});

		it('resumes accepting input after isFinal resets pending count', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// Send enough to exceed limit
			p.synthesize('A'.repeat(10_001), 1);

			// Verify input is dropped
			const sentBeforeDrop = ws.sent.length;
			p.synthesize('Dropped. ', 1);
			expect(ws.sent.length).toBe(sentBeforeDrop);

			// Server finishes synthesis — resets pending count
			ws.triggerMessage({ isFinal: true });

			// Now input should be accepted again
			p.synthesize('Accepted text. ', 2);
			const messages = parseSent(ws);
			const lastText = messages.filter((m) => m.try_trigger_generation === true);
			expect(lastText[lastText.length - 1].text).toBe('Accepted text. ');
		});

		it('resets pending count on cancel', async () => {
			const p = createProvider();
			await startProvider(p);

			// Fill up pending chars
			p.synthesize('A'.repeat(10_001), 1);

			// Cancel resets pending
			p.cancel();

			// Reconnect
			const ws2 = lastInstance();
			ws2.triggerOpen();

			// Should accept new input
			p.synthesize('New text. ', 2);
			const textMessages = parseSent(ws2).filter((m) => m.try_trigger_generation === true);
			expect(textMessages.length).toBe(1);
			expect(textMessages[0].text).toBe('New text. ');
		});
	});

	// ── Audio reception ───────────────────────────────────────────────────

	describe('audio reception', () => {
		it('fires onAudio with base64 audio, duration, and requestId', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			p.synthesize('Hello. ', 5);

			// Simulate audio response: 480 samples at 24kHz = 20ms, 960 bytes, ~1280 base64 chars
			// Simple: 4 bytes (2 samples at 16-bit) → base64 "AABBCCDD" (8 chars → 6 bytes → 3 samples)
			const base64Audio = 'AQIDBA=='; // 4 bytes → 2 samples at 24kHz
			ws.triggerMessage({
				audio: base64Audio,
			});

			expect(onAudio).toHaveBeenCalledTimes(1);
			const [audio, durationMs, requestId] = onAudio.mock.calls[0];
			expect(audio).toBe(base64Audio);
			expect(requestId).toBe(5);
			expect(durationMs).toBeGreaterThan(0);
		});

		it('calculates duration correctly for 24kHz PCM', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			p.synthesize('Test. ', 1);

			// 48000 bytes = 24000 samples at 16-bit = 1 second at 24kHz
			// base64 of 48000 bytes = 64000 chars
			const base64Audio = 'A'.repeat(64000); // ~48000 bytes → 24000 samples → 1000ms
			ws.triggerMessage({ audio: base64Audio });

			expect(onAudio).toHaveBeenCalledTimes(1);
			const durationMs = onAudio.mock.calls[0][1];
			expect(durationMs).toBeCloseTo(1000, -1);
		});

		it('does not fire onAudio for empty audio field', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			p.synthesize('Test. ', 1);
			ws.triggerMessage({ audio: '' });

			expect(onAudio).not.toHaveBeenCalled();
		});

		it('does not fire onAudio when no requestId is active', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onAudio = vi.fn();
			p.onAudio = onAudio;

			// No synthesize() call — no active requestId
			ws.triggerMessage({ audio: 'AQIDBA==' });

			expect(onAudio).not.toHaveBeenCalled();
		});
	});

	// ── onDone ────────────────────────────────────────────────────────────

	describe('onDone', () => {
		it('fires onDone when isFinal is true', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			p.synthesize('Hello world. ', 7);
			ws.triggerMessage({ audio: 'AQID', isFinal: false });
			expect(onDone).not.toHaveBeenCalled();

			ws.triggerMessage({ isFinal: true });
			expect(onDone).toHaveBeenCalledTimes(1);
			expect(onDone).toHaveBeenCalledWith(7);
		});

		it('fires onDone only once per requestId', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			p.synthesize('Test. ', 3);
			ws.triggerMessage({ isFinal: true });
			ws.triggerMessage({ isFinal: true }); // duplicate

			// Should only fire once because requestId is removed from pending set
			expect(onDone).toHaveBeenCalledTimes(1);
		});

		it('fires onDone with correct requestId after cancel and new synthesis', async () => {
			const p = createProvider();
			const ws1 = await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			p.synthesize('First sentence. ', 10);
			// Cancel — this should fire onDone for requestId 10
			p.cancel();

			expect(onDone).toHaveBeenCalledWith(10);
			onDone.mockClear();

			// Reconnect happens — get new WebSocket
			const ws2 = lastInstance();
			ws2.triggerOpen();

			// New synthesis on the new connection
			p.synthesize('Second sentence. ', 11);
			ws2.triggerMessage({ isFinal: true });

			expect(onDone).toHaveBeenCalledTimes(1);
			expect(onDone).toHaveBeenCalledWith(11);
		});
	});

	// ── Word boundaries ───────────────────────────────────────────────────

	describe('word boundaries', () => {
		it('parses alignment data and fires onWordBoundary', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onWord = vi.fn();
			p.onWordBoundary = onWord;

			p.synthesize('Hello world. ', 1);
			ws.triggerMessage({
				audio: 'AQID',
				alignment: {
					chars: ['H', 'e', 'l', 'l', 'o', ' ', 'w', 'o', 'r', 'l', 'd'],
					charStartTimesMs: [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500],
					charDurationsMs: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50],
				},
			});

			expect(onWord).toHaveBeenCalledTimes(2);
			expect(onWord).toHaveBeenNthCalledWith(1, 'Hello', 0, 1);
			expect(onWord).toHaveBeenNthCalledWith(2, 'world', 300, 1);
		});

		it('handles normalizedAlignment as alternative format', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onWord = vi.fn();
			p.onWordBoundary = onWord;

			p.synthesize('Hi there. ', 2);
			ws.triggerMessage({
				audio: 'AQID',
				normalizedAlignment: {
					chars: ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e'],
					charStartTimesMs: [0, 30, 60, 90, 120, 150, 180, 210],
					charDurationsMs: [30, 30, 30, 30, 30, 30, 30, 30],
				},
			});

			expect(onWord).toHaveBeenCalledTimes(2);
			expect(onWord).toHaveBeenNthCalledWith(1, 'Hi', 0, 2);
			expect(onWord).toHaveBeenNthCalledWith(2, 'there', 90, 2);
		});

		it('does not fire for empty alignment', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onWord = vi.fn();
			p.onWordBoundary = onWord;

			p.synthesize('Test. ', 1);
			ws.triggerMessage({
				audio: 'AQID',
				alignment: { chars: [], charStartTimesMs: [], charDurationsMs: [] },
			});

			expect(onWord).not.toHaveBeenCalled();
		});
	});

	// ── Cancel ────────────────────────────────────────────────────────────

	describe('cancel', () => {
		it('sends flush message before closing', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const sentBeforeCancel = ws.sent.length;

			p.synthesize('Some text', 1);
			p.cancel();

			const messages = parseSent(ws).slice(sentBeforeCancel);
			const flushMsg = messages.find((m) => m.text === '' && m.flush === true);
			expect(flushMsg).toBeDefined();
		});

		it('closes WebSocket and opens new one', async () => {
			const p = createProvider();
			await startProvider(p);

			const countBefore = MockWebSocket.instances.length;
			p.synthesize('Text. ', 1);
			p.cancel();

			// Should have created a new WebSocket for reconnect
			expect(MockWebSocket.instances.length).toBe(countBefore + 1);
		});

		it('clears sentence buffer', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			p.synthesize('Unbuffered text without boundary', 1);
			p.cancel();

			// Reconnect
			const ws2 = lastInstance();
			ws2.triggerOpen();
			const sentAfterReconnect = ws2.sent.length;

			// New synthesis should not include old buffered text
			p.synthesize('Fresh text. ', 2);
			const messages = parseSent(ws2).slice(sentAfterReconnect);
			const textMessages = messages.filter(
				(m) => typeof m.text === 'string' && m.try_trigger_generation,
			);
			for (const msg of textMessages) {
				expect(msg.text).not.toContain('Unbuffered');
			}
		});

		it('fires onDone for pending requestIds', async () => {
			const p = createProvider();
			await startProvider(p);
			const onDone = vi.fn();
			p.onDone = onDone;

			p.synthesize('Hello. ', 5);
			p.cancel();

			expect(onDone).toHaveBeenCalledWith(5);
		});

		it('is safe to call when not connected', () => {
			const p = createProvider();
			expect(() => p.cancel()).not.toThrow();
		});
	});

	// ── Stop ──────────────────────────────────────────────────────────────

	describe('stop', () => {
		it('sends EOS message before closing', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const sentBeforeStop = ws.sent.length;

			await p.stop();

			const messages = parseSent(ws).slice(sentBeforeStop);
			const eosMsg = messages.find((m) => m.text === '');
			expect(eosMsg).toBeDefined();
		});

		it('closes WebSocket with code 1000', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			await p.stop();

			expect(ws.closeCalled).toBe(true);
			expect(ws.closeCode).toBe(1000);
		});

		it('clears internal state', async () => {
			const p = createProvider();
			await startProvider(p);

			p.synthesize('Some text. ', 1);
			await p.stop();

			// After stop, synthesize should be silently dropped
			const onAudio = vi.fn();
			p.onAudio = onAudio;
			p.synthesize('More text. ', 2);
			expect(onAudio).not.toHaveBeenCalled();
		});

		it('is idempotent', async () => {
			const p = createProvider();
			await startProvider(p);

			await p.stop();
			await p.stop(); // Should not throw
		});

		it('does not fire onError on normal close after stop', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			await p.stop();

			// WebSocket close event after stop should not trigger error
			ws.triggerClose(1000, 'normal');
			expect(onError).not.toHaveBeenCalled();
		});
	});

	// ── Error handling ────────────────────────────────────────────────────

	describe('error handling', () => {
		it('fires onError on unexpected WebSocket close', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			ws.triggerClose(1006, 'abnormal');

			expect(onError).toHaveBeenCalledTimes(1);
			const [err, fatal] = onError.mock.calls[0];
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain('closed unexpectedly');
			expect(fatal).toBe(true);
		});

		it('fires onError for WebSocket error after connected', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			// Clear the connect reject handler by confirming connected state
			ws.triggerError(new Error('Network failure'));

			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError.mock.calls[0][1]).toBe(true); // fatal
		});

		it('fires onError for server error messages', async () => {
			const p = createProvider();
			const ws = await startProvider(p);
			const onError = vi.fn();
			p.onError = onError;

			ws.triggerMessage({ error: 'rate_limited' });

			expect(onError).toHaveBeenCalledTimes(1);
			expect((onError.mock.calls[0][0] as Error).message).toContain('rate_limited');
			expect(onError.mock.calls[0][1]).toBe(false); // non-fatal
		});

		it('handles malformed JSON gracefully', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			// Should not throw
			expect(() => ws.triggerMessage('not json{')).not.toThrow();
		});
	});

	// ── Format negotiation ────────────────────────────────────────────────

	describe('format negotiation', () => {
		it('uses pcm_24000 for 24kHz and encodes in URL', async () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcm' });

			const ws = await startProvider(p);
			expect(ws.url).toContain('output_format=pcm_24000');
		});

		it('uses pcm_16000 for 16kHz', async () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			p.configure({ sampleRate: 16000, bitDepth: 16, channels: 1, encoding: 'pcm' });

			const ws = await startProvider(p);
			expect(ws.url).toContain('output_format=pcm_16000');
		});

		it('uses pcm_22050 for 22050Hz', async () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			p.configure({ sampleRate: 22050, bitDepth: 16, channels: 1, encoding: 'pcm' });

			const ws = await startProvider(p);
			expect(ws.url).toContain('output_format=pcm_22050');
		});

		it('defaults to pcm_24000 for unsupported rate (e.g. 48000)', async () => {
			const p = new ElevenLabsTTSProvider({ apiKey: 'key', voiceId: 'v1' });
			p.configure({ sampleRate: 48000, bitDepth: 16, channels: 1, encoding: 'pcm' });

			const ws = await startProvider(p);
			expect(ws.url).toContain('output_format=pcm_24000');
		});
	});

	// ── Full lifecycle ────────────────────────────────────────────────────

	describe('full lifecycle', () => {
		it('connect → synthesize → receive audio → onDone → stop', async () => {
			const p = createProvider();
			const ws = await startProvider(p);

			const onAudio = vi.fn();
			const onDone = vi.fn();
			p.onAudio = onAudio;
			p.onDone = onDone;

			// Synthesize
			p.synthesize('Hello world. ', 1);

			// Receive audio chunks
			ws.triggerMessage({ audio: 'AQIDBA==' });
			ws.triggerMessage({ audio: 'BQYHCA==' });
			expect(onAudio).toHaveBeenCalledTimes(2);

			// Final
			ws.triggerMessage({ isFinal: true });
			expect(onDone).toHaveBeenCalledWith(1);

			// Stop
			await p.stop();
			expect(ws.closeCalled).toBe(true);
		});

		it('connect → synthesize → cancel → reconnect → new synthesis', async () => {
			const p = createProvider();
			const ws1 = await startProvider(p);

			const onDone = vi.fn();
			p.onDone = onDone;

			// First synthesis
			p.synthesize('First. ', 1);
			// Cancel
			p.cancel();
			expect(onDone).toHaveBeenCalledWith(1);

			// Reconnect
			const ws2 = lastInstance();
			ws2.triggerOpen();

			// Second synthesis
			onDone.mockClear();
			p.synthesize('Second. ', 2);
			ws2.triggerMessage({ isFinal: true });
			expect(onDone).toHaveBeenCalledWith(2);
		});
	});
});
