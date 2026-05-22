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
 * Unit tests for native-audio playback-end gating (the OpenAI native path).
 * The mock transport reports `playbackGatedTurnComplete: false`, so the gate
 * engages; a mock client sender carries `supportsPlaybackStateProtocol`.
 * See dev_docs/framework/design-playback-end-gating-openai-native.md.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

/** Mock transport — generation-gated (`playbackGatedTurnComplete` defaults false). */
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

/** Base64 of `ms` of 24 kHz 16-bit mono PCM (24000·2 = 48 bytes/ms). */
function pcmBase64(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

type JsonCall = [Record<string, unknown>];

function jsonOfType(sendJson: ReturnType<typeof vi.fn>, type: string): Record<string, unknown>[] {
	return sendJson.mock.calls
		.filter((c: JsonCall) => c[0]?.type === type)
		.map((c: JsonCall) => c[0]);
}

function setupNative(opts?: { nativePlaybackGating?: boolean }) {
	const transport = createMockTransport();
	const sendAudio = vi.fn();
	const sendJson = vi.fn();
	const session = new VoiceSession({
		sessionId: 'sess_native_playback',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: true },
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: opts?.nativePlaybackGating ?? true,
	});
	return { transport, sendJson, session };
}

describe('native playback-end gating — deferred completion', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('sends one audio.done at native turn-complete and does not finalize synchronously', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			const audioDone = jsonOfType(s.sendJson, 'audio.done');
			expect(audioDone).toHaveLength(1);
			expect(audioDone[0]).toMatchObject({ type: 'audio.done', playbackId: 1 });
			// Deferred — no turn.end yet.
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);
		} finally {
			await session?.close();
		}
	});

	it('sends no audio.done when nativePlaybackGating is off', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative({ nativePlaybackGating: false });
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(0);
			// Immediate finalize — the gate never engaged.
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('the fallback timer finalizes a native turn when no playback.ended arrives', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);

			// estimate (~1176 ms) + fallback margin (1500 ms).
			vi.advanceTimersByTime(3000);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a no-audio native turn does not engage the gate', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onTurnComplete?.(1); // no onAudioOutput

			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(0);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a tool-dispatching response does not engage the gate', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(400)); // a spoken preamble
			s.transport.onToolCall?.([{ id: 'c1', name: 'get_time', arguments: {} }]);
			s.transport.onTurnComplete?.(1);

			// _nativeResponseDispatchedToolCall is set → the gate is skipped.
			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(0);
		} finally {
			await session?.close();
		}
	});

	it('a barge-in during the playback-pending window finalizes exactly once', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);
			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(1);

			s.transport.onInterrupted?.(1);
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(1);
			const turnEndAfterInterrupt = jsonOfType(s.sendJson, 'turn.end').length;

			// The fallback callback must not drive a second finalization.
			vi.advanceTimersByTime(5000);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(turnEndAfterInterrupt);
		} finally {
			await session?.close();
		}
	});
});
