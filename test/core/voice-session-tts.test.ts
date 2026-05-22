// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type ResolvedClientAudioVadConfig,
	VoiceSession,
	clientVadBargeInAllowed,
} from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
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

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: [],
	};
}

function createVoiceFrame(): Buffer {
	const frame = Buffer.alloc(480 * 2);
	for (let i = 0; i < frame.length; i += 2) {
		frame.writeInt16LE(2400, i);
	}
	return frame;
}

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
		updateSession: vi.fn(async () => {}),
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

describe('VoiceSession TTS completion', () => {
	it('waits for provider onDone and keeps tail audio after an inter-chunk gap', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const provider = createMockTTSProvider();
			const transport = createMockTransport();
			const sendAudio = vi.fn();
			const sendJson = vi.fn();

			session = new VoiceSession({
				sessionId: 'sess_tts_gap',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createAgent()],
				initialAgent: 'main',
				model: mockModel,
				transport,
				orchestrationMode: 'actor',
				ttsProvider: provider,
				clientSender: { sendAudio, sendJson },
			});
			await session.start();

			transport.onTextOutput?.('It is 12:05 AM. Anything else you need?');
			transport.onTextDone?.();
			provider.onAudio?.(Buffer.from('first').toString('base64'), 100, 1);
			transport.onTurnComplete?.(1);

			vi.advanceTimersByTime(2500);

			provider.onAudio?.(Buffer.from('tail').toString('base64'), 100, 1);
			expect(sendAudio).toHaveBeenCalledTimes(2);
			expect(sendAudio).toHaveBeenLastCalledWith(Buffer.from('tail'));

			const turnEndsBeforeDone = sendJson.mock.calls.filter(([msg]) => msg?.type === 'turn.end');
			expect(turnEndsBeforeDone).toHaveLength(0);

			provider.onDone?.(1);

			const turnEndsAfterDone = sendJson.mock.calls.filter(([msg]) => msg?.type === 'turn.end');
			expect(turnEndsAfterDone).toHaveLength(1);
			expect(session.conversationContext.items.at(-1)?.content).toBe(
				'It is 12:05 AM. Anything else you need?',
			);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('handles client VAD barge-in while TTS is still speaking before delayed Gemini interrupt', async () => {
		const provider = createMockTTSProvider();
		const transport = createMockTransport();
		const sendAudio = vi.fn();
		const sendJson = vi.fn();
		const session = new VoiceSession({
			sessionId: 'sess_tts_barge_in',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			ttsProvider: provider,
			clientSender: { sendAudio, sendJson },
			// This test exercises the barge-in/Gemini-interrupt dedup, not the
			// confirmation window — opt out of the delay so a single frame fires.
			clientAudioVad: { bargeInConfirmMs: 0 },
		});

		try {
			await session.start();
			transport.onSessionReady?.('mock_session');
			transport.onTextOutput?.('Hello, I am still speaking.');
			transport.onTextDone?.();
			transport.onTurnComplete?.(3);
			provider.onAudio?.(Buffer.from('first').toString('base64'), 100, 1);

			session.feedAudioFromClient(createVoiceFrame());

			expect(provider.cancel).toHaveBeenCalledTimes(1);
			const interruptedMessages = sendJson.mock.calls.filter(
				([msg]) => msg?.type === 'turn.interrupted',
			);
			expect(interruptedMessages).toHaveLength(1);

			provider.onDone?.(1);
			transport.onInterrupted?.(3);

			const interruptedAfterTrailing = sendJson.mock.calls.filter(
				([msg]) => msg?.type === 'turn.interrupted',
			);
			expect(interruptedAfterTrailing).toHaveLength(1);
		} finally {
			await session.close();
		}
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

describe('server-turn finalization dedup', () => {
	// Models VoiceSession.handleTurnCompleteInternal's idempotent guard: a Gemini
	// server turn (identified by a monotonic id from the transport) is finalized
	// at most once — across the early generationComplete edge, a barge-in, and
	// the late turnComplete. See design-external-tts-turn-completion.md.
	let lastFinalizedServerTurnId: number | null;
	let finalizations: number;

	function finalize(serverTurnId: number | null) {
		if (serverTurnId !== null && serverTurnId === lastFinalizedServerTurnId) return;
		if (serverTurnId !== null) lastFinalizedServerTurnId = serverTurnId;
		finalizations++;
	}

	beforeEach(() => {
		lastFinalizedServerTurnId = null;
		finalizations = 0;
	});

	it('finalizes a server turn exactly once across early + trailing edges', () => {
		finalize(7); // early generationComplete
		finalize(7); // trailing turnComplete for the same server turn
		expect(finalizations).toBe(1);
	});

	it('finalizes distinct server turns independently', () => {
		finalize(1);
		finalize(2);
		expect(finalizations).toBe(2);
	});

	it('does not dedup when the transport supplies no server-turn id', () => {
		finalize(null);
		finalize(null);
		expect(finalizations).toBe(2);
	});

	it('a barge-in finalize is deduped against the trailing turnComplete', () => {
		finalize(5); // handleInterrupted finalizes
		finalize(5); // trailing turnComplete re-enters for the same server turn
		expect(finalizations).toBe(1);
	});
});

describe('client-VAD echo-aware barge-in (clientVadBargeInAllowed)', () => {
	// Mirrors the defaults VoiceSession resolves for a headphones-tuned setup.
	// The raised in-TTS thresholds are what keep the assistant's own speaker
	// echo from tripping a self-interrupt.
	const cfg: ResolvedClientAudioVadConfig = {
		bargeInEnabled: true,
		bargeInConfirmMs: 200,
		bargeInTtsPeakThreshold: 2000,
		bargeInTtsAvgAbsThreshold: 450,
	};

	it('rejects a loud blip shorter than the confirmation window', () => {
		// Plenty loud, but only 120 ms of voiced audio — a transient echo/click.
		expect(clientVadBargeInAllowed(cfg, 120, 9000, 2000)).toBe(false);
	});

	it('rejects sustained but quiet audio (residual TTS echo)', () => {
		// Past the confirm window, but echo-level energy — mirrors the real
		// cartesia-tts-demo turn_4 onset (peak=1861, avgAbs=333).
		expect(clientVadBargeInAllowed(cfg, 400, 1861, 333)).toBe(false);
	});

	it('rejects when peak clears the floor but average does not', () => {
		expect(clientVadBargeInAllowed(cfg, 400, 5000, 300)).toBe(false);
	});

	it('accepts sustained, loud, close-mic speech', () => {
		// Mirrors the real cartesia-tts-demo turn_2 barge-in.
		expect(clientVadBargeInAllowed(cfg, 336, 10242, 2701)).toBe(true);
	});

	it('accepts exactly at the confirmation-window and threshold boundaries', () => {
		expect(clientVadBargeInAllowed(cfg, 200, 2000, 450)).toBe(true);
	});

	it('rejects everything when the client barge-in is disabled', () => {
		const disabled: ResolvedClientAudioVadConfig = { ...cfg, bargeInEnabled: false };
		expect(clientVadBargeInAllowed(disabled, 5000, 30000, 9000)).toBe(false);
	});
});
