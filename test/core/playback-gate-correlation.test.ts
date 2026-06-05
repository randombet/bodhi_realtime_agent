// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../../src/types/tts.js';

/**
 * Characterization oracle for the playback gates' correlation-id guards (Step 0
 * of the VoiceSession modularization plan). It pins the "bump-on-teardown" /
 * "a late callback after teardown is a no-op" behavior that the Step 4–5 gate
 * extractions (`NativeAudioPlaybackGate`, `ExternalTtsPlaybackGate`) must
 * preserve: `_nativePlaybackId` / `_ttsCurrentRequestId` reject stale, premature,
 * and post-teardown signals. See
 * dev_docs/framework/investigation-voice-session-modularity.md.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

/** Generation-gated transport (`playbackGatedTurnComplete` absent → native gate engages). */
function createMockTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: true,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: true,
			sessionResumption: false,
			contextCompression: false,
			groundingMetadata: false,
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

function createMockTts(): TTSProvider {
	const fmt: TTSAudioConfig = { sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcm' };
	return {
		configure: vi.fn(() => fmt),
		synthesize: vi.fn(),
		cancel: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
	} as unknown as TTSProvider;
}

/** Base64 of `ms` of 24 kHz 16-bit mono PCM (48 bytes/ms). */
function pcm(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

type JsonCall = [Record<string, unknown>];
function countJson(sendJson: ReturnType<typeof vi.fn>, type: string): number {
	return sendJson.mock.calls.filter((c: JsonCall) => c[0]?.type === type).length;
}

function setupNative() {
	const transport = createMockTransport();
	const sendAudio = vi.fn();
	const sendJson = vi.fn();
	const session = new VoiceSession({
		sessionId: 'sess_gate_corr',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: true },
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: true,
	});
	return { transport, sendJson, session };
}

function setupTts() {
	const transport = createMockTransport();
	const sendAudio = vi.fn();
	const sendJson = vi.fn();
	const tts = createMockTts();
	const session = new VoiceSession({
		sessionId: 'sess_gate_corr_tts',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: true },
		playbackStateProtocol: 'audio_done',
		ttsProvider: tts,
	});
	return { transport, sendAudio, sendJson, tts, session };
}

describe('native playback gate — correlation-id guards', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('a late playback.ended (old id) after an interrupt is a no-op', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcm(1000));
			s.transport.onTurnComplete?.(1); // arms gate, audio.done id 1
			expect(countJson(s.sendJson, 'audio.done')).toBe(1);

			// Interrupt the playback-pending native turn (clears + bumps the id).
			// finalizeTurn's completion block always runs, so the interrupt itself
			// emits one turn.end; the guard we are pinning is that the *late signal*
			// adds no SECOND finalize.
			s.transport.onSpeechStarted?.();
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(1);
			const turnEndAfterInterrupt = countJson(s.sendJson, 'turn.end');

			// The client's now-stale playback.ended for the torn-down turn is ignored.
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(countJson(s.sendJson, 'turn.end')).toBe(turnEndAfterInterrupt);
		} finally {
			await session?.close();
		}
	});

	it('the fallback timer does not finalize an already-interrupted native turn', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcm(1000));
			s.transport.onTurnComplete?.(1); // arms gate + fallback timer

			s.transport.onSpeechStarted?.(); // interrupt → clearNativePlaybackGate (clears timer, bumps id)
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(1);
			const turnEndAfterInterrupt = countJson(s.sendJson, 'turn.end');

			vi.advanceTimersByTime(10000); // the torn-down fallback must not fire again
			expect(countJson(s.sendJson, 'turn.end')).toBe(turnEndAfterInterrupt);
		} finally {
			await session?.close();
		}
	});

	it('a premature playback.ended (before the gate is armed) is rejected', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcm(1000)); // audio seen, but gate not yet armed

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(countJson(s.sendJson, 'turn.end')).toBe(0); // rejected (timer not armed)

			s.transport.onTurnComplete?.(1); // now arms the gate
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(countJson(s.sendJson, 'turn.end')).toBe(1); // honoured
		} finally {
			await session?.close();
		}
	});

	it('a stale playback.ended (wrong id) is rejected; the matching id completes', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcm(1000));
			s.transport.onTurnComplete?.(1);

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 99 });
			expect(countJson(s.sendJson, 'turn.end')).toBe(0); // wrong id ignored

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(countJson(s.sendJson, 'turn.end')).toBe(1); // matching id honoured
		} finally {
			await session?.close();
		}
	});
});

describe('external TTS gate — requestId guards', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('a stale tts.onAudio (old requestId) emits no client audio', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupTts();
			session = s.session;
			await session.start();

			// Begin a TTS turn: first text increments _ttsCurrentRequestId to 1.
			s.transport.onModelTurnStart?.();
			s.transport.onTextOutput?.('Hello.');
			const audioBefore = s.sendAudio.mock.calls.length;

			// A late chunk tagged with a superseded requestId must be dropped.
			s.tts.onAudio?.(pcm(100), 100, 0);
			expect(s.sendAudio.mock.calls.length).toBe(audioBefore);

			// The current requestId (1) is accepted.
			s.tts.onAudio?.(pcm(100), 100, 1);
			expect(s.sendAudio.mock.calls.length).toBe(audioBefore + 1);
		} finally {
			await session?.close();
		}
	});

	it('a stale tts.onDone (old requestId) does not complete the turn', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupTts();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onTextOutput?.('Hello.'); // requestId → 1
			s.transport.onTextDone?.();
			s.transport.onTurnComplete?.(1); // LLM text done; awaiting TTS audio/done

			s.tts.onDone?.(0); // stale — must be ignored
			expect(countJson(s.sendJson, 'turn.end')).toBe(0);
		} finally {
			await session?.close();
		}
	});
});
