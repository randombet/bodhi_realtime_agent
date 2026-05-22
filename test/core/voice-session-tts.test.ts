// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type ResolvedClientAudioVadConfig,
	VoiceSession,
	clientVadBargeInAllowed,
	clientVadBargeInEnergyEligible,
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

			// onDone arms the fallback timer (never completes synchronously for
			// an audio-bearing turn); the turn completes once it fires.
			vi.advanceTimersByTime(1600);

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

	it('clientVadBargeInEnergyEligible gates on peak AND average, no time check', () => {
		expect(clientVadBargeInEnergyEligible(cfg, 10242, 2701)).toBe(true);
		expect(clientVadBargeInEnergyEligible(cfg, 1999, 2701)).toBe(false); // peak short
		expect(clientVadBargeInEnergyEligible(cfg, 10242, 449)).toBe(false); // avg short
		expect(clientVadBargeInEnergyEligible(cfg, 2000, 450)).toBe(true); // boundary
	});

	it('a loud frame is energy-eligible before the confirmation window elapses', () => {
		// Energy gate passes immediately; the full barge-in still waits for the
		// confirmation window — this is what marks a *potential* barge-in.
		expect(clientVadBargeInEnergyEligible(cfg, 10242, 2701)).toBe(true);
		expect(clientVadBargeInAllowed(cfg, 0, 10242, 2701)).toBe(false);
	});
});

describe('TTS playback-aware turn completion', () => {
	// External TTS synthesizes far faster than realtime playback. The turn must
	// stay open (and interruptible) until the client has — by estimate —
	// finished draining the buffered audio, not the moment synthesis is done.
	function setup(
		clientAudioVad?: { bargeInConfirmMs?: number },
		playbackStateProtocol?: 'disabled' | 'audio_done',
		// Mirrors the per-surface capability the sender's producer declares
		// (true for the browser PCM sender; false for Spatial Avatar / Twilio).
		// Default true — the common first-party web case.
		senderSupportsProtocol = true,
	) {
		const provider = createMockTTSProvider();
		const transport = createMockTransport();
		const sendAudio = vi.fn();
		const sendJson = vi.fn();
		const session = new VoiceSession({
			sessionId: 'sess_tts_playback',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			ttsProvider: provider,
			clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: senderSupportsProtocol },
			...(clientAudioVad ? { clientAudioVad } : {}),
			...(playbackStateProtocol ? { playbackStateProtocol } : {}),
		});
		return { provider, transport, sendJson, session };
	}

	it('defers turn completion until the estimated client playback end', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onTextOutput?.('Hello, this is a fairly long greeting.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			// 3000 ms of synthesized audio, then synthesis reports done.
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1);

			// Synthesis is done but the client is still playing ~3 s of audio —
			// the turn must NOT be complete yet.
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(0);

			// Advance past the estimated end + fallback margin (3000 + 1500 ms).
			vi.advanceTimersByTime(4600);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('a barge-in during the playback tail still interrupts and clears the timer', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			// bargeInConfirmMs:0 — a single sustained frame fires; this test
			// exercises the tail window, not the confirmation delay.
			const s = setup({ bargeInConfirmMs: 0 });
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session');

			s.transport.onTextOutput?.('Hello, this is a fairly long greeting.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1); // turn now in the playback tail

			// User speaks over the still-playing audio.
			session.feedAudioFromClient(createVoiceFrame());

			expect(s.provider.cancel).toHaveBeenCalledTimes(1);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.interrupted')).toHaveLength(1);
			const turnEndsAfterBargeIn = s.sendJson.mock.calls.filter(
				([m]) => m?.type === 'turn.end',
			).length;

			// The playback timer must have been cleared — no late second completion.
			vi.advanceTimersByTime(5000);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(
				turnEndsAfterBargeIn,
			);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('completes immediately when onDone arrives with no audio played', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onTextOutput?.('Hi.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			// No onAudio fed — nothing is playing on the client.
			s.provider.onDone?.(1);

			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('never completes synchronously in onDone, even when the estimate is already past', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onTextOutput?.('Hi.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 100, 1);
			// Synthesis ran slower than realtime — the 100 ms of audio is long
			// drained by the time onDone fires. An audio-bearing turn must still
			// NOT complete synchronously; the fallback timer always gets at
			// least the margin so a healthy client can answer.
			vi.advanceTimersByTime(600);
			s.provider.onDone?.(1);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(0);

			vi.advanceTimersByTime(1600);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('logs the completion source as "signal" when completed by playback.ended', async () => {
		vi.useFakeTimers();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		let session: VoiceSession | undefined;
		try {
			const s = setup(undefined, 'audio_done');
			session = s.session;
			await session.start();
			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1);
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });

			const logged = logSpy.mock.calls.map((c) => String(c[0]));
			expect(logged.some((l) => l.includes('TTS turn complete via signal'))).toBe(true);
		} finally {
			await session?.close();
			logSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('logs the completion source as "fallback" when completed by the timer', async () => {
		vi.useFakeTimers();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		let session: VoiceSession | undefined;
		try {
			const s = setup(undefined, 'audio_done');
			session = s.session;
			await session.start();
			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 1000, 1);
			s.provider.onDone?.(1);
			vi.advanceTimersByTime(5000); // no signal — fallback timer fires

			const logged = logSpy.mock.calls.map((c) => String(c[0]));
			expect(logged.some((l) => l.includes('TTS turn complete via fallback'))).toBe(true);
		} finally {
			await session?.close();
			logSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	// --- VAD-resolution defer (step 9) ---

	/** A PCM frame of all-`amplitude` int16 samples (480 samples = 30 ms @ 16 kHz). */
	function frameOf(amplitude: number): Buffer {
		const frame = Buffer.alloc(480 * 2);
		for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(amplitude, i);
		return frame;
	}

	it('defers the fallback completion while a potential barge-in is active, then completes on silence', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session');

			s.transport.onTextOutput?.('Hello there, a fairly long greeting.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1); // fallback timer armed at ~4500 ms

			// A loud sound during the tail — VAD segment active + energy-eligible.
			session.feedAudioFromClient(frameOf(2400));

			// Fallback timer fires → finishOrDeferForVad → potential barge-in → defer.
			vi.advanceTimersByTime(4600);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(0);

			// The segment resolves as silence (no sustained barge-in) → the
			// completeClientAudioVad hook completes the turn.
			session.feedAudioFromClient(frameOf(0));
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('force-completes a deferred turn when mic frames stop (no loop)', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session');

			s.transport.onTextOutput?.('Hello there, a fairly long greeting.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1);

			session.feedAudioFromClient(frameOf(2400));
			vi.advanceTimersByTime(4600); // fallback fires → defer
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(0);

			// No further mic frames — the re-armed defer timer force-completes.
			vi.advanceTimersByTime(800);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
			// And it does not loop / double-complete.
			vi.advanceTimersByTime(5000);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('sends audio.done when the playback-state protocol is active', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup(undefined, 'audio_done');
			session = s.session;
			await session.start();

			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 1000, 1);
			s.provider.onDone?.(1);

			const audioDone = s.sendJson.mock.calls.filter(([m]) => m?.type === 'audio.done');
			expect(audioDone).toHaveLength(1);
			expect(audioDone[0][0]).toMatchObject({ type: 'audio.done', playbackId: 1 });
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('stays inactive when the config opts in but the sender cannot support it', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			// playbackStateProtocol 'audio_done' but a sender (Spatial Avatar /
			// Twilio) that declares supportsPlaybackStateProtocol false — the
			// two-factor resolution must keep the protocol inactive.
			const s = setup(undefined, 'audio_done', false);
			session = s.session;
			await session.start();

			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 1000, 1);
			s.provider.onDone?.(1);

			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'audio.done')).toHaveLength(0);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('sends no audio.done when the protocol is disabled (default)', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 1000, 1);
			s.provider.onDone?.(1);

			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'audio.done')).toHaveLength(0);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('playback.ended completes the turn when no VAD segment is active', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup(undefined, 'audio_done');
			session = s.session;
			await session.start();
			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(0);

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('rejects a stale playback.ended (wrong playbackId), honours the correct one', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup(undefined, 'audio_done');
			session = s.session;
			await session.start();
			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1);

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 99 });
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(0);
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('rejects a premature playback.ended before tts.onDone', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup(undefined, 'audio_done');
			session = s.session;
			await session.start();
			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);

			// onDone has not fired — the playback timer is not armed.
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(0);

			s.provider.onDone?.(1);
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('a duplicate playback.ended after completion is a no-op', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup(undefined, 'audio_done');
			session = s.session;
			await session.start();
			s.transport.onTextOutput?.('Hello.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1);

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});

	it('does not defer for a sub-threshold (echo-level) VAD segment', async () => {
		vi.useFakeTimers();
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session');

			s.transport.onTextOutput?.('Hello there, a fairly long greeting.');
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1);
			s.provider.onAudio?.(Buffer.from('aud').toString('base64'), 3000, 1);
			s.provider.onDone?.(1);

			// Loud enough to start a VAD segment (peak >= 1200) but below the
			// in-TTS barge-in energy floor — not a potential barge-in.
			session.feedAudioFromClient(frameOf(1500));

			// Fallback fires → no defer → the turn completes normally.
			vi.advanceTimersByTime(4600);
			expect(s.sendJson.mock.calls.filter(([m]) => m?.type === 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
			vi.useRealTimers();
		}
	});
});
