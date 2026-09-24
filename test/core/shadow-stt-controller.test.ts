import { describe, expect, it, vi } from 'vitest';
import {
	ShadowSttController,
	type ShadowSttControllerDeps,
} from '../../src/core/shadow-stt-controller.js';
import type { STTAudioConfig, STTProvider } from '../../src/types/transport.js';

type MockProvider = STTProvider & {
	configure: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	feedAudio: ReturnType<typeof vi.fn>;
	commit: ReturnType<typeof vi.fn>;
};

function createProvider(): MockProvider {
	return {
		configure: vi.fn(),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		feedAudio: vi.fn(),
		commit: vi.fn(),
		handleInterrupted: vi.fn(),
		handleTurnComplete: vi.fn(),
	};
}

const AUDIO: STTAudioConfig = { sampleRate: 16000, bitDepth: 16, channels: 1, encoding: 'pcm' };

function createController(over: Partial<ShadowSttControllerDeps> = {}) {
	const provider = createProvider();
	let currentTurn = 0;
	const onDivergence = vi.fn();
	const sendCorrection = vi.fn(async (_text: string, _turnId: number) => true);
	const log = vi.fn();
	const controller = new ShadowSttController({
		provider,
		audio: AUDIO,
		getCurrentTurnId: () => currentTurn,
		onDivergence,
		correctionEnabled: true,
		sendCorrection,
		log,
		...over,
	});
	/** Deliver the shadow provider's (asynchronous) final transcript. */
	const shadowFinal = (text: string, turnId?: number) => provider.onTranscript?.(text, turnId);
	return {
		controller,
		provider,
		onDivergence,
		sendCorrection,
		log,
		shadowFinal,
		setCurrentTurn: (id: number) => {
			currentTurn = id;
		},
	};
}

describe('ShadowSttController', () => {
	it('configures the provider with the fed audio format and installs onTranscript', () => {
		const { provider } = createController();
		expect(provider.configure).toHaveBeenCalledTimes(1);
		expect(provider.configure).toHaveBeenCalledWith(AUDIO);
		expect(provider.onTranscript).toBeTypeOf('function');
	});

	it('commit snapshots the live text per turn and commits the provider once per turn', () => {
		const { controller, provider, onDivergence, shadowFinal } = createController();
		controller.noteLiveTranscript('What is ');
		controller.noteLiveTranscript('this news');
		controller.commit(0);
		controller.commit(0); // a second model start in the same turn
		expect(provider.commit).toHaveBeenCalledTimes(1);
		expect(provider.commit).toHaveBeenCalledWith(0);

		// Text heard after the commit belongs to the next turn, not to turn 0's snapshot.
		controller.noteLiveTranscript('Hello Lucy');
		controller.commit(1);
		expect(provider.commit).toHaveBeenCalledTimes(2);
		expect(provider.commit).toHaveBeenLastCalledWith(1);

		shadowFinal('What is this', 0);
		shadowFinal('Hello Lucy', 1);
		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(onDivergence).toHaveBeenCalledWith('What is this news', 'What is this', 0);
	});

	it('a known turn compares against its snapshot and deletes it', () => {
		const { controller, onDivergence, log, shadowFinal } = createController();
		controller.noteLiveTranscript('What is this news');
		controller.commit(0);

		shadowFinal('What is this', 0);
		expect(onDivergence).toHaveBeenCalledTimes(1);

		// The snapshot is consumed: a repeated result for the turn has nothing to compare.
		shadowFinal('What is this', 0);
		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenLastCalledWith('[ShadowSTT] turn 0 compared: empty-live');
	});

	it('a result without a turn id uses and clears the live buffer', () => {
		const { controller, onDivergence, log, shadowFinal } = createController();
		controller.noteLiveTranscript('What is this news');

		shadowFinal('What is this');
		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(onDivergence).toHaveBeenCalledWith('What is this news', 'What is this', undefined);

		shadowFinal('What is this');
		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenLastCalledWith('[ShadowSTT] turn ? compared: empty-live');
	});

	it('a divergence calls onDivergence and logs it; a match does not', () => {
		const { controller, onDivergence, log, shadowFinal } = createController();
		controller.noteLiveTranscript("HI, what's this?");
		controller.commit(0);
		shadowFinal('hi whats this', 0);
		expect(onDivergence).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith('[ShadowSTT] turn 0 compared: match');

		controller.noteLiveTranscript("Hello, what's the news?");
		controller.commit(1);
		shadowFinal("Hello, what's this?", 1);
		expect(onDivergence).toHaveBeenCalledWith("Hello, what's the news?", "Hello, what's this?", 1);
		expect(log).toHaveBeenCalledWith(
			'[ShadowSTT] DIVERGENCE turn=1 live="hello whats the news" shadow="hello whats this"',
		);
	});

	it('corrects a substantive divergence on the current turn with the flag on', () => {
		const { controller, sendCorrection, shadowFinal, setCurrentTurn } = createController();
		setCurrentTurn(3);
		controller.noteLiveTranscript('What is this news');
		controller.commit(3);

		shadowFinal('What is this', 3);

		expect(sendCorrection).toHaveBeenCalledTimes(1);
		const [text, turnId] = sendCorrection.mock.calls[0] as [string, number];
		expect(turnId).toBe(3);
		expect(text).toBe(ShadowSttController.buildCorrectionText('What is this', 'What is this news'));
		expect(text).toContain('TRANSCRIPTION CORRECTION');
		expect(text).toContain('actually said: "What is this"');
		expect(text).toContain('You answered a mishearing ("What is this news")');
	});

	it('never corrects a stale turn or a result that names no turn', () => {
		const { controller, onDivergence, sendCorrection, shadowFinal, setCurrentTurn } =
			createController();
		controller.noteLiveTranscript('What is this news');
		controller.commit(0);
		setCurrentTurn(1); // the conversation moved on before the shadow result landed

		shadowFinal('What is this', 0);

		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(sendCorrection).not.toHaveBeenCalled();

		controller.noteLiveTranscript('What is this news');
		shadowFinal('What is this');

		expect(onDivergence).toHaveBeenCalledTimes(2);
		expect(sendCorrection).not.toHaveBeenCalled();
	});

	it('never corrects a filler-only divergence', () => {
		const { controller, onDivergence, sendCorrection, shadowFinal } = createController();
		controller.noteLiveTranscript('Yeah, makes sense.');
		controller.commit(0);

		shadowFinal('Makes sense.', 0);

		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(sendCorrection).not.toHaveBeenCalled();
	});

	it('never corrects with the flag off', () => {
		const { controller, onDivergence, sendCorrection, shadowFinal } = createController({
			correctionEnabled: false,
		});
		controller.noteLiveTranscript('What is this news');
		controller.commit(0);

		shadowFinal('What is this', 0);

		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(sendCorrection).not.toHaveBeenCalled();
	});

	it('a throwing onDivergence does not break the compare or the correction', () => {
		const onDivergence = vi.fn(() => {
			throw new Error('observer failed');
		});
		const { controller, sendCorrection, shadowFinal } = createController({ onDivergence });
		controller.noteLiveTranscript('What is this news');
		controller.commit(0);

		expect(() => shadowFinal('What is this', 0)).not.toThrow();

		expect(onDivergence).toHaveBeenCalledTimes(1);
		expect(sendCorrection).toHaveBeenCalledTimes(1);
	});

	it('keeps at most eight turn snapshots, evicting the oldest', () => {
		const { controller, onDivergence, log, shadowFinal } = createController({
			correctionEnabled: false,
		});
		for (let turn = 0; turn <= 8; turn++) {
			controller.noteLiveTranscript(`What is this news ${turn}`);
			controller.commit(turn);
		}

		// Turn 0 was the ninth-oldest snapshot: evicted, so its late result has nothing to compare.
		shadowFinal('What is this', 0);
		expect(onDivergence).not.toHaveBeenCalled();
		expect(log).toHaveBeenLastCalledWith('[ShadowSTT] turn 0 compared: empty-live');

		// Turns 1 to 8 are still held.
		for (let turn = 1; turn <= 8; turn++) shadowFinal('What is this', turn);
		expect(onDivergence).toHaveBeenCalledTimes(8);
		expect(onDivergence.mock.calls.map((c) => c[2])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});
});
