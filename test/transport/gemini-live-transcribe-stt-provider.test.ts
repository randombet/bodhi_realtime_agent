import { describe, expect, it } from 'vitest';
import {
	GeminiLiveTranscribeSTTProvider,
	type WebSocketLike,
} from '../../src/transport/gemini-live-transcribe-stt-provider.js';

class FakeSocket implements WebSocketLike {
	readyState = 0;
	// biome-ignore lint/suspicious/noExplicitAny: parsed wire JSON, inspected field by field
	sent: any[] = [];
	closed = false;
	private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
	on(ev: string, fn: (...a: never[]) => void) {
		this.handlers[ev] = [...(this.handlers[ev] ?? []), fn as (...a: unknown[]) => void];
	}
	emit(ev: string, ...a: unknown[]) {
		for (const fn of this.handlers[ev] ?? []) fn(...a);
	}
	send(d: string) {
		this.sent.push(JSON.parse(d));
	}
	close() {
		this.closed = true;
		this.readyState = 3;
	}
	openAndSetup() {
		this.readyState = 1;
		this.emit('open');
		this.emit('message', JSON.stringify({ setupComplete: {} }));
	}
	audioCount() {
		return this.sent.filter((m) => m.realtimeInput?.audio).length;
	}
}

const chunk = Buffer.alloc(4800).toString('base64'); // 100 ms of silence @ 24 kHz
const loud = (() => {
	const b = Buffer.alloc(4800);
	for (let i = 0; i < 2400; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
	return b.toString('base64');
})();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

type ProviderOptions = Partial<ConstructorParameters<typeof GeminiLiveTranscribeSTTProvider>[0]>;

function makeProvider(opts: ProviderOptions = {}) {
	const sockets: FakeSocket[] = [];
	const p = new GeminiLiveTranscribeSTTProvider({
		apiKey: 'k',
		rotateAfterMs: 60_000,
		drainMs: 5,
		retryDelayMs: 5,
		...opts,
		createSocket: () => {
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
	});
	p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
	return { p, sockets };
}

/** start() resolves on setupComplete, so the fake socket must answer before it is awaited. */
async function startReady(p: GeminiLiveTranscribeSTTProvider, socket: () => FakeSocket) {
	const started = p.start();
	socket().openAndSetup();
	await started;
}

const final = (text: string) => JSON.stringify({ serverContent: { inputTranscription: { text } } });

describe('GeminiLiveTranscribeSTTProvider', () => {
	it('sends the Transcribe Live setup and 16 kHz audio', async () => {
		const { p, sockets } = makeProvider();
		await startReady(p, () => sockets[0]);
		p.feedAudio(chunk);
		const setup = sockets[0].sent[0].setup;
		expect(setup.model).toBe('models/gemini-3.5-transcribe-live');
		expect(setup.generationConfig.responseModalities).toEqual(['TEXT']);
		expect(setup.inputAudioTranscription).toBeTruthy();
		const audio = sockets[0].sent[1].realtimeInput.audio;
		expect(audio.mimeType).toBe('audio/pcm;rate=16000');
		expect(Buffer.from(audio.data, 'base64').length).toBe(3200);
		await p.stop();
	});

	it('sends custom vocabulary when given', async () => {
		const sockets: FakeSocket[] = [];
		const p = new GeminiLiveTranscribeSTTProvider({
			apiKey: 'k',
			customVocabulary: ['Sutando'],
			createSocket: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
		});
		p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
		await startReady(p, () => sockets[0]);
		expect(sockets[0].sent[0].setup.inputAudioTranscription.customVocabulary).toEqual(['Sutando']);
		await p.stop();
	});

	it('buffers audio until setup completes', async () => {
		const { p, sockets } = makeProvider();
		const started = p.start();
		p.feedAudio(chunk);
		p.feedAudio(chunk);
		expect(sockets[0].audioCount()).toBe(0);
		sockets[0].openAndSetup();
		await started;
		p.feedAudio(chunk);
		expect(sockets[0].audioCount()).toBe(3);
		await p.stop();
	});

	it('forwards final and interim transcripts', async () => {
		const { p, sockets } = makeProvider();
		const finals: string[] = [];
		const partials: string[] = [];
		p.onTranscript = (t) => finals.push(t);
		p.onPartialTranscript = (t) => partials.push(t);
		await startReady(p, () => sockets[0]);
		sockets[0].emit(
			'message',
			JSON.stringify({ serverContent: { interimInputTranscription: { text: 'hel' } } }),
		);
		sockets[0].emit(
			'message',
			Buffer.from(
				JSON.stringify({ serverContent: { inputTranscription: { text: ' hello world ' } } }),
			),
		);
		expect(partials).toEqual(['hel']);
		expect(finals).toEqual(['hello world']);
		await p.stop();
	});

	it('rotates sessions at a pause without dropping or duplicating audio', async () => {
		const { p, sockets } = makeProvider({ rotateAfterMs: 20 });
		const finals: string[] = [];
		p.onTranscript = (t) => finals.push(t);
		await startReady(p, () => sockets[0]);
		p.feedAudio(loud);
		await tick(30);
		expect(sockets.length).toBe(2);
		sockets[1].openAndSetup();
		p.feedAudio(loud); // speech continues → stays on the old session
		p.feedAudio(chunk);
		p.feedAudio(chunk);
		expect(sockets[1].audioCount()).toBe(0);
		p.feedAudio(chunk); // 300 ms of quiet → hand over
		p.feedAudio(loud);
		expect(sockets[0].audioCount()).toBe(4);
		expect(sockets[1].audioCount()).toBe(2);
		expect(sockets[0].sent.some((m) => m.realtimeInput?.audioStreamEnd)).toBeTruthy();
		// The old socket still delivers its last utterance while draining.
		sockets[0].emit(
			'message',
			JSON.stringify({ serverContent: { inputTranscription: { text: 'last words' } } }),
		);
		await tick(20);
		expect(sockets[0].closed).toBeTruthy();
		expect(finals).toEqual(['last words']);
		await p.stop();
	});

	it('hands over at the deadline when nobody pauses', async () => {
		const sockets: FakeSocket[] = [];
		const p = new GeminiLiveTranscribeSTTProvider({
			apiKey: 'k',
			rotateAfterMs: 10,
			pauseWaitMs: 20,
			drainMs: 5,
			createSocket: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
		});
		p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
		await startReady(p, () => sockets[0]);
		await tick(15);
		sockets[1].openAndSetup();
		p.feedAudio(loud);
		expect(sockets[1].audioCount()).toBe(0);
		await tick(25);
		p.feedAudio(loud);
		expect(sockets[1].audioCount()).toBe(1);
		await p.stop();
	});

	it('reconnects when the active socket drops', async () => {
		const { p, sockets } = makeProvider();
		await startReady(p, () => sockets[0]);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom');
		p.feedAudio(chunk);
		expect(sockets.length).toBe(2);
		sockets[1].openAndSetup();
		expect(sockets[1].audioCount()).toBe(1);
		await p.stop();
	});

	it('resolves start() only once the session is set up, sharing it across callers', async () => {
		const { p, sockets } = makeProvider();
		let done = 0;
		const prewarm = p.start().then(() => done++);
		const entry = p.start().then(() => done++);
		await tick();
		expect(sockets.length).toBe(1);
		expect(done).toBe(0);
		sockets[0].openAndSetup();
		await Promise.all([prewarm, entry]);
		expect(done).toBe(2);
		await p.stop();
	});

	it('rejects start() when the session closes before setup, and can start again', async () => {
		const { p, sockets } = makeProvider();
		const started = p.start();
		sockets[0].emit('close', 1008, 'API key not valid');
		await expect(started).rejects.toThrow(/closed before setup/);
		await tick(20);
		expect(sockets.length).toBe(1);
		await startReady(p, () => sockets[1]);
		expect(sockets.length).toBe(2);
		await p.stop();
	});

	it('rejects start() when setup times out', async () => {
		const { p, sockets } = makeProvider({ connectTimeoutMs: 10 });
		await expect(p.start()).rejects.toThrow(/timed out/);
		expect(sockets[0].closed).toBe(true);
	});

	it('retries a replacement that fails before the handover', async () => {
		const { p, sockets } = makeProvider({ rotateAfterMs: 20 });
		await startReady(p, () => sockets[0]);
		await tick(30);
		expect(sockets.length).toBe(2);
		sockets[1].emit('close', 1011, 'boom');
		await tick(20);
		expect(sockets.length).toBe(3);
		sockets[2].openAndSetup();
		for (let i = 0; i < 3; i++) p.feedAudio(chunk);
		expect(sockets[2].audioCount()).toBeGreaterThan(0);
		await p.stop();
	});

	it('schedules a new rotation when a replacement or reconnect becomes active', async () => {
		const { p, sockets } = makeProvider({ rotateAfterMs: 20 });
		await startReady(p, () => sockets[0]);
		await tick(30);
		sockets[1].openAndSetup();
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom'); // promotes the ready replacement
		await tick(30);
		expect(sockets.length).toBe(3);
		sockets[2].openAndSetup();
		for (let i = 0; i < 3; i++) p.feedAudio(chunk); // hand over to sockets[2]
		sockets[2].readyState = 3;
		sockets[2].emit('close', 1011, 'boom'); // no replacement: reconnect
		expect(sockets.length).toBe(4);
		sockets[3].openAndSetup();
		await tick(30);
		expect(sockets.length).toBe(5);
		await p.stop();
	});

	it('closes retired sockets on stop and drops their late transcripts', async () => {
		const { p, sockets } = makeProvider({ rotateAfterMs: 20, drainMs: 5_000 });
		const finals: string[] = [];
		p.onTranscript = (t) => finals.push(t);
		await startReady(p, () => sockets[0]);
		await tick(30);
		sockets[1].openAndSetup();
		for (let i = 0; i < 3; i++) p.feedAudio(chunk); // sockets[0] is retired and draining
		expect(sockets[0].closed).toBe(false);
		await p.stop();
		expect(sockets[0].closed).toBe(true);
		sockets[0].emit('message', final('old run'));
		await startReady(p, () => sockets[2]);
		sockets[0].emit('message', final('old run'));
		sockets[2].emit('message', final('new run'));
		expect(finals).toEqual(['new run']);
		await p.stop();
	});
});
