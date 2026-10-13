import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import {
	type GeminiLiveTranscribeLifecycleEvent,
	type GeminiLiveTranscribeSTTConfig,
	GeminiLiveTranscribeSTTProvider,
	type GeminiLiveTranscribeSTTProviderConfig,
	type WebSocketLike,
} from '../../src/transport/gemini-live-transcribe-stt-provider.js';
import type {
	GeminiCredential,
	GeminiLiveSetup,
} from '../../src/transport/gemini-live-transport.js';
import type { ConnectFailureError } from '../../src/types/transport.js';

class FakeSocket implements WebSocketLike {
	readyState = 0;
	// biome-ignore lint/suspicious/noExplicitAny: parsed wire JSON, inspected field by field
	sent: any[] = [];
	/** Each frame as sent, for byte-for-byte checks. */
	raw: string[] = [];
	closed = false;
	private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
	on(ev: string, fn: (...a: never[]) => void) {
		this.handlers[ev] = [...(this.handlers[ev] ?? []), fn as (...a: unknown[]) => void];
	}
	emit(ev: string, ...a: unknown[]) {
		for (const fn of this.handlers[ev] ?? []) fn(...a);
	}
	send(d: string) {
		this.raw.push(d);
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

type ProviderOptions = Partial<GeminiLiveTranscribeSTTConfig>;

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
		expect(sockets).toHaveLength(2); // no reconnect beside it
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

	it('retries a replacement that closes after setup but before the handover', async () => {
		const { p, sockets } = makeProvider({ rotateAfterMs: 20 });
		await startReady(p, () => sockets[0]);
		await tick(30);
		sockets[1].openAndSetup();
		p.feedAudio(loud); // speech continues on sockets[0]
		sockets[1].readyState = 3;
		sockets[1].emit('close', 1011, 'boom');
		await tick(20);
		expect(sockets.length).toBe(3);
		sockets[2].openAndSetup();
		for (let i = 0; i < 3; i++) p.feedAudio(chunk);
		expect(sockets[2].audioCount()).toBeGreaterThan(0);
		await p.stop();
	});

	it('does not promote a replacement that is no longer open', async () => {
		const { p, sockets } = makeProvider({ rotateAfterMs: 20 });
		await startReady(p, () => sockets[0]);
		await tick(30);
		sockets[1].openAndSetup();
		sockets[1].readyState = 3; // dropped, close event not delivered yet
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom');
		expect(sockets.length).toBe(3);
		sockets[2].openAndSetup();
		p.feedAudio(chunk);
		expect(sockets[2].audioCount()).toBe(1);
		expect(sockets[1].audioCount()).toBe(0);
		await p.stop();
	});

	it('promotes a replacement still connecting when the active socket drops, opening none beside it', async () => {
		const { p, sockets } = makeProvider({ rotateAfterMs: 20 });
		await startReady(p, () => sockets[0]);
		await tick(30);
		expect(sockets).toHaveLength(2); // the replacement is dialing
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom');
		expect(sockets).toHaveLength(2);
		p.feedAudio(chunk); // buffered for the replacement
		sockets[1].openAndSetup();
		expect(sockets[1].audioCount()).toBe(1);
		await p.stop();
	});
});

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage';

const token = (n: number, extra: Partial<GeminiCredential> = {}): GeminiCredential => ({
	apiKey: `auth_tokens/t${n}`,
	expiresAtMs: Date.now() + 30 * 60_000,
	meta: { id: `c${n}` },
	...extra,
});

/** A provider on a `credentialProvider` answering call `n` (from 1) with `credential(n)`. */
function makeTokenProvider(
	credential: (n: number) => GeminiCredential | Promise<GeminiCredential>,
	opts: Partial<Omit<GeminiLiveTranscribeSTTProviderConfig, 'credentialProvider'>> = {},
) {
	const sockets: FakeSocket[] = [];
	const urls: string[] = [];
	const calls: Array<{ setup: GeminiLiveSetup; signal: AbortSignal }> = [];
	const events: GeminiLiveTranscribeLifecycleEvent[] = [];
	const p = new GeminiLiveTranscribeSTTProvider({
		credentialProvider: async (setup, signal) => {
			calls.push({ setup, signal });
			return credential(calls.length);
		},
		rotateAfterMs: 60_000,
		drainMs: 5,
		retryDelayMs: 5,
		onConnectionLifecycle: (e) => events.push(e),
		...opts,
		createSocket: (url) => {
			urls.push(url);
			const s = new FakeSocket();
			sockets.push(s);
			return s;
		},
	});
	p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
	return { p, sockets, urls, calls, events };
}

/** start() with a provider: the socket is dialed once the credential has arrived. */
async function startWithCredential(p: GeminiLiveTranscribeSTTProvider, sockets: FakeSocket[]) {
	const started = p.start();
	await tick();
	sockets[sockets.length - 1].openAndSetup();
	await started;
}

describe('GeminiLiveTranscribeSTTProvider credentials', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('takes exactly one of apiKey and credentialProvider', () => {
		expect(() => new GeminiLiveTranscribeSTTProvider({} as GeminiLiveTranscribeSTTConfig)).toThrow(
			ValidationError,
		);
		expect(
			() =>
				new GeminiLiveTranscribeSTTProvider({
					apiKey: 'k',
					credentialProvider: async () => token(1),
				} as unknown as GeminiLiveTranscribeSTTConfig),
		).toThrow(/mutually exclusive/);
	});

	it('keeps the apiKey path as it was: the v1beta key URL, dialed at once, and the same setup frame', async () => {
		const urls: string[] = [];
		const sockets: FakeSocket[] = [];
		const p = new GeminiLiveTranscribeSTTProvider({
			apiKey: 'k',
			customVocabulary: ['Sutando'],
			createSocket: (url) => {
				urls.push(url);
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
		});
		const started = p.start();
		expect(urls).toEqual([`${WS_BASE}.v1beta.GenerativeService.BidiGenerateContent?key=k`]);
		sockets[0].openAndSetup();
		await started;
		expect(sockets[0].raw[0]).toBe(
			'{"setup":{"model":"models/gemini-3.5-transcribe-live","generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"languageCodes":[],"mode":"VERBATIM","customVocabulary":["Sutando"]}}}',
		);
		await p.stop();
	});

	it('fetches a credential for every connection (start, rotation, reconnect) with the setup it sends', async () => {
		const { p, sockets, calls } = makeTokenProvider((n) => token(n), {
			rotateAfterMs: 20,
			customVocabulary: ['Sutando'],
		});
		await startWithCredential(p, sockets);
		expect(calls).toHaveLength(1);
		const { setup, signal } = calls[0];
		expect(setup).toEqual({
			model: 'gemini-3.5-transcribe-live',
			config: {
				responseModalities: ['TEXT'],
				inputAudioTranscription: {
					languageCodes: [],
					mode: 'VERBATIM',
					customVocabulary: ['Sutando'],
				},
			},
		});
		expect(Object.isFrozen(setup.config.inputAudioTranscription)).toBe(true);
		expect(signal).toBeInstanceOf(AbortSignal);
		// The wire frame is that setup in the SDK's wire form, nothing added.
		expect(sockets[0].sent[0]).toEqual({
			setup: {
				model: `models/${setup.model}`,
				generationConfig: { responseModalities: setup.config.responseModalities },
				inputAudioTranscription: setup.config.inputAudioTranscription,
			},
		});
		await tick(30); // rotation
		expect(calls).toHaveLength(2);
		expect(calls[1].setup).toEqual(setup);
		expect(sockets).toHaveLength(2);
		sockets[1].openAndSetup();
		for (let i = 0; i < 3; i++) p.feedAudio(chunk); // handover at a pause
		sockets[1].readyState = 3;
		sockets[1].emit('close', 1011, 'boom'); // reconnect
		expect(calls).toHaveLength(3);
		await tick();
		expect(sockets).toHaveLength(3);
		sockets[2].openAndSetup();
		expect(sockets[2].sent[0]).toEqual(sockets[0].sent[0]);
		await p.stop();
	});

	it('dials a token on the Constrained endpoint with access_token, on its apiVersion (default v1alpha), and a key on the key endpoint', async () => {
		const credentials = [
			token(1),
			token(2, { apiVersion: 'v1beta' }),
			{ apiKey: 'AIzaKey', expiresAtMs: Date.now() + 60 * 60_000 },
		];
		const { p, sockets, urls } = makeTokenProvider((n) => credentials[n - 1]);
		await startWithCredential(p, sockets);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom');
		await tick();
		sockets[1].openAndSetup();
		sockets[1].readyState = 3;
		sockets[1].emit('close', 1011, 'boom');
		await tick();
		expect(urls).toEqual([
			`${WS_BASE}.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens/t1`,
			`${WS_BASE}.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens/t2`,
			`${WS_BASE}.v1beta.GenerativeService.BidiGenerateContent?key=AIzaKey`,
		]);
		await p.stop();
	});

	it('rotates ahead of the credential expiry: a connect, a pause wait and a drain before it', async () => {
		vi.useFakeTimers();
		const { p, sockets, calls } = makeTokenProvider(
			(n) => token(n, { expiresAtMs: Date.now() + 10_000 }),
			{
				rotateAfterMs: 600_000,
				connectTimeoutMs: 1_000,
				pauseWaitMs: 1_000,
				drainMs: 100,
				minCredentialLifetimeMs: 0,
			},
		);
		const started = p.start();
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].openAndSetup();
		await started;
		await vi.advanceTimersByTimeAsync(7_899); // 10 000 - (1 000 + 1 000 + 100) = 7 900
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
		sockets[1].openAndSetup();
		for (let i = 0; i < 3; i++) p.feedAudio(chunk);
		expect(sockets[0].sent.some((m) => m.realtimeInput?.audioStreamEnd)).toBe(true);
		const stopped = p.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		await stopped;
	});

	it('closes a connection still in use at its credential expiry and reconnects on a fresh credential', async () => {
		vi.useFakeTimers();
		const expiresAtMs = Date.now() + 10_000;
		const { p, sockets, calls } = makeTokenProvider(
			(n) =>
				n === 1
					? token(1, { expiresAtMs })
					: n <= 3
						? Promise.reject(new Error('mint failed')) // the replacement never comes
						: token(n),
			{
				rotateAfterMs: 600_000,
				connectTimeoutMs: 1_000,
				pauseWaitMs: 1_000,
				drainMs: 100,
				maxRetries: 1,
				retryDelayMs: 10,
				minCredentialLifetimeMs: 0,
			},
		);
		const started = p.start();
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].openAndSetup();
		await started;
		await vi.advanceTimersByTimeAsync(9_999);
		expect(calls).toHaveLength(3); // the rotation and its one retry failed
		expect(sockets[0].closed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets[0].closed).toBe(true);
		expect(calls).toHaveLength(4);
		expect(sockets).toHaveLength(2);
		p.feedAudio(chunk);
		sockets[1].openAndSetup();
		expect(sockets[1].audioCount()).toBe(1);
		const stopped = p.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		await stopped;
	});

	it('closes a connection at a credential expiry further out than one timer holds, not at once', async () => {
		vi.useFakeTimers();
		// Past setTimeout's 2^31-1 ms (~24.8 days), which a single timer runs after 1 ms.
		const expiresAtMs = Date.now() + 30 * 86_400_000;
		const fatal: Error[] = [];
		const { p, sockets, calls } = makeTokenProvider(
			(n) =>
				n === 1
					? token(1, { expiresAtMs })
					: n <= 3
						? Promise.reject(new Error('mint failed')) // the replacement never comes
						: token(n),
			{ rotateAfterMs: 600_000, maxRetries: 1, retryDelayMs: 10, onFatal: (e) => fatal.push(e) },
		);
		const started = p.start();
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].openAndSetup();
		await started;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(sockets[0].closed).toBe(false);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(expiresAtMs - Date.now() - 1);
		expect(calls).toHaveLength(3); // the rotation and its one retry failed
		expect(sockets[0].closed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets[0].closed).toBe(true);
		expect(calls).toHaveLength(4);
		expect(fatal).toHaveLength(0);
		const stopped = p.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		await stopped;
	});

	it('aborts the credential fetch on stop(), rejects start(), and never dials a late credential', async () => {
		let late: (c: GeminiCredential) => void = () => {};
		const { p, sockets, calls, events } = makeTokenProvider(
			() =>
				new Promise<GeminiCredential>((resolve) => {
					late = resolve;
				}),
		);
		const started = p.start();
		const rejected = expect(started).rejects.toThrow(/stopped before setup/);
		await tick();
		expect(calls[0].signal.aborted).toBe(false);
		await p.stop();
		expect(calls[0].signal.aborted).toBe(true);
		await rejected;
		late(token(1));
		await tick();
		expect(sockets).toHaveLength(0);
		expect(events).toEqual([
			{
				phase: 'closed',
				connectionId: 1,
				setupDone: false,
				failure: expect.objectContaining({ source: 'provider' }),
			},
		]);
	});

	it('gives the credential fetch half the connect deadline', async () => {
		const { p, sockets, calls } = makeTokenProvider(() => new Promise<GeminiCredential>(() => {}), {
			connectTimeoutMs: 40,
		});
		await expect(p.start()).rejects.toThrow(/credential fetch timed out after 20ms/);
		expect(calls[0].signal.aborted).toBe(true);
		expect(sockets).toHaveLength(0);
	});

	it('rejects start() when the provider fails, keeping its retryable flag, and fetches anew on the next start()', async () => {
		const { p, sockets, calls, events } = makeTokenProvider((n) =>
			n === 1
				? Promise.reject(Object.assign(new Error('no key for this owner'), { retryable: false }))
				: token(n),
		);
		const err = (await p.start().catch((e: unknown) => e)) as ConnectFailureError;
		expect(err.message).toMatch(/Gemini credential provider failed: no key for this owner/);
		expect(err.connectFailure).toMatchObject({ source: 'provider', retryable: false });
		expect(sockets).toHaveLength(0);
		expect(events.at(-1)).toMatchObject({
			phase: 'closed',
			setupDone: false,
			failure: { source: 'provider' },
		});
		await startWithCredential(p, sockets);
		expect(calls).toHaveLength(2);
		await p.stop();
	});

	it('refuses a credential expiring within the connect deadline plus minCredentialLifetimeMs, reporting its meta', async () => {
		const { p, sockets, events } = makeTokenProvider(
			() => token(1, { expiresAtMs: Date.now() + 30_000 }),
			{ connectTimeoutMs: 10_000, minCredentialLifetimeMs: 60_000 },
		);
		await expect(p.start()).rejects.toThrow(/credential expires in/);
		expect(sockets).toHaveLength(0);
		expect(events).toEqual([
			{
				phase: 'closed',
				connectionId: 1,
				meta: { id: 'c1' },
				setupDone: false,
				failure: expect.objectContaining({ source: 'provider' }),
			},
		]);
	});

	it('ends the run at once, without a retry, when the provider fails permanently after start()', async () => {
		const fatal: Error[] = [];
		const { p, sockets, calls } = makeTokenProvider(
			(n) =>
				n === 1
					? token(1)
					: Promise.reject(Object.assign(new Error('access revoked'), { retryable: false })),
			{ onFatal: (e) => fatal.push(e) },
		);
		await startWithCredential(p, sockets);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom');
		await tick(30);
		expect(calls).toHaveLength(2);
		expect(fatal).toHaveLength(1);
		expect((fatal[0] as ConnectFailureError).connectFailure).toMatchObject({
			source: 'provider',
			retryable: false,
		});
		// The run is over: start() begins a new one.
		const again = p.start();
		expect(calls).toHaveLength(3);
		await expect(again).rejects.toThrow(/access revoked/);
	});

	it('retries a reconnect whose credential provider throws synchronously', async () => {
		const sockets: FakeSocket[] = [];
		let calls = 0;
		const p = new GeminiLiveTranscribeSTTProvider({
			// Not async: call 2 throws before it returns a promise.
			credentialProvider: () => {
				calls++;
				if (calls === 2) throw new Error('vault unreachable');
				return Promise.resolve(token(calls));
			},
			retryDelayMs: 5,
			createSocket: () => {
				const s = new FakeSocket();
				sockets.push(s);
				return s;
			},
		});
		p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
		await startWithCredential(p, sockets);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom'); // reconnect: its credential throws
		await tick(30);
		expect(calls).toBe(3);
		expect(sockets).toHaveLength(2);
		p.feedAudio(chunk);
		sockets[1].openAndSetup();
		expect(sockets[1].audioCount()).toBe(1);
		await p.stop();
	});

	it('rejects start(), without onFatal, when the credential provider throws a permanent error synchronously', async () => {
		const fatal: Error[] = [];
		const p = new GeminiLiveTranscribeSTTProvider({
			credentialProvider: () => {
				throw Object.assign(new Error('no key for this owner'), { retryable: false });
			},
			onFatal: (e) => fatal.push(e),
			createSocket: () => {
				throw new Error('never dialed');
			},
		});
		const err = (await p.start().catch((e: unknown) => e)) as ConnectFailureError;
		expect(err.connectFailure).toMatchObject({ source: 'provider', retryable: false });
		expect(fatal).toHaveLength(0);
	});

	it('reports each connection’s dial, setup-ok and close with its credential meta', async () => {
		const { p, sockets, events } = makeTokenProvider((n) => token(n));
		await startWithCredential(p, sockets);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1000, 'bye');
		expect(events).toEqual([
			{ phase: 'dial', connectionId: 1, meta: { id: 'c1' } },
			{ phase: 'setup-ok', connectionId: 1, meta: { id: 'c1' } },
			{
				phase: 'closed',
				connectionId: 1,
				meta: { id: 'c1' },
				setupDone: true,
				code: 1000,
				reason: 'bye',
			},
		]);
		await tick();
		expect(events.at(-1)).toEqual({ phase: 'dial', connectionId: 2, meta: { id: 'c2' } });
		await p.stop();
	});

	it('promotes a replacement still fetching its credential when the active socket drops, minting none beside it', async () => {
		let resolveReplacement: (c: GeminiCredential) => void = () => {};
		const { p, sockets, calls, events } = makeTokenProvider(
			(n) =>
				n === 2
					? new Promise<GeminiCredential>((resolve) => {
							resolveReplacement = resolve;
						})
					: token(n),
			{ rotateAfterMs: 20 },
		);
		await startWithCredential(p, sockets);
		await tick(30); // rotation: the replacement's credential is in flight
		expect(calls).toHaveLength(2);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom');
		await tick(30);
		expect(calls).toHaveLength(2); // no reconnect beside the replacement
		expect(calls[1].signal.aborted).toBe(false);
		p.feedAudio(chunk); // buffered for the replacement
		resolveReplacement(token(2));
		await tick();
		expect(sockets).toHaveLength(2);
		sockets[1].openAndSetup();
		expect(sockets[1].audioCount()).toBe(1); // it is the fed socket, not an unused session
		expect(events.filter((e) => e.phase === 'dial').map((e) => e.meta)).toEqual([
			{ id: 'c1' },
			{ id: 'c2' },
		]);
		await p.stop();
	});

	it('disarms a connection’s credential expiry when its socket closes, leaving no timer after stop()', async () => {
		vi.useFakeTimers();
		const { p, sockets } = makeTokenProvider(
			(n) => token(n, { expiresAtMs: Date.now() + 30 * 86_400_000 }),
			{ rotateAfterMs: 600_000 },
		);
		const started = p.start();
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].openAndSetup();
		await started;
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom'); // reconnect
		await vi.advanceTimersByTimeAsync(0);
		sockets[1].openAndSetup();
		const stopped = p.stop();
		await vi.advanceTimersByTimeAsync(1_000);
		await stopped;
		expect(vi.getTimerCount()).toBe(0);
	});

	it('ignores a setupComplete that arrives after its connection timed out', async () => {
		const events: GeminiLiveTranscribeLifecycleEvent[] = [];
		const { p, sockets } = makeProvider({
			connectTimeoutMs: 20,
			retryDelayMs: 50,
			onConnectionLifecycle: (e) => events.push(e),
		});
		await startReady(p, () => sockets[0]);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom'); // reconnect on sockets[1]
		await tick(30); // sockets[1] timed out; its retry is due in 50 ms
		sockets[1].openAndSetup(); // too late
		expect(events.filter((e) => e.phase === 'setup-ok').map((e) => e.connectionId)).toEqual([1]);
		await p.stop();
	});
});

describe('GeminiLiveTranscribeSTTProvider giving up', () => {
	it('calls onFatal once a lost session cannot be reopened within maxRetries, and stops', async () => {
		const fatal: Error[] = [];
		const { p, sockets } = makeProvider({ maxRetries: 2, onFatal: (e) => fatal.push(e) });
		await startReady(p, () => sockets[0]);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom'); // reconnect
		sockets[1].emit('close', 1006, ''); // retry 1 after 5 ms
		await tick(15);
		sockets[2].emit('close', 1006, ''); // retry 2 after 10 ms
		await tick(20);
		expect(fatal).toHaveLength(0);
		sockets[3].emit('close', 1006, ''); // budget spent
		expect(fatal).toHaveLength(1);
		expect(fatal[0].message).toMatch(/closed before setup \(1006\)/);
		expect((fatal[0] as ConnectFailureError).connectFailure).toMatchObject({
			source: 'dial',
			code: 1006,
		});
		expect(sockets).toHaveLength(4);
		// The run is over: start() opens a new session.
		const again = p.start();
		expect(sockets).toHaveLength(5);
		sockets[4].openAndSetup();
		await again;
		await p.stop();
	});

	it('counts a socket that errors and then closes as one failed attempt', async () => {
		const fatal: Error[] = [];
		const { p, sockets } = makeProvider({ maxRetries: 2, onFatal: (e) => fatal.push(e) });
		await startReady(p, () => sockets[0]);
		sockets[0].readyState = 3;
		sockets[0].emit('close', 1011, 'boom');
		const refuse = (s: FakeSocket) => {
			s.emit('error', new Error('Unexpected server response: 503'));
			s.emit('close', 1006, '');
		};
		refuse(sockets[1]);
		await tick(15);
		refuse(sockets[2]);
		await tick(20);
		expect(sockets).toHaveLength(4); // two retries, not one
		expect(fatal).toHaveLength(0);
		refuse(sockets[3]);
		expect(fatal).toHaveLength(1);
		expect((fatal[0] as ConnectFailureError).connectFailure).toMatchObject({
			source: 'dial',
			status: 503,
		});
	});
});
