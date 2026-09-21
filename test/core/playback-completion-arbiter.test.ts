import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientVadDetector } from '../../src/core/client-vad-detector.js';
import {
	PlaybackCompletionArbiter,
	type PlaybackCompletionArbiterDeps,
} from '../../src/core/playback-completion-arbiter.js';
import type { ExternalTtsPlaybackGate, PlaybackGate } from '../../src/core/playback-gate.js';

function fakeGate(over: Partial<PlaybackGate> = {}): PlaybackGate & {
	clearTimer: ReturnType<typeof vi.fn>;
	armTimer: ReturnType<typeof vi.fn>;
} {
	return {
		pending: true,
		timerArmed: true,
		id: 1,
		clearTimer: vi.fn(),
		armTimer: vi.fn(),
		...over,
	} as never;
}

function makeArbiter(over: Partial<PlaybackCompletionArbiterDeps> = {}) {
	const completeAudio = vi.fn();
	const ttsGate = { completeAudio } as unknown as ExternalTtsPlaybackGate;
	const vad = {
		isSpeechActive: false,
		isBargeInEligible: false,
		resetSegment: vi.fn(),
	} as unknown as ClientVadDetector;
	const finalizeTurn = vi.fn();
	const gate = fakeGate();
	const deps: PlaybackCompletionArbiterDeps = {
		getLiveGate: () => gate,
		nativePlaybackGatingActive: false,
		getNativeGate: () => undefined,
		getTtsGate: () => ttsGate,
		vad,
		getBargeInConfig: () => ({ bargeInEnabled: true, bargeInConfirmMs: 200 }),
		finalizeTurn,
		log: vi.fn(),
		...over,
	};
	return { arbiter: new PlaybackCompletionArbiter(deps), completeAudio, finalizeTurn, vad, gate };
}

describe('PlaybackCompletionArbiter', () => {
	beforeEach(() => vi.useFakeTimers());

	it('completePlayback completes the external-TTS turn', () => {
		const { arbiter, completeAudio } = makeArbiter();
		arbiter.completePlayback();
		expect(completeAudio).toHaveBeenCalledTimes(1);
	});

	it('completePlayback finalizes the captured native turn when native-gating is on', () => {
		const turn = { id: 't' };
		const nativeGate = { pending: true, capturedTurn: turn } as never;
		const { arbiter, finalizeTurn } = makeArbiter({
			nativePlaybackGatingActive: true,
			getNativeGate: () => nativeGate,
		});
		arbiter.completePlayback();
		expect(finalizeTurn).toHaveBeenCalledWith(turn, { interrupted: false });
	});

	it('finishOrDeferForVad completes immediately with no potential barge-in', () => {
		const { arbiter, completeAudio, gate } = makeArbiter();
		arbiter.finishOrDeferForVad('signal');
		expect(gate.clearTimer).toHaveBeenCalled();
		expect(completeAudio).toHaveBeenCalledTimes(1);
		expect(arbiter.hasDeferred).toBe(false);
	});

	it('finishOrDeferForVad defers when a potential barge-in is in progress', () => {
		const vad = {
			isSpeechActive: true,
			isBargeInEligible: true,
			resetSegment: vi.fn(),
		} as unknown as ClientVadDetector;
		const { arbiter, completeAudio, gate } = makeArbiter({ vad });
		arbiter.finishOrDeferForVad('signal');
		expect(arbiter.hasDeferred).toBe(true);
		expect(completeAudio).not.toHaveBeenCalled(); // deferred, not completed
		expect(gate.armTimer).toHaveBeenCalled(); // defer timer armed

		// The defer timer force-completes (and resets the stale VAD segment).
		const deferCb = (gate.armTimer as ReturnType<typeof vi.fn>).mock.calls[0][1] as () => void;
		deferCb();
		expect(vad.resetSegment).toHaveBeenCalled();
		expect(completeAudio).toHaveBeenCalledTimes(1);
		expect(arbiter.hasDeferred).toBe(false);
	});

	it('resolveDeferredPlayback completes a deferred turn when the segment resolves', () => {
		const vad = {
			isSpeechActive: true,
			isBargeInEligible: true,
			resetSegment: vi.fn(),
		} as unknown as ClientVadDetector;
		const { arbiter, completeAudio, gate } = makeArbiter({ vad });
		arbiter.finishOrDeferForVad('fallback'); // defers
		expect(arbiter.hasDeferred).toBe(true);

		arbiter.resolveDeferredPlayback();
		expect(gate.clearTimer).toHaveBeenCalled();
		expect(completeAudio).toHaveBeenCalledTimes(1);
		expect(arbiter.hasDeferred).toBe(false);
	});

	it('resolveDeferredPlayback is a no-op when nothing was deferred', () => {
		const { arbiter, completeAudio } = makeArbiter();
		arbiter.resolveDeferredPlayback();
		expect(completeAudio).not.toHaveBeenCalled();
	});

	it('clearDefer resets the deferred state', () => {
		const vad = {
			isSpeechActive: true,
			isBargeInEligible: true,
			resetSegment: vi.fn(),
		} as unknown as ClientVadDetector;
		const { arbiter } = makeArbiter({ vad });
		arbiter.finishOrDeferForVad('signal');
		expect(arbiter.hasDeferred).toBe(true);
		arbiter.clearDefer();
		expect(arbiter.hasDeferred).toBe(false);
	});
});
