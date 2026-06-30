import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearPendingPlaybackEnded,
	maybeSchedulePlaybackEnded,
	teardownPlayback,
} from '../../app/web-client/src/audio.js';
import { state } from '../../app/web-client/src/state.js';

/**
 * Web-client playback-state primitives (design-playback-state-protocol.md,
 * execution-plan steps 15–17). The settle delay falls back to 250 ms whenever
 * the AudioContext latency fields are unavailable, which is the case here since
 * `state.audioCtx` is null in the test environment.
 */
const SETTLE_MS = 250;

function fakeSource(): AudioBufferSourceNode {
	return { stop: vi.fn() } as unknown as AudioBufferSourceNode;
}

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
	return { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket & {
		send: ReturnType<typeof vi.fn>;
	};
}

describe('web-client playback-state protocol', () => {
	let ws: WebSocket & { send: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.useFakeTimers();
		ws = mockWs();
		state.audioDonePlaybackId = null;
		state.playbackEndedTimer = null;
		state.connectionGeneration = 0;
		state.activeSources = [];
		state.nextPlayTime = 0;
		state.audioCtx = null;
		state.clientAudioSource = 'websocket_pcm';
		state.useSpatialWebAvatar = false;
		state.ws = ws;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('emits playback.ended after the settle delay once a turn is marked done', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		expect(state.playbackEndedTimer).not.toBeNull();

		vi.advanceTimersByTime(SETTLE_MS - 1);
		expect(ws.send).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(ws.send).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ type: 'playback.ended', playbackId: 7 }),
		);
		expect(state.audioDonePlaybackId).toBeNull();
		expect(state.playbackEndedTimer).toBeNull();
	});

	it('does not schedule before an audio.done has been received', () => {
		maybeSchedulePlaybackEnded();
		expect(state.playbackEndedTimer).toBeNull();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('does not schedule while assistant audio is still playing', () => {
		state.audioDonePlaybackId = 7;
		state.activeSources = [fakeSource()];
		maybeSchedulePlaybackEnded();
		expect(state.playbackEndedTimer).toBeNull();
	});

	it('does not double-schedule when a timer is already pending', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		const first = state.playbackEndedTimer;
		maybeSchedulePlaybackEnded();
		expect(state.playbackEndedTimer).toBe(first);
	});

	it('suppresses the emit when audio resumes mid-settle, then reschedules on drain', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();

		vi.advanceTimersByTime(100);
		state.activeSources = [fakeSource()]; // audio resumed during the wait
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
		expect(state.audioDonePlaybackId).toBe(7); // id kept for a later drain
		expect(state.playbackEndedTimer).toBeNull();

		state.activeSources = []; // buffer drains again
		maybeSchedulePlaybackEnded();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ type: 'playback.ended', playbackId: 7 }),
		);
	});

	it('drops a stale signal when the connection generation changed', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		state.connectionGeneration = 1; // a reconnect happened
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
		expect(state.audioDonePlaybackId).toBeNull();
	});

	it('drops a stale signal when the socket was replaced', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		state.ws = mockWs(); // a new socket took over
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
		expect(state.audioDonePlaybackId).toBeNull();
	});

	it('does not schedule for a non-playChunk render path (multi-sink gate)', () => {
		state.clientAudioSource = 'rtc_opus';
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		expect(state.playbackEndedTimer).toBeNull();
	});

	it('does not schedule while an avatar sink absorbs assistant PCM', async () => {
		const { setSpatialWebAvatarSink } = await import(
			'../../app/web-client/src/spatial-web-avatar/sink.js'
		);
		setSpatialWebAvatarSink({
			onAssistantPcm: () => {},
			onTurnEnd: () => {},
			onTurnInterrupted: () => {},
			onKeyframes: () => {},
		});
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		expect(state.playbackEndedTimer).toBeNull();
		setSpatialWebAvatarSink(null);
	});

	it('emits exactly once per turn even if scheduled again afterwards', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).toHaveBeenCalledTimes(1);

		maybeSchedulePlaybackEnded(); // id already consumed
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).toHaveBeenCalledTimes(1);
	});

	it('handles the audio.done-then-drain arrival order', () => {
		state.activeSources = [fakeSource()]; // audio still playing
		state.audioDonePlaybackId = 7; // audio.done arrives first
		maybeSchedulePlaybackEnded();
		expect(state.playbackEndedTimer).toBeNull();

		state.activeSources = []; // buffer drains afterwards
		maybeSchedulePlaybackEnded();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ type: 'playback.ended', playbackId: 7 }),
		);
	});

	it('handles the drain-then-audio.done arrival order', () => {
		state.activeSources = []; // buffer already drained
		state.audioDonePlaybackId = 9; // audio.done arrives after
		maybeSchedulePlaybackEnded();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ type: 'playback.ended', playbackId: 9 }),
		);
	});

	it('clearPendingPlaybackEnded cancels a pending emit', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		clearPendingPlaybackEnded();
		expect(state.playbackEndedTimer).toBeNull();
		expect(state.audioDonePlaybackId).toBeNull();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('teardownPlayback stops sources, resets the cursor, and cancels a pending emit', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();
		const src = fakeSource();
		state.activeSources = [src];
		state.nextPlayTime = 5;

		teardownPlayback();

		expect(src.stop).toHaveBeenCalledOnce();
		expect(state.activeSources).toHaveLength(0);
		expect(state.nextPlayTime).toBe(0);
		expect(state.playbackEndedTimer).toBeNull();
		expect(state.audioDonePlaybackId).toBeNull();

		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('a settle timer scheduled before a reconnect teardown never emits', () => {
		state.audioDonePlaybackId = 7;
		maybeSchedulePlaybackEnded();

		// connectWs() runs teardownPlayback() then bumps the generation.
		teardownPlayback();
		state.connectionGeneration += 1;

		vi.advanceTimersByTime(SETTLE_MS);
		expect(ws.send).not.toHaveBeenCalled();
	});
});
