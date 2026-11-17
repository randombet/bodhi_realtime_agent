import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRouter } from '../../src/core/audio-router.js';
import { VAD_FRAME } from '../../src/core/client-vad-detector.js';
import type { ClientVadDetector } from '../../src/core/client-vad-detector.js';
import { ValidationError } from '../../src/core/errors.js';
import {
	DEFAULT_KEEPALIVE_INTERVAL_MS,
	GeminiLiveTransport,
	KEEPALIVE_SILENCE_MS,
	silenceFrameBase64,
} from '../../src/transport/gemini-live-transport.js';
import type { STTProvider } from '../../src/types/transport.js';

/** Measured against gemini-3.8-live: an idle session closes 1008 at +120 s. */
const INACTIVITY_CLOSE_MS = 120_000;
const INACTIVITY_REASON = 'Session closed due to client inactivity.';

type LiveCallbacks = {
	onopen?: () => void;
	onmessage?: (msg: unknown) => void;
	onclose?: (e: { code?: number; reason?: string }) => void;
};

/** A Live socket that, like the server, closes 1008 after 120 s with no client input. */
class FakeLiveSocket {
	readonly audio: Array<{ data: string; mimeType: string }> = [];
	closed: { code: number; reason: string } | null = null;
	private idle: ReturnType<typeof setTimeout> | undefined;

	readonly sendRealtimeInput = vi.fn((input: { audio?: { data: string; mimeType: string } }) => {
		if (this.closed) return;
		if (input.audio) this.audio.push(input.audio);
		this.armIdle();
	});
	readonly sendClientContent = vi.fn();
	readonly sendToolResponse = vi.fn();
	readonly close = vi.fn(() => this.fireClose(1000, 'client close'));

	constructor(private readonly cbs: LiveCallbacks) {
		this.armIdle();
	}

	fireClose(code: number, reason: string): void {
		if (this.closed) return;
		this.closed = { code, reason };
		clearTimeout(this.idle);
		this.cbs.onclose?.({ code, reason });
	}

	private armIdle(): void {
		clearTimeout(this.idle);
		this.idle = setTimeout(() => this.fireClose(1008, INACTIVITY_REASON), INACTIVITY_CLOSE_MS);
	}
}

/** How the next dial behaves: setupComplete after `setupDelayMs`, or never resolves. */
type DialPlan = { kind: 'ok'; setupDelayMs: number } | { kind: 'hang' };
const sockets: FakeLiveSocket[] = [];
let dialPlans: DialPlan[] = [];

vi.mock('@google/genai', () => ({
	GoogleGenAI: vi.fn().mockImplementation(() => ({
		live: {
			connect: vi.fn(async (params: { callbacks: LiveCallbacks }) => {
				const plan = dialPlans.shift() ?? { kind: 'ok', setupDelayMs: 1 };
				if (plan.kind === 'hang') return new Promise(() => {});
				const cbs = params.callbacks;
				const socket = new FakeLiveSocket(cbs);
				sockets.push(socket);
				cbs.onopen?.();
				setTimeout(
					() => cbs.onmessage?.({ setupComplete: { sessionId: 'sid' } }),
					plan.setupDelayMs,
				);
				return socket;
			}),
		},
	})),
}));

const SILENCE = silenceFrameBase64(
	{ inputSampleRate: 16000, outputSampleRate: 24000, channels: 1, bitDepth: 16, encoding: 'pcm' },
	KEEPALIVE_SILENCE_MS,
);
const isSilence = (a: { data: string }) => a.data === SILENCE;
/** 20 ms of non-silent PCM16 at 16 kHz. */
const VOICE_FRAME = Buffer.alloc(640, 0x11);

async function connected(
	opts: { keepaliveIntervalMs?: number; connectTimeoutMs?: number } = {},
): Promise<{ transport: GeminiLiveTransport; socket: FakeLiveSocket; closes: number[] }> {
	const transport = new GeminiLiveTransport({ apiKey: 'test-key', ...opts }, {});
	const closes: number[] = [];
	transport.onClose = (code) => {
		if (code !== undefined) closes.push(code);
	};
	const connecting = transport.connect();
	await vi.advanceTimersByTimeAsync(1); // setupComplete
	await connecting;
	const socket = sockets[sockets.length - 1];
	if (!socket) throw new Error('no socket');
	return { transport, socket, closes };
}

describe('GeminiLiveTransport idle keepalive', () => {
	beforeEach(() => {
		sockets.length = 0;
		dialPlans = [];
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('silence frames are 100 ms of PCM16 zeros, or μ-law 0xFF for pcmu', () => {
		const pcm = Buffer.from(SILENCE, 'base64');
		expect(pcm.length).toBe(3200); // 1600 samples × 2 bytes
		expect(pcm.every((b) => b === 0)).toBe(true);
		const mulaw = Buffer.from(
			silenceFrameBase64(
				{
					inputSampleRate: 8000,
					outputSampleRate: 8000,
					channels: 1,
					bitDepth: 8,
					encoding: 'pcmu',
				},
				100,
			),
			'base64',
		);
		expect(mulaw.length).toBe(800);
		expect(mulaw.every((b) => b === 0xff)).toBe(true);
	});

	it('an idle connection gets 100 ms of silence every 20 s and stays open past 120 s', async () => {
		expect(DEFAULT_KEEPALIVE_INTERVAL_MS).toBe(20_000);
		const { socket, closes } = await connected();

		await vi.advanceTimersByTimeAsync(19_999);
		expect(socket.audio).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(socket.audio).toEqual([{ data: SILENCE, mimeType: 'audio/pcm;rate=16000' }]);

		await vi.advanceTimersByTimeAsync(180_000); // +200 s since setup
		expect(socket.audio).toHaveLength(10);
		expect(socket.audio.every(isSilence)).toBe(true);
		expect(socket.closed).toBeNull();
		expect(closes).toEqual([]);
	});

	it('a connection fed audio gets no silence', async () => {
		const { transport, socket } = await connected();
		const chunk = VOICE_FRAME.toString('base64');
		for (let t = 0; t < 200_000; t += 100) {
			transport.sendAudio(chunk);
			await vi.advanceTimersByTimeAsync(100);
		}
		expect(socket.audio).toHaveLength(2000);
		expect(socket.audio.some(isSilence)).toBe(false);
	});

	it('every sendAudio resets the clock: the first silence comes 20 s after the last audio', async () => {
		const { transport, socket } = await connected();
		await vi.advanceTimersByTimeAsync(15_000);
		transport.sendAudio(VOICE_FRAME.toString('base64'));
		await vi.advanceTimersByTimeAsync(19_999);
		expect(socket.audio.filter(isSilence)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(socket.audio.filter(isSilence)).toHaveLength(1);
	});

	it('an audio sendFile resets the clock too', async () => {
		const { transport, socket } = await connected();
		await vi.advanceTimersByTimeAsync(15_000);
		transport.sendFile(VOICE_FRAME.toString('base64'), 'audio/pcm;rate=16000');
		await vi.advanceTimersByTimeAsync(19_999);
		expect(socket.audio.filter(isSilence)).toHaveLength(0);
	});

	describe('transcription mode (mic audio routed to the transcriber only)', () => {
		function transcriptionRouter(transport: GeminiLiveTransport) {
			const fed: string[] = [];
			const whisper = { feedAudio: (b64: string) => fed.push(b64) } as unknown as STTProvider;
			const vad = {
				process: () => VAD_FRAME.NONE,
				takeTerminal: () => null,
				activeSegmentId: null,
			} as unknown as ClientVadDetector;
			const router = new AudioRouter({
				transport,
				vad,
				clientAudioInputRate: 16000,
				getSttProvider: () => undefined,
				getWhisperProvider: () => whisper,
				isSessionActive: () => true,
				isRtcAudioReady: () => false,
				getMode: () => 'transcription',
				shouldDropOutbound: () => false,
				routeExternalAudio: () => false,
			});
			return { router, fed };
		}

		async function dictate(router: AudioRouter, ms: number): Promise<void> {
			for (let t = 0; t < ms; t += 100) {
				router.handleFromClient(VOICE_FRAME);
				await vi.advanceTimersByTimeAsync(100);
			}
		}

		it('control: without the keepalive the Live socket closes 1008 at 120 s while the user dictates', async () => {
			const { transport, socket, closes } = await connected({ keepaliveIntervalMs: 0 });
			const { router, fed } = transcriptionRouter(transport);
			await dictate(router, 119_900);
			expect(socket.closed).toBeNull();
			await dictate(router, 100);
			expect(socket.closed).toEqual({ code: 1008, reason: INACTIVITY_REASON });
			expect(closes).toEqual([1008]);
			expect(socket.audio).toHaveLength(0);
			expect(fed.length).toBeGreaterThan(0);
		});

		it('with the keepalive the Live socket stays open for 200 s of dictation', async () => {
			const { transport, socket, closes } = await connected();
			const { router, fed } = transcriptionRouter(transport);
			await dictate(router, 200_000);
			expect(socket.closed).toBeNull();
			expect(closes).toEqual([]);
			// The model gets only sparse silence; the transcriber gets every frame and no silence.
			expect(socket.audio).toHaveLength(10);
			expect(socket.audio.every(isSilence)).toBe(true);
			expect(fed).toHaveLength(2000);
			expect(fed.every((b64) => Buffer.from(b64, 'base64').some((b) => b !== 0))).toBe(true);
		});
	});

	it('sends nothing while a reconnect dial is pending or before its setupComplete', async () => {
		const { transport, socket } = await connected({ connectTimeoutMs: 300_000 });
		await vi.advanceTimersByTimeAsync(20_000);
		expect(socket.audio).toHaveLength(1);

		dialPlans = [{ kind: 'ok', setupDelayMs: 90_000 }];
		const reconnecting = transport.reconnect();
		await vi.advanceTimersByTimeAsync(89_000);
		expect(sockets).toHaveLength(2);
		const next = sockets[1] as FakeLiveSocket;
		expect(socket.audio).toHaveLength(1); // detached: nothing more on the old socket
		expect(next.sendRealtimeInput).not.toHaveBeenCalled(); // set up yet? no
		await vi.advanceTimersByTimeAsync(1_000);
		await reconnecting;

		await vi.advanceTimersByTimeAsync(19_999);
		expect(next.audio).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(next.audio).toEqual([{ data: SILENCE, mimeType: 'audio/pcm;rate=16000' }]);
	});

	it('sends nothing while a dial hangs', async () => {
		const { transport, socket } = await connected({ connectTimeoutMs: 300_000 });
		dialPlans = [{ kind: 'hang' }];
		void transport.reconnect().catch(() => {});
		await vi.advanceTimersByTimeAsync(200_000);
		expect(socket.sendRealtimeInput).not.toHaveBeenCalled();
		expect(sockets).toHaveLength(1);
		expect(transport.isConnected).toBe(false);
	});

	it('stops after disconnect(), leaving no timer behind', async () => {
		const { transport, socket } = await connected();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(socket.audio).toHaveLength(1);
		await transport.disconnect();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(200_000);
		expect(socket.sendRealtimeInput).toHaveBeenCalledTimes(1);
	});

	it('disconnect() stops it at once, before the socket reports its close', async () => {
		const { transport, socket } = await connected();
		socket.close.mockImplementation(() => {}); // onclose never arrives
		await transport.disconnect();
		expect((transport as unknown as { keepalive: unknown }).keepalive).toBeNull();
		await vi.advanceTimersByTimeAsync(100_000);
		expect(socket.sendRealtimeInput).not.toHaveBeenCalled();
	});

	it('stops when the server closes the socket', async () => {
		const { socket, closes } = await connected();
		await vi.advanceTimersByTimeAsync(20_000);
		socket.fireClose(1011, 'internal error');
		expect(closes).toEqual([1011]);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(200_000);
		expect(socket.sendRealtimeInput).toHaveBeenCalledTimes(1);
	});

	it('keepaliveIntervalMs: 0 disables it', async () => {
		const { socket } = await connected({ keepaliveIntervalMs: 0 });
		await vi.advanceTimersByTimeAsync(119_000);
		expect(socket.sendRealtimeInput).not.toHaveBeenCalled();
	});

	it('honors a custom interval', async () => {
		const { socket } = await connected({ keepaliveIntervalMs: 5_000 });
		await vi.advanceTimersByTimeAsync(20_000);
		expect(socket.audio).toHaveLength(4);
	});

	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects keepaliveIntervalMs %s',
		(keepaliveIntervalMs) => {
			expect(
				() => new GeminiLiveTransport({ apiKey: 'test-key', keepaliveIntervalMs }, {}),
			).toThrow(ValidationError);
		},
	);

	it('its timer does not hold the process open', async () => {
		vi.useRealTimers();
		const transport = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
		await transport.connect();
		const pending = (transport as unknown as { keepalive: { timer: NodeJS.Timeout } | null })
			.keepalive;
		expect(pending?.timer.hasRef()).toBe(false);
		await transport.disconnect();
	});
});
