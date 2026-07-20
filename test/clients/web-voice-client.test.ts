import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PcmAudio,
	type PlaybackRenderer,
	type TranscriptEvent,
	VoiceClient,
	type VoiceStatus,
} from '../../clients/web-voice/src/index.js';

// Unit tests for the shared VoiceClient (plan steps B2–B4): typed dispatch,
// key-aware pacing, the renderer capability matrix, the audio.done →
// playback.ended handshake ordering, and connection-generation guards.
// handleJson is exercised directly; sends go through a fake socket.

const OPEN = 1;

function fakeWs() {
	return {
		readyState: OPEN,
		sent: [] as string[],
		send(data: string) {
			this.sent.push(data);
		},
		close() {
			this.readyState = 3;
		},
	};
}

function fakeRenderer(overrides: Partial<PlaybackRenderer> = {}): PlaybackRenderer & {
	drained: (() => void) | null;
	interrupted: number;
} {
	const r = {
		rendersAssistantPcm: true,
		canSignalPlaybackEnded: true,
		playing: false,
		drained: null as (() => void) | null,
		interrupted: 0,
		playChunk: () => {},
		audioDoneDecision: () => 'defer' as const,
		setOnAllPlaybackDrained(cb: (() => void) | null) {
			r.drained = cb;
		},
		settleDelayMs: () => 10,
		interrupt() {
			r.interrupted += 1;
		},
	};
	return Object.assign(r, overrides);
}

function makeClient(opts?: {
	renderer?: PlaybackRenderer;
	pacingRates?: Record<string, number> | false;
}) {
	const statuses: Array<{ status: VoiceStatus; detail?: string }> = [];
	const transcripts: TranscriptEvent[] = [];
	const extensions: Array<Record<string, unknown>> = [];
	const client = new VoiceClient(
		{
			onStatus: (status, detail) => statuses.push({ status, detail }),
			onTranscript: (e) => transcripts.push(e),
			onServerMessage: (msg) => {
				extensions.push(msg as Record<string, unknown>);
				return (msg as { type?: string }).type === 'peer.session_ended'
					? 'handled'
					: 'unhandled';
			},
		},
		{
			audio: new PcmAudio(),
			renderer: opts?.renderer ? () => opts.renderer as PlaybackRenderer : undefined,
			pacingRates: opts?.pacingRates,
		},
	);
	const ws = fakeWs();
	(client as unknown as { ws: unknown }).ws = ws;
	return { client, ws, statuses, transcripts, extensions };
}

describe('VoiceClient dispatch', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('tears down audio synchronously on disconnect', () => {
		const { client } = makeClient();
		const teardown = vi.spyOn(client.audio, 'teardown');

		client.disconnect();

		expect(teardown).toHaveBeenCalledOnce();
	});

	it('does not start the microphone when a socket opens after disconnect', async () => {
		const sockets: ControlledWebSocket[] = [];
		class ControlledWebSocket {
			static readonly OPEN = OPEN;
			binaryType = '';
			readyState = 0;
			onopen: (() => Promise<void>) | null = null;
			onmessage: ((event: MessageEvent<ArrayBuffer | string>) => void) | null = null;
			onclose: ((event: CloseEvent) => void) | null = null;
			onerror: (() => void) | null = null;
			readonly close = vi.fn();
			readonly send = vi.fn();

			constructor(_url: string) {
				sockets.push(this);
			}
		}
		vi.stubGlobal('WebSocket', ControlledWebSocket);
		const audio = new PcmAudio();
		const startMic = vi.spyOn(audio, 'startMic');
		const client = new VoiceClient({ onStatus: vi.fn(), onTranscript: vi.fn() }, { audio });

		await client.connect('ws://example.test/voice');
		const socket = sockets[0];
		expect(socket).toBeDefined();
		if (!socket) throw new Error('WebSocket was not constructed');
		client.disconnect();
		const staleOpen = socket.onopen;
		await staleOpen?.();

		expect(socket.close).toHaveBeenCalledOnce();
		expect(startMic).not.toHaveBeenCalled();
	});

	it('session.config sets rates, opens the mic gate, reports live', () => {
		const { client, statuses } = makeClient();
		client.handleJson({
			type: 'session.config',
			audioFormat: { inputSampleRate: 16000, outputSampleRate: 24000 },
		});
		expect(client.audio.gateOpen).toBe(true);
		expect(client.audio.inputRate).toBe(16000);
		expect(client.audio.outputRate).toBe(24000);
		expect(statuses.at(-1)?.status).toBe('live');
	});

	it('transcript events carry partial and corrected flags', () => {
		const { client, transcripts } = makeClient();
		client.handleJson({ type: 'transcript', role: 'user', text: 'hel', partial: true });
		client.handleJson({
			type: 'transcript',
			role: 'user',
			text: 'hello',
			partial: true,
			corrected: true,
		});
		expect(transcripts[0]).toEqual({ role: 'user', text: 'hel', partial: true, corrected: false });
		expect(transcripts[1]).toEqual({
			role: 'user',
			text: 'hello',
			partial: true,
			corrected: true,
		});
	});

	it('turn.interrupted routes through the renderer', () => {
		const renderer = fakeRenderer();
		const { client } = makeClient({ renderer });
		client.handleJson({ type: 'turn.interrupted' });
		expect(renderer.interrupted).toBe(1);
	});

	it('extension frames reach onServerMessage; unknown frames are ignored', () => {
		const { client, extensions } = makeClient();
		client.handleJson({ type: 'peer.session_ended', reason: 'timeout' });
		client.handleJson({ type: 'future.unknown_frame', anything: 1 });
		expect(extensions.map((m) => m.type)).toEqual([
			'peer.session_ended',
			'future.unknown_frame',
		]);
	});
});

describe('key-aware pacing (B5 client half)', () => {
	it('catalog with pacing=slow and verbosity=normal applies 0.85, not 1.0', () => {
		const { client } = makeClient();
		client.handleJson({
			type: 'behavior.catalog',
			categories: [
				{ key: 'pacing', toolName: 'set_speech_speed', presets: [], active: 'slow' },
				{ key: 'verbosity', toolName: 'set_verbosity', presets: [], active: 'normal' },
			],
		});
		expect(client.audio.playbackRate).toBe(0.85);
	});

	it('behavior.changed for a non-pacing key never touches the rate', () => {
		const { client } = makeClient();
		client.handleJson({ type: 'behavior.changed', key: 'pacing', preset: 'fast' });
		expect(client.audio.playbackRate).toBe(1.2);
		client.handleJson({ type: 'behavior.changed', key: 'verbosity', preset: 'normal' });
		expect(client.audio.playbackRate).toBe(1.2);
	});

	it('pacingRates: false disables pacing handling', () => {
		const { client } = makeClient({ pacingRates: false });
		client.handleJson({ type: 'behavior.changed', key: 'pacing', preset: 'fast' });
		expect(client.audio.playbackRate).toBe(1.0);
	});
});

describe('playback-state handshake × renderer capability matrix (B4)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('defer: acknowledges after drain + settle, echoing the playbackId', () => {
		const renderer = fakeRenderer();
		const { client, ws } = makeClient({ renderer });
		client.handleJson({ type: 'audio.done', playbackId: 7 });
		vi.advanceTimersByTime(50);
		expect(ws.sent).toHaveLength(1);
		expect(JSON.parse(ws.sent[0])).toEqual({ type: 'playback.ended', playbackId: 7 });
	});

	it('defer: waits for drain when audio is still playing', () => {
		const renderer = fakeRenderer({ playing: true });
		const { client, ws } = makeClient({ renderer });
		client.handleJson({ type: 'audio.done', playbackId: 8 });
		vi.advanceTimersByTime(50);
		expect(ws.sent).toHaveLength(0);
		// Drain arrives → schedule → settle → ack.
		(renderer as unknown as { playing: boolean }).playing = false;
		renderer.drained?.();
		vi.advanceTimersByTime(50);
		expect(JSON.parse(ws.sent[0])).toEqual({ type: 'playback.ended', playbackId: 8 });
	});

	it('ack-now: acknowledges immediately (avatar immediate-ack case)', () => {
		const renderer = fakeRenderer({ audioDoneDecision: () => 'ack-now' as const });
		const { client, ws } = makeClient({ renderer });
		client.handleJson({ type: 'audio.done', playbackId: 9 });
		expect(JSON.parse(ws.sent[0])).toEqual({ type: 'playback.ended', playbackId: 9 });
	});

	it('ignore / no-protocol renderers never acknowledge (server falls back)', () => {
		for (const renderer of [
			fakeRenderer({ audioDoneDecision: () => 'ignore' as const }),
			fakeRenderer({ canSignalPlaybackEnded: false }),
		]) {
			const { client, ws } = makeClient({ renderer });
			client.handleJson({ type: 'audio.done', playbackId: 10 });
			vi.advanceTimersByTime(100);
			expect(ws.sent).toHaveLength(0);
		}
	});

	it('turn.end clears a pending acknowledgment (fallback bookkeeping)', () => {
		const renderer = fakeRenderer({ playing: true });
		const { client, ws } = makeClient({ renderer });
		client.handleJson({ type: 'audio.done', playbackId: 11 });
		client.handleJson({ type: 'turn.end' });
		(renderer as unknown as { playing: boolean }).playing = false;
		renderer.drained?.();
		vi.advanceTimersByTime(100);
		expect(ws.sent).toHaveLength(0);
	});

	it('a stale settle timer from a previous connection generation is a no-op', () => {
		const renderer = fakeRenderer();
		const { client, ws } = makeClient({ renderer });
		client.handleJson({ type: 'audio.done', playbackId: 12 });
		// New connection generation begins before the settle timer fires (the
		// gate owns the handshake generation — see playback-ended-gate.ts).
		(client as unknown as { gate: { generation: number } }).gate.generation += 1;
		vi.advanceTimersByTime(100);
		expect(ws.sent).toHaveLength(0);
	});
});
