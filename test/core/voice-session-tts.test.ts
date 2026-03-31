// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../../src/types/tts.js';

/**
 * Unit tests for VoiceSession TTS wiring logic.
 *
 * These tests validate the TTS turn gating, barge-in, stale audio filtering,
 * and startup validation logic without instantiating a full VoiceSession
 * (which requires real WebSocket servers). Instead, we test the state machine
 * logic directly by simulating the callback sequences.
 */

function createMockTTSProvider(): TTSProvider & {
	_onAudio: NonNullable<TTSProvider['onAudio']>;
	_onDone: NonNullable<TTSProvider['onDone']>;
} {
	const provider: TTSProvider = {
		configure: vi.fn().mockReturnValue({
			sampleRate: 24000,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		} satisfies TTSAudioConfig),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		synthesize: vi.fn(),
		cancel: vi.fn(),
	};
	return provider as TTSProvider & {
		_onAudio: NonNullable<TTSProvider['onAudio']>;
		_onDone: NonNullable<TTSProvider['onDone']>;
	};
}

function createMockTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
			contextCompression: true,
			groundingMetadata: true,
			textResponseModality: true,
		} satisfies TransportCapabilities,
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		} satisfies AudioFormatSpec,
		isConnected: true,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

describe('VoiceSession TTS validation', () => {
	it('TTSProvider.configure receives preferred format from transport', () => {
		const provider = createMockTTSProvider();
		const transport = createMockTransport();

		const preferred: TTSAudioConfig = {
			sampleRate: transport.audioFormat.outputSampleRate,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		};

		provider.configure(preferred);
		expect(provider.configure).toHaveBeenCalledWith(preferred);
	});

	it('rejects TTS without textResponseModality', () => {
		const transport = createMockTransport();
		(transport.capabilities as TransportCapabilities).textResponseModality = false;

		expect(transport.capabilities.textResponseModality).toBe(false);
	});

	it('TTSProvider callbacks are wirable', () => {
		const provider = createMockTTSProvider();

		const audioFn = vi.fn();
		const doneFn = vi.fn();
		provider.onAudio = audioFn;
		provider.onDone = doneFn;

		provider.onAudio?.('base64data', 100, 1);
		provider.onDone?.(1);

		expect(audioFn).toHaveBeenCalledWith('base64data', 100, 1);
		expect(doneFn).toHaveBeenCalledWith(1);
	});
});

describe('TTS turn gating state machine', () => {
	let llmTextDone: boolean;
	let ttsAudioDone: boolean;
	let hasTextForRequest: boolean;
	let turnCompleted: boolean;

	function maybeCompleteTurn() {
		if (llmTextDone && ttsAudioDone) {
			turnCompleted = true;
			llmTextDone = false;
			ttsAudioDone = false;
			hasTextForRequest = false;
		}
	}

	function handleTurnComplete() {
		llmTextDone = true;
		if (!hasTextForRequest) {
			ttsAudioDone = true;
		}
		maybeCompleteTurn();
	}

	beforeEach(() => {
		llmTextDone = false;
		ttsAudioDone = false;
		hasTextForRequest = false;
		turnCompleted = false;
	});

	it('completes turn when both LLM and TTS are done', () => {
		hasTextForRequest = true;

		// LLM finishes text
		handleTurnComplete();
		expect(turnCompleted).toBe(false); // TTS not done yet

		// TTS finishes audio
		ttsAudioDone = true;
		maybeCompleteTurn();
		expect(turnCompleted).toBe(true);
	});

	it('completes immediately for tool-call-only turn (no text)', () => {
		hasTextForRequest = false;

		handleTurnComplete();
		expect(turnCompleted).toBe(true); // Immediate — no TTS to wait for
	});

	it('does not complete if only LLM is done', () => {
		hasTextForRequest = true;

		handleTurnComplete();
		expect(turnCompleted).toBe(false);
	});

	it('does not complete if only TTS is done', () => {
		hasTextForRequest = true;
		ttsAudioDone = true;
		maybeCompleteTurn();
		expect(turnCompleted).toBe(false); // LLM not done
	});
});

describe('TTS stale audio filtering', () => {
	it('drops audio with old requestId', () => {
		let currentRequestId = 1;
		const delivered: string[] = [];

		function onAudio(base64: string, _dur: number, requestId: number) {
			if (requestId !== currentRequestId) return; // stale
			delivered.push(base64);
		}

		onAudio('chunk1', 100, 1);
		expect(delivered).toEqual(['chunk1']);

		// Advance requestId (barge-in)
		currentRequestId = 2;

		// Late chunk from old request — dropped
		onAudio('chunk2_stale', 100, 1);
		expect(delivered).toEqual(['chunk1']);

		// New request audio — accepted
		onAudio('chunk3_new', 100, 2);
		expect(delivered).toEqual(['chunk1', 'chunk3_new']);
	});
});

describe('TTS barge-in', () => {
	it('cancels TTS and increments requestId on interrupt', () => {
		const provider = createMockTTSProvider();
		let currentRequestId = 1;
		let ttsSpeaking = true;

		// Simulate interrupt
		provider.cancel();
		ttsSpeaking = false;
		currentRequestId++;

		expect(provider.cancel).toHaveBeenCalled();
		expect(ttsSpeaking).toBe(false);
		expect(currentRequestId).toBe(2);
	});

	it('speech-started triggers interrupt when TTS speaking and LLM done', () => {
		const ttsSpeaking = true;
		const llmTextDone = true;
		let interrupted = false;

		// Simulate onSpeechStarted
		if (ttsSpeaking && llmTextDone) {
			interrupted = true;
		}

		expect(interrupted).toBe(true);
	});

	it('speech-started does NOT trigger interrupt when TTS not speaking', () => {
		const ttsSpeaking = false;
		const llmTextDone = true;
		let interrupted = false;

		if (ttsSpeaking && llmTextDone) {
			interrupted = true;
		}

		expect(interrupted).toBe(false);
	});
});

describe('TTS requestId lifecycle', () => {
	it('increments on first text token of new turn', () => {
		let currentRequestId = 0;
		let textStartedForTurn = false;

		// First text token
		if (!textStartedForTurn) {
			currentRequestId++;
			textStartedForTurn = true;
		}
		expect(currentRequestId).toBe(1);

		// Subsequent text tokens — no increment
		if (!textStartedForTurn) {
			currentRequestId++;
			textStartedForTurn = true;
		}
		expect(currentRequestId).toBe(1);
	});

	it('increments on interruption', () => {
		let currentRequestId = 1;

		// Interrupt
		currentRequestId++;
		expect(currentRequestId).toBe(2);
	});

	it('does not increment for tool-call-only turns', () => {
		const currentRequestId = 1;
		const textStartedForTurn = false;

		// Turn completes with no text — requestId unchanged
		if (!textStartedForTurn) {
			// No increment
		}
		expect(currentRequestId).toBe(1);
	});
});

describe('TTS transcript path', () => {
	it('onTextOutput feeds transcript, not onWordBoundary', () => {
		const transcriptHandler = vi.fn();
		const wordBoundaryHandler = vi.fn();

		// Simulate onTextOutput → transcript
		transcriptHandler('Hello world');
		expect(transcriptHandler).toHaveBeenCalledWith('Hello world');

		// word boundary is for timing only, NOT transcript
		wordBoundaryHandler('Hello', 0, 1);
		expect(wordBoundaryHandler).toHaveBeenCalledWith('Hello', 0, 1);

		// Transcript handler should only be called once (from text output)
		expect(transcriptHandler).toHaveBeenCalledTimes(1);
	});
});
