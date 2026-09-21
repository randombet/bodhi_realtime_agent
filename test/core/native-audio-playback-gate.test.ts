import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeAudioPlaybackGate, type NativeGateDeps } from '../../src/core/playback-gate.js';
import type { Turn } from '../../src/core/turn.js';

const TURN = { id: 'turn_1' } as unknown as Turn;

function makeGate(over: Partial<NativeGateDeps> = {}) {
	let now = 1000;
	const onComplete = vi.fn();
	const requestInterrupt = vi.fn(() => true);
	const cancelResponse = vi.fn();
	const deps: NativeGateDeps = {
		audioFormat: {
			inputSampleRate: 24000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		},
		frameworkOwnsInterrupt: true,
		fallbackMarginMs: 1500,
		minPlaybackRate: 0.85,
		cancelResponse,
		requestInterrupt,
		getCurrentTurn: () => TURN,
		onComplete,
		log: vi.fn(),
		clock: () => now,
		...over,
	};
	const gate = new NativeAudioPlaybackGate(deps);
	return {
		gate,
		onComplete,
		requestInterrupt,
		cancelResponse,
		setNow: (n: number) => {
			now = n;
		},
	};
}

describe('NativeAudioPlaybackGate — correlation + arm/clear', () => {
	beforeEach(() => vi.useFakeTimers());

	it('bumps the id on the first audio chunk of a turn and advances the estimate', () => {
		const { gate } = makeGate();
		expect(gate.id).toBe(0);
		expect(gate.hasAudio).toBe(false);
		gate.noteAudioChunk(48000); // 1 s @ 24 kHz·2 B
		expect(gate.id).toBe(1); // first chunk bumps
		expect(gate.hasAudio).toBe(true);
		gate.noteAudioChunk(48000); // second chunk does not bump again
		expect(gate.id).toBe(1);
	});

	it('arm() returns the playbackId, marks pending + timerArmed', () => {
		const { gate } = makeGate();
		gate.noteAudioChunk(48000);
		const onFallback = vi.fn();
		const armedId = gate.arm(TURN, onFallback);
		expect(armedId).toBe(1);
		expect(gate.pending).toBe(true);
		expect(gate.timerArmed).toBe(true);
		expect(gate.capturedTurn).toBe(TURN);
	});

	it('clear() bumps the id so a late fallback after teardown is a no-op', () => {
		const { gate } = makeGate();
		gate.noteAudioChunk(48000);
		const onFallback = vi.fn();
		gate.arm(TURN, onFallback);
		gate.clear(); // teardown bumps id (1 → 2), clears pending/timer
		expect(gate.pending).toBe(false);
		expect(gate.timerArmed).toBe(false);
		expect(gate.id).toBe(2);
		// The pre-teardown fallback can no longer fire (timer cleared); even if it
		// did, the id guard would reject it.
		vi.advanceTimersByTime(10000);
		expect(onFallback).not.toHaveBeenCalled();
	});

	it('the fallback fires (id-guarded) when the turn was not torn down', () => {
		const { gate } = makeGate();
		gate.noteAudioChunk(48000);
		const onFallback = vi.fn();
		gate.arm(TURN, onFallback);
		vi.advanceTimersByTime(10000);
		expect(onFallback).toHaveBeenCalledTimes(1);
	});
});

describe('NativeAudioPlaybackGate — barge-in', () => {
	function transportStub() {
		return { onSpeechStarted: undefined as undefined | (() => void), cancelResponse: vi.fn() };
	}

	it('framework-owned tail: a pending gate cancels + finalizes the captured turn', () => {
		const { gate, onComplete, cancelResponse } = makeGate();
		const t = transportStub();
		gate.installBargeIn(t as never);
		gate.noteAudioChunk(48000);
		gate.arm(TURN, vi.fn()); // pending
		t.onSpeechStarted?.();
		expect(cancelResponse).toHaveBeenCalledWith({});
		expect(onComplete).toHaveBeenCalledWith(TURN, { interrupted: true });
	});

	it('framework-owned generation: no pending gate truncates generated audio', () => {
		const { gate, onComplete, cancelResponse } = makeGate();
		const t = transportStub();
		gate.installBargeIn(t as never);
		// not armed → generation mode
		t.onSpeechStarted?.();
		expect(cancelResponse).toHaveBeenCalledWith({ truncate: 'generated' });
		expect(onComplete).toHaveBeenCalledWith(TURN, { interrupted: true });
	});

	it('a denied grace window suppresses the interrupt', () => {
		const { gate, onComplete, cancelResponse } = makeGate({ requestInterrupt: () => false });
		const t = transportStub();
		gate.installBargeIn(t as never);
		t.onSpeechStarted?.();
		expect(cancelResponse).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});
});
