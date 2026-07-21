import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientActionHandlers } from '../../app/web-client/src/client-action-handlers.js';
import { playbackGate } from '../../app/web-client/src/playback-gate.js';
import { SpatialAssistantAudioDrip } from '../../app/web-client/src/spatial-web-avatar/assistant-audio-drip.js';
import {
	type SpatialWebAvatarSink,
	getSpatialWebAvatarSink,
	setSpatialWebAvatarSink,
} from '../../app/web-client/src/spatial-web-avatar/sink.js';
import { state } from '../../app/web-client/src/state.js';

describe('avatar barge-in sync', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		playbackGate.clear();
	});
	afterEach(() => {
		vi.useRealTimers();
		playbackGate.clear();
		setSpatialWebAvatarSink(null);
		state.useSpatialWebAvatar = false;
		state.clientAudioSource = 'websocket_pcm';
		state.ws = null;
	});

	it('does not flush a stale drip end marker when turn.end follows turn.interrupted', () => {
		const onTurnEnd = vi.fn();
		const onTurnInterrupted = vi.fn();
		const drip = new SpatialAssistantAudioDrip(24_000, () => {});
		const sink: SpatialWebAvatarSink = {
			onAssistantPcm: (data) => drip.enqueue(data),
			onTurnEnd: () => {
				onTurnEnd();
				drip.enqueueEndMarker();
			},
			onTurnInterrupted: () => {
				onTurnInterrupted();
				drip.interrupt();
			},
			onKeyframes: () => {},
		};
		setSpatialWebAvatarSink(sink);

		clientActionHandlers['turn.interrupted']?.({});
		clientActionHandlers['turn.end']?.({});

		expect(onTurnInterrupted).toHaveBeenCalledOnce();
		expect(onTurnEnd).not.toHaveBeenCalled();

		const yielded: Array<{ bytes: number; last: boolean }> = [];
		const drip2 = new SpatialAssistantAudioDrip(24_000, (data, isLast) => {
			yielded.push({ bytes: data.byteLength, last: isLast });
		});
		drip2.enqueue(new ArrayBuffer(96_000));
		for (let i = 0; i < 20; i++) {
			vi.advanceTimersByTime(10);
		}
		expect(yielded.filter((y) => y.last)).toHaveLength(0);
	});

	it('still flushes drip end marker on a clean turn.end', () => {
		const onTurnEnd = vi.fn();
		setSpatialWebAvatarSink({
			onAssistantPcm: () => {},
			onTurnEnd,
			onTurnInterrupted: () => {},
			onKeyframes: () => {},
		});

		clientActionHandlers['turn.end']?.({});
		expect(onTurnEnd).toHaveBeenCalledOnce();
	});

	it('acks playback immediately for text-driven avatar sinks without server WS driving', () => {
		const ws = {
			readyState: WebSocket.OPEN,
			send: vi.fn(),
		} as unknown as WebSocket;
		state.ws = ws;
		state.useSpatialWebAvatar = false;
		setSpatialWebAvatarSink({
			onAssistantPcm: () => {},
			onTurnEnd: () => {},
			onTurnInterrupted: () => {},
			onKeyframes: () => {},
		});

		clientActionHandlers['audio.done']?.({ type: 'audio.done', playbackId: 11 });
		expect(ws.send).toHaveBeenCalledWith(
			JSON.stringify({ type: 'playback.ended', playbackId: 11 }),
		);
		expect(getSpatialWebAvatarSink()).not.toBeNull();
	});

	it('does not schedule playChunk playback.ended while an avatar-aware sink is active', () => {
		const ws = {
			readyState: WebSocket.OPEN,
			send: vi.fn(),
		} as unknown as WebSocket;
		state.ws = ws;
		// Avatar-aware server (useSpatialWebAvatar) — no client ack at all;
		// the renderer decision is 'ignore' and the server uses its fallback.
		state.useSpatialWebAvatar = true;
		setSpatialWebAvatarSink({
			onAssistantPcm: () => {},
			onTurnEnd: () => {},
			onTurnInterrupted: () => {},
			onKeyframes: () => {},
		});

		clientActionHandlers['audio.done']?.({ type: 'audio.done', playbackId: 3 });
		vi.advanceTimersByTime(500);
		expect(ws.send).not.toHaveBeenCalled();
	});

	it('clears pending playback.ended on turn.interrupted before avatar sink cleanup', () => {
		const ws = {
			readyState: WebSocket.OPEN,
			send: vi.fn(),
		} as unknown as WebSocket;
		state.ws = ws;
		const onTurnInterrupted = vi.fn();
		// No sink while audio.done arrives (defer path schedules), then the
		// sink handles the barge-in — the gate must be cleared before the
		// settle timer can fire a stale ack.
		clientActionHandlers['audio.done']?.({ type: 'audio.done', playbackId: 5 });
		setSpatialWebAvatarSink({
			onAssistantPcm: () => {},
			onTurnEnd: () => {},
			onTurnInterrupted,
			onKeyframes: () => {},
		});
		clientActionHandlers['turn.interrupted']?.({});
		vi.advanceTimersByTime(500);

		expect(ws.send).not.toHaveBeenCalled();
		expect(onTurnInterrupted).toHaveBeenCalledOnce();
	});
});
