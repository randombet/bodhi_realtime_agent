// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepgramSTTProvider } from '../../src/transport/deepgram-stt-provider.js';

type EventHandler = (...args: unknown[]) => void;

const { MockWebSocket } = vi.hoisted(() => {
	class MockWebSocket {
		static instances: MockWebSocket[] = [];
		static OPEN = 1;

		url: string;
		options: Record<string, unknown> | undefined;
		readyState = 0;
		handlers = new Map<string, EventHandler>();
		sent: Array<string | Buffer> = [];
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

		send(data: string | Buffer) {
			this.sent.push(data);
		}

		close(code?: number, reason?: string) {
			this.closeCalled = true;
			this.closeCode = code;
			this.closeReason = reason;
			this.readyState = 3;
		}

		triggerOpen() {
			this.readyState = 1;
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

function lastInstance(): MockWebSocket {
	return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function createProvider(
	overrides?: Partial<{
		model: string;
		language: string;
		endpointingMs: number | false;
		utteranceEndMs: number;
		punctuate: boolean;
		smartFormat: boolean;
		keyterms: string[];
	}>,
): DeepgramSTTProvider {
	const provider = new DeepgramSTTProvider({
		apiKey: 'test-api-key',
		...overrides,
	});
	provider.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });
	return provider;
}

function connectProvider(ws: MockWebSocket): void {
	ws.triggerOpen();
}

function deepgramResult(transcript: string, isFinal: boolean): Record<string, unknown> {
	return {
		type: 'Results',
		is_final: isFinal,
		channel: {
			alternatives: [{ transcript }],
		},
	};
}

describe('DeepgramSTTProvider', () => {
	beforeEach(() => {
		MockWebSocket.instances = [];
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('constructor', () => {
		it('throws if apiKey is empty', () => {
			expect(() => new DeepgramSTTProvider({ apiKey: '' })).toThrow('non-empty apiKey');
		});

		it('throws if apiKey is whitespace only', () => {
			expect(() => new DeepgramSTTProvider({ apiKey: '   ' })).toThrow('non-empty apiKey');
		});

		it('accepts custom Nova-3 options', () => {
			const provider = new DeepgramSTTProvider({
				apiKey: 'key',
				model: 'nova-3-medical',
				language: 'en',
				endpointingMs: 500,
				utteranceEndMs: 1500,
				punctuate: false,
				smartFormat: false,
				keyterms: ['Bodhi'],
			});
			expect(provider).toBeDefined();
		});
	});

	describe('configure', () => {
		it('accepts Gemini 16kHz mono PCM16 audio', () => {
			const provider = new DeepgramSTTProvider({ apiKey: 'key' });
			expect(() =>
				provider.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 }),
			).not.toThrow();
		});

		it('accepts OpenAI 24kHz mono PCM16 audio', () => {
			const provider = new DeepgramSTTProvider({ apiKey: 'key' });
			expect(() =>
				provider.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 }),
			).not.toThrow();
		});

		it('rejects non-16-bit depth', () => {
			const provider = new DeepgramSTTProvider({ apiKey: 'key' });
			expect(() => provider.configure({ sampleRate: 16000, bitDepth: 8, channels: 1 })).toThrow(
				'bitDepth=16',
			);
		});

		it('rejects stereo channels', () => {
			const provider = new DeepgramSTTProvider({ apiKey: 'key' });
			expect(() => provider.configure({ sampleRate: 16000, bitDepth: 16, channels: 2 })).toThrow(
				'channels=1',
			);
		});
	});

	describe('start', () => {
		it('opens WebSocket with Nova-3 live URL params', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();

			const url = new URL(ws.url);
			expect(url.origin).toBe('wss://api.deepgram.com');
			expect(url.pathname).toBe('/v1/listen');
			expect(url.searchParams.get('model')).toBe('nova-3');
			expect(url.searchParams.get('language')).toBe('en-US');
			expect(url.searchParams.get('encoding')).toBe('linear16');
			expect(url.searchParams.get('sample_rate')).toBe('16000');
			expect(url.searchParams.get('channels')).toBe('1');
			expect(url.searchParams.get('interim_results')).toBe('true');
			expect(url.searchParams.get('punctuate')).toBe('true');
			expect(url.searchParams.get('smart_format')).toBe('true');
			expect(url.searchParams.get('endpointing')).toBe('300');
			expect(url.searchParams.get('utterance_end_ms')).toBe('1000');
			expect(url.searchParams.get('vad_events')).toBe('true');

			connectProvider(ws);
			await startPromise;
		});

		it('passes Authorization token header', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();

			expect((ws.options as Record<string, Record<string, string>>).headers.Authorization).toBe(
				'Token test-api-key',
			);

			connectProvider(ws);
			await startPromise;
		});

		it('appends repeated keyterm params', async () => {
			const provider = createProvider({ keyterms: ['Bodhi', 'Deepgram'] });
			const startPromise = provider.start();
			const ws = lastInstance();

			const url = new URL(ws.url);
			expect(url.searchParams.getAll('keyterm')).toEqual(['Bodhi', 'Deepgram']);

			connectProvider(ws);
			await startPromise;
		});

		it('supports disabling endpointing', async () => {
			const provider = createProvider({ endpointingMs: false });
			const startPromise = provider.start();
			const ws = lastInstance();

			const url = new URL(ws.url);
			expect(url.searchParams.get('endpointing')).toBe('false');

			connectProvider(ws);
			await startPromise;
		});

		it('resolves on WebSocket open', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			connectProvider(lastInstance());
			await expect(startPromise).resolves.toBeUndefined();
		});

		it('rejects on WebSocket error during connect', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			lastInstance().triggerError(new Error('Connection refused'));
			await expect(startPromise).rejects.toThrow('Connection refused');
		});

		it('is idempotent when already started', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			connectProvider(lastInstance());
			await startPromise;

			await provider.start();
			expect(MockWebSocket.instances).toHaveLength(1);
		});
	});

	describe('feedAudio', () => {
		it('sends decoded PCM audio as binary data when connected', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			provider.feedAudio('dGVzdA==');

			expect(ws.sent).toHaveLength(1);
			expect(Buffer.isBuffer(ws.sent[0])).toBe(true);
			expect((ws.sent[0] as Buffer).toString('utf-8')).toBe('test');
		});

		it('drops audio while stopped', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			await provider.stop();
			provider.feedAudio('dGVzdA==');

			expect(ws.sent).toHaveLength(1);
			expect(JSON.parse(ws.sent[0] as string).type).toBe('CloseStream');
		});
	});

	describe('control messages', () => {
		it('commit sends Finalize as text JSON and stores turn id', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			provider.commit(7);

			expect(ws.sent).toHaveLength(1);
			expect(typeof ws.sent[0]).toBe('string');
			expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'Finalize' });
		});

		it('stop sends CloseStream before closing', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			await provider.stop();

			expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'CloseStream' });
			expect(ws.closeCalled).toBe(true);
			expect(ws.closeCode).toBe(1000);
		});

		it('sends KeepAlive as text JSON every 3 seconds', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			vi.advanceTimersByTime(3000);

			expect(ws.sent).toHaveLength(1);
			expect(typeof ws.sent[0]).toBe('string');
			expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: 'KeepAlive' });
		});

		it('stops KeepAlive after stop', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			await provider.stop();
			const sentBefore = ws.sent.length;
			vi.advanceTimersByTime(9000);

			expect(ws.sent).toHaveLength(sentBefore);
		});
	});

	describe('message handling', () => {
		it('fires onPartialTranscript for non-final Results', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onPartial = vi.fn();
			provider.onPartialTranscript = onPartial;

			ws.triggerMessage(deepgramResult('hello wor', false));

			expect(onPartial).toHaveBeenCalledWith('hello wor');
		});

		it('fires onTranscript with undefined turn id for final Results before commit', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;

			ws.triggerMessage(deepgramResult('auto finalized', true));

			expect(onTranscript).toHaveBeenCalledWith('auto finalized', undefined);
		});

		it('fires onTranscript with queued turn id for final Results after commit', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;

			provider.commit(7);
			ws.triggerMessage(deepgramResult('final text', true));

			expect(onTranscript).toHaveBeenCalledWith('final text', 7);
		});

		it('uses the latest pending turn id when a previous finalize returned no text', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;

			provider.commit(3);
			provider.commit(4);
			ws.triggerMessage(deepgramResult('latest turn text', true));

			expect(onTranscript).toHaveBeenCalledWith('latest turn text', 4);
		});

		it('ignores empty transcripts', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			const onPartial = vi.fn();
			const onTranscript = vi.fn();
			provider.onPartialTranscript = onPartial;
			provider.onTranscript = onTranscript;

			ws.triggerMessage(deepgramResult('   ', false));
			ws.triggerMessage(deepgramResult('', true));

			expect(onPartial).not.toHaveBeenCalled();
			expect(onTranscript).not.toHaveBeenCalled();
		});

		it('handles malformed JSON gracefully', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			expect(() => ws.triggerMessage('not json{')).not.toThrow();
		});

		it('handles non-result messages gracefully', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			expect(() => ws.triggerMessage({ type: 'Metadata', request_id: 'req_1' })).not.toThrow();
			expect(() => ws.triggerMessage({ type: 'UtteranceEnd', last_word_end: 1.2 })).not.toThrow();
			expect(() => ws.triggerMessage({ type: 'SpeechStarted', timestamp: 0.1 })).not.toThrow();
		});
	});

	describe('reconnection', () => {
		it('reconnects on unexpected close and flushes buffered audio', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws1 = lastInstance();
			connectProvider(ws1);
			await startPromise;

			ws1.triggerClose(1006, 'abnormal');
			provider.feedAudio('Y2h1bmsx');

			vi.advanceTimersByTime(1000);
			const ws2 = lastInstance();
			connectProvider(ws2);

			expect(MockWebSocket.instances).toHaveLength(2);
			expect(ws2.sent).toHaveLength(1);
			expect(Buffer.isBuffer(ws2.sent[0])).toBe(true);
			expect((ws2.sent[0] as Buffer).toString('utf-8')).toBe('chunk1');
		});

		it('drops oldest chunks when reconnect buffer overflows', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws1 = lastInstance();
			connectProvider(ws1);
			await startPromise;

			ws1.triggerClose(1006, 'abnormal');

			const bigChunk = Buffer.alloc(50_000, 1).toString('base64');
			provider.feedAudio(bigChunk);
			provider.feedAudio(bigChunk);

			vi.advanceTimersByTime(1000);
			const ws2 = lastInstance();
			connectProvider(ws2);

			const binaryMessages = ws2.sent.filter((message) => Buffer.isBuffer(message));
			expect(binaryMessages).toHaveLength(1);
		});

		it('cancels pending reconnect on stop', async () => {
			const provider = createProvider();
			const startPromise = provider.start();
			const ws = lastInstance();
			connectProvider(ws);
			await startPromise;

			ws.triggerClose(1006, 'abnormal');
			await provider.stop();

			vi.advanceTimersByTime(10_000);

			expect(MockWebSocket.instances).toHaveLength(1);
		});
	});
});
