import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIRealtimeWhisperSTTProvider } from '../../src/transport/openai-realtime-whisper-stt-provider.js';

// ─── WebSocket Mock (hoisted) ────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => void;

const { MockWebSocket } = vi.hoisted(() => {
	class MockWebSocket {
		static instances: MockWebSocket[] = [];
		static OPEN = 1;

		url: string;
		options: Record<string, unknown> | undefined;
		readyState = 0;
		handlers = new Map<string, EventHandler>();
		sent: string[] = [];
		closeCalled = false;

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

		close(_code?: number, _reason?: string) {
			this.closeCalled = true;
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

		sentEvents(): Record<string, unknown>[] {
			return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
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

/** Open + send the update acknowledgement so start() resolves. */
function bringUp(ws: MockWebSocket): void {
	ws.triggerOpen();
	ws.triggerMessage({ type: 'transcription_session.updated' });
}

function createConfigured(): OpenAIRealtimeWhisperSTTProvider {
	const p = new OpenAIRealtimeWhisperSTTProvider({ apiKey: 'sk-test' });
	p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
	return p;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpenAIRealtimeWhisperSTTProvider', () => {
	beforeEach(() => {
		MockWebSocket.instances = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('constructor + configure', () => {
		it('throws if apiKey is empty', () => {
			expect(() => new OpenAIRealtimeWhisperSTTProvider({ apiKey: '' })).toThrow(
				'non-empty apiKey',
			);
		});

		it('advertises supportedEncodings = pcm only', () => {
			const p = new OpenAIRealtimeWhisperSTTProvider({ apiKey: 'sk' });
			expect(p.supportedEncodings).toEqual(['pcm']);
		});

		it('configure throws on non-24kHz sample rate', () => {
			const p = new OpenAIRealtimeWhisperSTTProvider({ apiKey: 'sk' });
			expect(() => p.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 })).toThrow(
				/UNSUPPORTED_SAMPLE_RATE/,
			);
		});

		it('configure throws on non-PCM encoding', () => {
			const p = new OpenAIRealtimeWhisperSTTProvider({ apiKey: 'sk' });
			expect(() =>
				p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcmu' }),
			).toThrow(/not supported/);
		});

		it('configure throws on non-mono channels', () => {
			const p = new OpenAIRealtimeWhisperSTTProvider({ apiKey: 'sk' });
			expect(() => p.configure({ sampleRate: 24000, bitDepth: 16, channels: 2 })).toThrow('mono');
		});
	});

	describe('start() / stop() lifecycle', () => {
		it('opens WS to /v1/realtime?intent=transcription and sends a transcription session.update', async () => {
			const p = createConfigured();
			const startPromise = p.start();
			const ws = lastInstance();
			expect(ws.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
			expect((ws.options?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');

			bringUp(ws);
			await startPromise;

			const update = ws.sentEvents().find((e) => e.type === 'session.update') as
				| {
						session?: {
							type?: string;
							audio?: {
								input?: {
									format?: { type?: string; rate?: number };
									transcription?: { model?: string };
									turn_detection?: { type?: string };
								};
							};
						};
				  }
				| undefined;
			expect(update).toBeDefined();
			expect(update?.session?.type).toBe('transcription');
			expect(update?.session?.audio?.input?.format).toEqual({ type: 'audio/pcm', rate: 24000 });
			expect(update?.session?.audio?.input?.transcription?.model).toBe('gpt-realtime-whisper');
			expect(update?.session?.audio?.input?.turn_detection?.type).toBe('server_vad');
		});

		it('waits for session.updated before resolving start() or flushing buffered audio', async () => {
			const p = createConfigured();
			let resolved = false;
			const startPromise = p.start().then(() => {
				resolved = true;
			});
			const ws = lastInstance();

			p.feedAudio('AAAA');
			ws.triggerOpen();
			ws.triggerMessage({ type: 'session.created' });
			await Promise.resolve();

			expect(resolved).toBe(false);
			expect(ws.sentEvents().filter((e) => e.type === 'input_audio_buffer.append')).toHaveLength(0);

			ws.triggerMessage({ type: 'session.updated' });
			await startPromise;

			expect(resolved).toBe(true);
			expect(
				ws
					.sentEvents()
					.filter((e) => e.type === 'input_audio_buffer.append')
					.map((e) => e.audio),
			).toEqual(['AAAA']);
		});

		it('rejects start() when the server returns a setup error', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const p = createConfigured();
			const startPromise = p.start();
			const ws = lastInstance();

			ws.triggerOpen();
			ws.triggerMessage({
				type: 'error',
				error: { code: 'invalid_request_error', message: 'bad transcription config' },
			});

			await expect(startPromise).rejects.toThrow(/bad transcription config/);
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});

		it('start() is idempotent — second call returns without re-connecting', async () => {
			const p = createConfigured();
			const first = p.start();
			bringUp(lastInstance());
			await first;
			const instancesBefore = MockWebSocket.instances.length;
			await p.start();
			expect(MockWebSocket.instances.length).toBe(instancesBefore);
		});

		it('stop() closes the WS and clears state', async () => {
			const p = createConfigured();
			const start = p.start();
			bringUp(lastInstance());
			await start;

			await p.stop();
			expect(lastInstance().closeCalled).toBe(true);

			// Second stop is a no-op.
			await p.stop();
		});
	});

	describe('streaming transcripts + item_id attribution', () => {
		it('fires onPartialTranscript on .delta events', async () => {
			const p = createConfigured();
			const start = p.start();
			const ws = lastInstance();
			bringUp(ws);
			await start;

			const partials: string[] = [];
			p.onPartialTranscript = (t) => partials.push(t);

			ws.triggerMessage({
				type: 'conversation.item.input_audio_transcription.delta',
				delta: 'Hello ',
			});
			ws.triggerMessage({
				type: 'conversation.item.input_audio_transcription.delta',
				delta: 'world',
			});
			expect(partials).toEqual(['Hello ', 'world']);
		});

		it('attributes finals to the framework turnId via item_id, not FIFO of commit() calls', async () => {
			// Two commits, two finals — the finals arrive in REVERSE order.
			// FIFO would attribute them the wrong way; item_id matching is correct.
			const p = createConfigured();
			const start = p.start();
			const ws = lastInstance();
			bringUp(ws);
			await start;

			const finals: Array<{ text: string; turnId: number | undefined }> = [];
			p.onTranscript = (text, turnId) => finals.push({ text, turnId });

			p.commit(101);
			ws.triggerMessage({ type: 'input_audio_buffer.committed', item_id: 'itemA' });
			p.commit(202);
			ws.triggerMessage({ type: 'input_audio_buffer.committed', item_id: 'itemB' });

			// Finals come back OUT of order.
			ws.triggerMessage({
				type: 'conversation.item.input_audio_transcription.completed',
				item_id: 'itemB',
				transcript: 'second',
			});
			ws.triggerMessage({
				type: 'conversation.item.input_audio_transcription.completed',
				item_id: 'itemA',
				transcript: 'first',
			});

			expect(finals).toEqual([
				{ text: 'second', turnId: 202 },
				{ text: 'first', turnId: 101 },
			]);
		});

		it('emits onTranscript with undefined turnId when VAD auto-commits without a framework commit()', async () => {
			const p = createConfigured();
			const start = p.start();
			const ws = lastInstance();
			bringUp(ws);
			await start;

			const finals: Array<{ text: string; turnId: number | undefined }> = [];
			p.onTranscript = (text, turnId) => finals.push({ text, turnId });

			// Server-VAD-driven commit: no framework commit() ran, so no entry in
			// _pendingTurnIds. item_id has no mapping; turnId is undefined.
			ws.triggerMessage({ type: 'input_audio_buffer.committed', item_id: 'auto_1' });
			ws.triggerMessage({
				type: 'conversation.item.input_audio_transcription.completed',
				item_id: 'auto_1',
				transcript: 'hi',
			});

			expect(finals).toEqual([{ text: 'hi', turnId: undefined }]);
		});

		it('fires onTranscript with empty string on .failed events', async () => {
			const p = createConfigured();
			const start = p.start();
			const ws = lastInstance();
			bringUp(ws);
			await start;

			const finals: Array<{ text: string; turnId: number | undefined }> = [];
			p.onTranscript = (text, turnId) => finals.push({ text, turnId });

			p.commit(7);
			ws.triggerMessage({ type: 'input_audio_buffer.committed', item_id: 'fail_1' });
			ws.triggerMessage({
				type: 'conversation.item.input_audio_transcription.failed',
				item_id: 'fail_1',
			});

			expect(finals).toEqual([{ text: '', turnId: 7 }]);
		});
	});

	describe('feedAudio + reconnect buffering', () => {
		it('forwards audio as input_audio_buffer.append on the WS', async () => {
			const p = createConfigured();
			const start = p.start();
			const ws = lastInstance();
			bringUp(ws);
			await start;

			p.feedAudio('dGVzdA==');
			const append = ws.sentEvents().find((e) => e.type === 'input_audio_buffer.append');
			expect(append).toEqual({ type: 'input_audio_buffer.append', audio: 'dGVzdA==' });
		});

		it('buffers audio during connecting and flushes after the update acknowledgement', async () => {
			const p = createConfigured();
			const startPromise = p.start();
			const ws = lastInstance();

			// Feed audio BEFORE the session is up — should buffer, not error.
			p.feedAudio('AAAA');
			p.feedAudio('BBBB');

			// Now bring the session up.
			bringUp(ws);
			await startPromise;

			const appends = ws.sentEvents().filter((e) => e.type === 'input_audio_buffer.append');
			expect(appends.map((a) => a.audio)).toEqual(['AAAA', 'BBBB']);
		});
	});
});
