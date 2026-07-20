import type { PcmAudio } from '@bodhi/web-voice-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPendingPlaybackEnded, teardownPlayback } from '../../app/web-client/src/audio.js';
import { clientActionHandlers } from '../../app/web-client/src/client-action-handlers.js';
import { playbackGate } from '../../app/web-client/src/playback-gate.js';
import { state } from '../../app/web-client/src/state.js';

/**
 * Web-client playback-state protocol (design-playback-state-protocol.md),
 * post-D3: the handshake mechanics live in the shared PlaybackEndedGate
 * (unit-tested in test/clients/); these tests cover the APP wiring — the
 * `audio.done` handler → gate → typed send facade path, and the
 * AppPlaybackRenderer's capability decisions over live app state.
 * The settle delay falls back to 250 ms (no AudioContext in this env).
 */
const SETTLE_MS = 250;

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
	return { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket & {
		send: ReturnType<typeof vi.fn>;
	};
}

/** Controllable stand-in for the shared audio engine. */
function fakePcm(): PcmAudio & { playing: boolean; flushed: number } {
	const fake = {
		playing: false,
		flushed: 0,
		settleDelayMs: () => SETTLE_MS,
		muteAndFlush() {
			fake.flushed += 1;
		},
		unmute() {},
		onAllSourcesEnded: null as (() => void) | null,
		gateOpen: false,
		inputRate: 16000,
		outputRate: 24000,
	};
	return fake as unknown as PcmAudio & { playing: boolean; flushed: number };
}

describe('web-client playback-state protocol (app wiring)', () => {
	let ws: ReturnType<typeof mockWs>;
	let pcm: ReturnType<typeof fakePcm>;
	let realPcm: PcmAudio;

	beforeEach(() => {
		vi.useFakeTimers();
		ws = mockWs();
		pcm = fakePcm();
		realPcm = state.pcm;
		state.pcm = pcm;
		state.ws = ws as unknown as WebSocket;
		state.clientAudioSource = 'websocket_pcm';
		state.useSpatialWebAvatar = false;
		playbackGate.clear();
	});

	afterEach(() => {
		playbackGate.clear();
		state.pcm = realPcm;
		state.ws = null;
		vi.useRealTimers();
	});

	function audioDone(playbackId: number): void {
		clientActionHandlers['audio.done']?.({ type: 'audio.done', playbackId });
	}

	it('emits playback.ended after the settle delay once a turn is marked done', () => {
		audioDone(7);
		vi.advanceTimersByTime(SETTLE_MS - 1);
		expect(ws.send).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(ws.send).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ type: 'playback.ended', playbackId: 7 }),
		);
	});

	it('emits exactly once per consumed audio.done', () => {
		audioDone(7);
		vi.advanceTimersByTime(SETTLE_MS);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).toHaveBeenCalledTimes(1);
	});

	it('defers while assistant audio is still playing (audio.done-then-drain order)', () => {
		pcm.playing = true;
		audioDone(7);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('handles the drain-then-audio.done arrival order', () => {
		pcm.playing = false; // buffer already drained
		audioDone(9);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ type: 'playback.ended', playbackId: 9 }),
		);
	});

	it('does not emit for the rtc_opus render path', () => {
		state.clientAudioSource = 'rtc_opus';
		audioDone(7);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('a stale settle timer from a previous connection generation never emits', () => {
		audioDone(7);
		playbackGate.newGeneration(); // connectWs() ran — reconnect
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('clearPendingPlaybackEnded cancels a pending emit', () => {
		audioDone(7);
		clearPendingPlaybackEnded();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('teardownPlayback flushes scheduled audio and cancels a pending emit', () => {
		audioDone(7);
		teardownPlayback();
		expect(pcm.flushed).toBeGreaterThan(0);
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});
});
