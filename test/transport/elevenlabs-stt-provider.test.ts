// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElevenLabsSTTProvider } from '../../src/transport/elevenlabs-stt-provider.js';

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

/** Simulate a successful connection: open → session_started. */
function connectProvider(ws: MockWebSocket): void {
	ws.triggerOpen();
	ws.triggerMessage({ message_type: 'session_started', session_id: 'test-session' });
}

function createProvider(
	overrides?: Partial<{ model: string; languageCode: string }>,
): ElevenLabsSTTProvider {
	const p = new ElevenLabsSTTProvider({
		apiKey: 'test-api-key',
		...overrides,
	});
	p.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });
	return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ElevenLabsSTTProvider', () => {
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
			expect(() => new ElevenLabsSTTProvider({ apiKey: '' })).toThrow('non-empty apiKey');
		});

		it('throws if apiKey is whitespace only', () => {
			expect(() => new ElevenLabsSTTProvider({ apiKey: '   ' })).toThrow('non-empty apiKey');
		});

		it('uses default model and languageCode', () => {
			const p = new ElevenLabsSTTProvider({ apiKey: 'key' });
			p.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });
			// Defaults verified in start() URL params below
			expect(p).toBeDefined();
		});

		it('accepts custom model and languageCode', () => {
			const p = new ElevenLabsSTTProvider({
				apiKey: 'key',
				model: 'custom_model',
				languageCode: 'es',
			});
			expect(p).toBeDefined();
		});
	});

	// ── Configure ─────────────────────────────────────────────────────────

	describe('configure', () => {
		it('accepts 16kHz sample rate', () => {
			const p = new ElevenLabsSTTProvider({ apiKey: 'key' });
			expect(() => p.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 })).not.toThrow();
		});

		it('accepts 24kHz sample rate (OpenAI transport)', () => {
			const p = new ElevenLabsSTTProvider({ apiKey: 'key' });
			expect(() => p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 })).not.toThrow();
		});

		it('rejects unsupported sample rate', () => {
			const p = new ElevenLabsSTTProvider({ apiKey: 'key' });
			expect(() => p.configure({ sampleRate: 12000, bitDepth: 16, channels: 1 })).toThrow(
				'unsupported sample rate 12000Hz',
			);
		});

		it('rejects non-16-bit depth', () => {
			const p = new ElevenLabsSTTProvider({ apiKey: 'key' });
			expect(() => p.configure({ sampleRate: 16000, bitDepth: 8, channels: 1 })).toThrow(
				'bitDepth=16',
			);
		});

		it('rejects stereo channels', () => {
			const p = new ElevenLabsSTTProvider({ apiKey: 'key' });
			expect(() => p.configure({ sampleRate: 16000, bitDepth: 16, channels: 2 })).toThrow(
				'channels=1',
			);
		});
	});

	// ── Start ─────────────────────────────────────────────────────────────

	describe('start', () => {
		it('opens WebSocket with correct URL params', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();

			const url = new URL(ws.url);
			expect(url.origin).toBe('wss://api.elevenlabs.io');
			expect(url.pathname).toBe('/v1/speech-to-text/realtime');
			expect(url.searchParams.get('model_id')).toBe('scribe_v2');
			expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
			expect(url.searchParams.get('sample_rate')).toBe('16000');
			expect(url.searchParams.get('language_code')).toBe('en');
			expect(url.searchParams.get('commit_strategy')).toBe('vad');

			connectProvider(ws);
			await startPromise;
		});

		it('uses pcm_24000 audio_format for 24kHz', async () => {
			const p = new ElevenLabsSTTProvider({ apiKey: 'key' });
			p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
			const startPromise = p.start();
			const ws = lastInstance();

			const url = new URL(ws.url);
			expect(url.searchParams.get('audio_format')).toBe('pcm_24000');
			expect(url.searchParams.get('sample_rate')).toBe('24000');

			connectProvider(ws);
			await startPromise;
		});

		it('passes xi-api-key header', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();

			expect((ws.options as Record<string, Record<string, string>>).headers['xi-api-key']).toBe(
				'test-api-key',
			);

			connectProvider(ws);
			await startPromise;
		});

		it('resolves on session_started message', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();

			connectProvider(ws);
			await expect(startPromise).resolves.toBeUndefined();
		});

		it('rejects on WebSocket error during connect', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();

			ws.triggerError(new Error('Connection refused'));
			await expect(startPromise).rejects.toThrow('Connection refused');
		});

		it('is idempotent when already started', async () => {
			const p = createProvider();
			const startPromise = p.start();
			connectProvider(lastInstance());
			await startPromise;

			// Second start() should be a no-op
			await p.start();
			expect(MockWebSocket.instances).toHaveLength(1);
		});
	});

	// ── feedAudio ─────────────────────────────────────────────────────────

	describe('feedAudio', () => {
		it('sends audio chunk immediately when connected', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			p.feedAudio('dGVzdA==');

			expect(ws.sent).toHaveLength(1);
			const msg = JSON.parse(ws.sent[0]);
			expect(msg.message_type).toBe('input_audio_chunk');
			expect(msg.audio_base_64).toBe('dGVzdA==');
			expect(msg.sample_rate).toBe(16000);
		});

		it('queues to reconnect buffer when reconnecting', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			// Simulate disconnect
			ws.triggerClose(1006, 'abnormal');
			// Now state is 'reconnecting'

			p.feedAudio('Y2h1bmsx');
			p.feedAudio('Y2h1bmsy');

			// No new messages sent (WebSocket is closed)
			expect(ws.sent).toHaveLength(0); // ws was the old connection, no sends
		});

		it('drops oldest chunks when reconnect buffer overflows', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			ws.triggerClose(1006, 'abnormal');

			// MAX_RECONNECT_BUFFER_BYTES = 64000
			// Each chunk: 60000 base64 chars ≈ 45000 bytes
			const bigChunk = 'A'.repeat(60000);
			p.feedAudio(bigChunk); // first: ~45000 bytes
			p.feedAudio(bigChunk); // second: would overflow, drops first

			// Now advance timer to trigger reconnect
			vi.advanceTimersByTime(1000);
			const ws2 = lastInstance();
			connectProvider(ws2);

			// Only the second chunk should have been flushed
			const audioMessages = ws2.sent
				.map((s) => JSON.parse(s))
				.filter((m: Record<string, unknown>) => m.message_type === 'input_audio_chunk');
			expect(audioMessages).toHaveLength(1);
		});

		it('silently drops when stopped', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			await p.stop();
			p.feedAudio('dGVzdA==');
			// No crash, no new messages
			expect(ws.sent).toHaveLength(0);
		});

		it('silently drops when idle (before start)', () => {
			const p = createProvider();
			p.feedAudio('dGVzdA==');
			// No crash, no WebSocket created
			expect(MockWebSocket.instances).toHaveLength(0);
		});
	});

	// ── commit ────────────────────────────────────────────────────────────

	describe('commit', () => {
		it('enqueues turnId in pending queue', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			p.commit(5);
			p.commit(6);

			// Verify via committed_transcript attribution
			const onTranscript = vi.fn();
			p.onTranscript = onTranscript;

			ws.triggerMessage({ message_type: 'committed_transcript', text: 'hello' });
			expect(onTranscript).toHaveBeenCalledWith('hello', 5);

			ws.triggerMessage({ message_type: 'committed_transcript', text: 'world' });
			expect(onTranscript).toHaveBeenCalledWith('world', 6);
		});

		it('sends manual commit message over WebSocket', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			p.commit(1);

			const commitMsg = JSON.parse(ws.sent[0]);
			expect(commitMsg.message_type).toBe('input_audio_chunk');
			expect(commitMsg.audio_base_64).toBe('');
			expect(commitMsg.commit).toBe(true);
		});

		it('does not throw when WebSocket is disconnected', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			ws.triggerClose(1006, 'abnormal');

			// Should not throw — just enqueues turnId
			expect(() => p.commit(1)).not.toThrow();
		});
	});

	// ── Message handling ──────────────────────────────────────────────────

	describe('message handling', () => {
		it('fires onPartialTranscript for partial_transcript', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onPartial = vi.fn();
			p.onPartialTranscript = onPartial;

			ws.triggerMessage({ message_type: 'partial_transcript', text: 'hello wor' });
			expect(onPartial).toHaveBeenCalledWith('hello wor');
		});

		it('does not fire onPartialTranscript for empty text', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onPartial = vi.fn();
			p.onPartialTranscript = onPartial;

			ws.triggerMessage({ message_type: 'partial_transcript', text: '  ' });
			expect(onPartial).not.toHaveBeenCalled();
		});

		it('fires onTranscript for committed_transcript with FIFO turnId', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onTranscript = vi.fn();
			p.onTranscript = onTranscript;

			p.commit(3);
			ws.triggerMessage({ message_type: 'committed_transcript', text: 'hello world' });

			expect(onTranscript).toHaveBeenCalledWith('hello world', 3);
		});

		it('fires onTranscript with undefined turnId when queue is empty', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onTranscript = vi.fn();
			p.onTranscript = onTranscript;

			// No commit() call — VAD auto-committed
			ws.triggerMessage({ message_type: 'committed_transcript', text: 'auto committed' });

			expect(onTranscript).toHaveBeenCalledWith('auto committed', undefined);
		});

		it('does not fire onTranscript for empty committed text', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onTranscript = vi.fn();
			p.onTranscript = onTranscript;

			ws.triggerMessage({ message_type: 'committed_transcript', text: '' });
			expect(onTranscript).not.toHaveBeenCalled();
		});

		it('sequential commits attribute correctly (FIFO)', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onTranscript = vi.fn();
			p.onTranscript = onTranscript;

			p.commit(10);
			p.commit(11);
			p.commit(12);

			ws.triggerMessage({ message_type: 'committed_transcript', text: 'first' });
			ws.triggerMessage({ message_type: 'committed_transcript', text: 'second' });
			ws.triggerMessage({ message_type: 'committed_transcript', text: 'third' });

			expect(onTranscript).toHaveBeenNthCalledWith(1, 'first', 10);
			expect(onTranscript).toHaveBeenNthCalledWith(2, 'second', 11);
			expect(onTranscript).toHaveBeenNthCalledWith(3, 'third', 12);
		});

		it('handles malformed JSON gracefully', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			// Should not throw
			expect(() => ws.triggerMessage('not json{')).not.toThrow();
		});

		it('handles unknown message types gracefully', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			expect(() =>
				ws.triggerMessage({ message_type: 'some_new_type', data: 'test' }),
			).not.toThrow();
		});
	});

	// ── stop ──────────────────────────────────────────────────────────────

	describe('stop', () => {
		it('closes WebSocket with code 1000', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			await p.stop();

			expect(ws.closeCalled).toBe(true);
			expect(ws.closeCode).toBe(1000);
		});

		it('clears pending turnIds and reconnect buffer', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			p.commit(1);
			p.commit(2);

			await p.stop();

			// After stop, committed_transcript should not fire with old turnIds
			const onTranscript = vi.fn();
			p.onTranscript = onTranscript;

			// feedAudio should be silently dropped
			p.feedAudio('dGVzdA==');
			expect(ws.sent).toHaveLength(2); // Only the 2 commit messages from before stop
		});

		it('is idempotent', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			await p.stop();
			await p.stop(); // No error
		});

		it('cancels pending reconnect timer', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			ws.triggerClose(1006, 'abnormal');
			// Reconnect is scheduled

			await p.stop();

			// Advance time past reconnect delay — should NOT create new WebSocket
			const countBefore = MockWebSocket.instances.length;
			vi.advanceTimersByTime(10000);
			expect(MockWebSocket.instances.length).toBe(countBefore);
		});
	});

	// ── handleInterrupted / handleTurnComplete ────────────────────────────

	describe('handleInterrupted / handleTurnComplete', () => {
		it('handleInterrupted is a no-op', () => {
			const p = createProvider();
			expect(() => p.handleInterrupted()).not.toThrow();
		});

		it('handleTurnComplete is a no-op', () => {
			const p = createProvider();
			expect(() => p.handleTurnComplete()).not.toThrow();
		});
	});

	// ── Reconnection ──────────────────────────────────────────────────────

	describe('reconnection', () => {
		it('triggers reconnect on unexpected close', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const countBefore = MockWebSocket.instances.length;
			ws.triggerClose(1006, 'abnormal');

			// Advance past initial backoff (1s)
			vi.advanceTimersByTime(1000);
			expect(MockWebSocket.instances.length).toBe(countBefore + 1);
		});

		it('uses exponential backoff', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws1 = lastInstance();
			connectProvider(ws1);
			await startPromise;

			// First disconnect
			ws1.triggerClose(1006, 'abnormal');

			// After 999ms — not yet
			vi.advanceTimersByTime(999);
			expect(MockWebSocket.instances.length).toBe(1);

			// At 1000ms — reconnect attempt
			vi.advanceTimersByTime(1);
			const ws2 = lastInstance();
			expect(MockWebSocket.instances.length).toBe(2);

			// Fail the reconnect — need to flush the promise microtask queue
			// so the .catch() handler in _scheduleReconnect runs
			ws2.triggerError(new Error('fail'));
			await vi.advanceTimersByTimeAsync(0);

			// Next backoff should be 2000ms
			vi.advanceTimersByTime(1999);
			expect(MockWebSocket.instances.length).toBe(2);

			vi.advanceTimersByTime(1);
			expect(MockWebSocket.instances.length).toBe(3);
		});

		it('resets backoff on successful reconnect', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws1 = lastInstance();
			connectProvider(ws1);
			await startPromise;

			// Disconnect and reconnect
			ws1.triggerClose(1006, 'abnormal');
			vi.advanceTimersByTime(1000);
			const ws2 = lastInstance();
			connectProvider(ws2);

			// Disconnect again — backoff should be reset to 1s (not 2s)
			ws2.triggerClose(1006, 'abnormal');
			vi.advanceTimersByTime(999);
			const countBefore = MockWebSocket.instances.length;
			vi.advanceTimersByTime(1);
			expect(MockWebSocket.instances.length).toBe(countBefore + 1);
		});

		it('flushes reconnect buffer after session_started', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws1 = lastInstance();
			connectProvider(ws1);
			await startPromise;

			ws1.triggerClose(1006, 'abnormal');

			// Buffer audio during reconnect gap
			p.feedAudio('Y2h1bmsx');
			p.feedAudio('Y2h1bmsy');

			// Reconnect
			vi.advanceTimersByTime(1000);
			const ws2 = lastInstance();
			connectProvider(ws2);

			// Flushed chunks should be among the sent messages
			const audioMessages = ws2.sent
				.map((s) => JSON.parse(s))
				.filter((m: Record<string, unknown>) => m.message_type === 'input_audio_chunk');
			expect(audioMessages).toHaveLength(2);
			expect(audioMessages[0].audio_base_64).toBe('Y2h1bmsx');
			expect(audioMessages[1].audio_base_64).toBe('Y2h1bmsy');
		});

		it('does not reconnect after stop()', async () => {
			const p = createProvider();
			const startPromise = p.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			await p.stop();
			ws.triggerClose(1000, 'normal');

			vi.advanceTimersByTime(10000);
			// Only the original WebSocket instance
			expect(MockWebSocket.instances).toHaveLength(1);
		});
	});
});
