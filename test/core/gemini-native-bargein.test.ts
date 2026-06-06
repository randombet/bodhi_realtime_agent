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

/**
 * Client-VAD barge-in fallback for the Gemini native path (no playback gate).
 *
 * Gemini gates `turnComplete` on playback, so it is excluded from native-playback
 * gating (`liveGate()` is null) and its interrupts are purely provider-driven.
 * That makes a long, client-buffered greeting hard to interrupt. The fallback:
 * once a turn has emitted audio for at least the echo-skip window,
 * `isAssistantAudioActive()` is true, so a client-VAD barge-in finalizes the turn
 * (emitting `turn.interrupted`) — a deterministic interrupt independent of the
 * provider VAD. See investigation-voice-session-controllers.md.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

/** Gemini-like transport: `playbackGatedTurnComplete: true` and NO
 *  `frameworkOwnsInterrupt` → native-playback gating is excluded, `liveGate()`
 *  is null, and `cancelResponse` is provider-driven (not framework-owned). */
function createGeminiLikeTransport(): LLMTransport {
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
			playbackGatedTurnComplete: true,
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

/** Base64 of `ms` of 24 kHz 16-bit mono PCM (48 bytes/ms). */
function pcm(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

type JsonCall = [Record<string, unknown>];
function countJson(sendJson: ReturnType<typeof vi.fn>, type: string): number {
	return sendJson.mock.calls.filter((c: JsonCall) => c[0]?.type === type).length;
}

function setup() {
	const transport = createGeminiLikeTransport();
	// Controllable server-turn id (Gemini tracks one) — drives the trailing-audio
	// drop after a client-VAD barge-in.
	const serverTurn = { id: 1 as number | undefined };
	transport.getActiveServerTurnId = () => serverTurn.id;
	const sendAudio = vi.fn();
	const sendJson = vi.fn();
	const session = new VoiceSession({
		sessionId: 'sess_gemini_bargein',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: true },
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: true, // gated OFF by playbackGatedTurnComplete
	});
	const internals = session as unknown as {
		isAssistantAudioActive(): boolean;
		handleClientTtsBargeIn(): void;
		liveGate(): unknown;
	};
	return { transport, sendAudio, sendJson, session, internals, serverTurn };
}

describe('Gemini native client-VAD barge-in fallback', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('liveGate() is null for the Gemini native path', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();
			expect(s.internals.liveGate()).toBeNull();
		} finally {
			await session?.close();
		}
	});

	it('isAssistantAudioActive: false before audio, false within the echo-skip window, true after it', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			// No assistant audio yet → not active.
			s.transport.onModelTurnStart?.();
			expect(s.internals.isAssistantAudioActive()).toBe(false);

			// First audio chunk starts the window; still within the echo-skip.
			s.transport.onAudioOutput?.(pcm(100));
			vi.advanceTimersByTime(399);
			expect(s.internals.isAssistantAudioActive()).toBe(false);

			// Past the echo-skip window → interruptible.
			vi.advanceTimersByTime(1);
			expect(s.internals.isAssistantAudioActive()).toBe(true);
		} finally {
			await session?.close();
		}
	});

	it('a client-VAD barge-in finalizes the active greeting turn (emits turn.interrupted)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcm(1000)); // greeting audio
			vi.advanceTimersByTime(500); // past the echo-skip window

			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(0);
			s.internals.handleClientTtsBargeIn();
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(1);

			// Turn is finalized → no longer "speaking", so a second barge-in no-ops.
			expect(s.internals.isAssistantAudioActive()).toBe(false);
			s.internals.handleClientTtsBargeIn();
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(1);
		} finally {
			await session?.close();
		}
	});

	it('drops trailing audio of the interrupted server turn until a new turn begins', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.serverTurn.id = 1;
			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcm(1000)); // greeting audio (forwarded)
			const forwardedBefore = s.sendAudio.mock.calls.length;
			expect(forwardedBefore).toBeGreaterThan(0);

			vi.advanceTimersByTime(500);
			s.internals.handleClientTtsBargeIn(); // mutes server turn 1
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(1);

			// Gemini keeps streaming the rest of turn 1 — must be DROPPED.
			s.transport.onAudioOutput?.(pcm(1000));
			s.transport.onAudioOutput?.(pcm(1000));
			expect(s.sendAudio.mock.calls.length).toBe(forwardedBefore);

			// A new server turn (the agent's response) is forwarded again.
			s.serverTurn.id = 2;
			s.transport.onAudioOutput?.(pcm(1000));
			expect(s.sendAudio.mock.calls.length).toBeGreaterThan(forwardedBefore);
		} finally {
			await session?.close();
		}
	});

	it('a barge-in before any assistant audio is a no-op (nothing to interrupt)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			vi.advanceTimersByTime(1000); // time passes, but no audio emitted
			s.internals.handleClientTtsBargeIn();
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(0);
		} finally {
			await session?.close();
		}
	});
});
