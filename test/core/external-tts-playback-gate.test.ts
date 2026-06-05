// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalTtsPlaybackGate, type TtsGateDeps } from '../../src/core/playback-gate.js';
import type { Turn } from '../../src/core/turn.js';

const TURN = { id: 'turn_1' } as unknown as Turn;

function makeGate(over: Partial<TtsGateDeps> = {}) {
	const onComplete = vi.fn();
	const deps: TtsGateDeps = {
		onComplete,
		getCurrentTurn: () => TURN,
		log: vi.fn(),
		clock: () => 1000,
		...over,
	};
	return { gate: new ExternalTtsPlaybackGate(deps), onComplete };
}

describe('ExternalTtsPlaybackGate', () => {
	beforeEach(() => vi.useFakeTimers());

	it('beginRequest bumps the id and resets per-turn counters', () => {
		const { gate } = makeGate();
		expect(gate.hasTurnText).toBe(false);
		expect(gate.currentRequestId).toBe(0);
		gate.beginRequest();
		expect(gate.hasTurnText).toBe(true);
		expect(gate.currentRequestId).toBe(1);
		gate.addTextLength(5);
		expect(gate.textLength).toBe(5);
	});

	it('noteAudio marks speaking, accumulates duration, records first-audio time', () => {
		const { gate } = makeGate();
		gate.beginRequest();
		expect(gate.isSpeaking).toBe(false);
		gate.noteAudio(100);
		gate.noteAudio(150);
		expect(gate.isSpeaking).toBe(true); // pending
		expect(gate.pending).toBe(true);
		expect(gate.totalAudioDurationMs).toBe(250);
		expect(gate.firstAudioAtMs).toBe(1000);
	});

	it('completes only when BOTH llm-text-done and audio-done are set', () => {
		const { gate, onComplete } = makeGate();
		gate.beginRequest();
		gate.markLlmTextDone();
		expect(onComplete).not.toHaveBeenCalled(); // audio not done yet
		gate.completeAudio(); // sets audioDone + speaking=false → maybeComplete fires
		expect(onComplete).toHaveBeenCalledWith(TURN, { interrupted: false });
		expect(gate.pending).toBe(false);
	});

	it('a tool-call-only turn (no text) completes on markNoTextTurnAudioDone + llm done', () => {
		const { gate, onComplete } = makeGate();
		gate.markLlmTextDone();
		gate.markNoTextTurnAudioDone();
		gate.maybeComplete();
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('the hard cap forces completion and clears the session defer flag', () => {
		const onClearDefer = vi.fn();
		const { gate, onComplete } = makeGate();
		gate.beginRequest();
		gate.markLlmTextDone();
		gate.armHardCapIfNeeded(onClearDefer);
		gate.armHardCapIfNeeded(onClearDefer); // idempotent — second arm is a no-op
		vi.advanceTimersByTime(60000);
		expect(onClearDefer).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('resetForInterrupt bumps the id (invalidating late chunks) and clears timers', () => {
		const { gate, onComplete } = makeGate();
		gate.beginRequest();
		gate.markLlmTextDone();
		gate.noteAudio(100);
		gate.armTimer(5000, vi.fn()); // playback timer
		expect(gate.timerArmed).toBe(true);
		gate.resetForInterrupt();
		expect(gate.pending).toBe(false);
		expect(gate.timerArmed).toBe(false);
		expect(gate.currentRequestId).toBe(2); // beginRequest → 1, resetForInterrupt → 2
		// A subsequent maybeComplete must not fire (state was torn down).
		gate.maybeComplete();
		expect(onComplete).not.toHaveBeenCalled();
	});
});
