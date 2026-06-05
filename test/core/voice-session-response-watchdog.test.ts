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

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

function createMockTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: true,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: true,
			sessionResumption: true,
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

/** A 30 ms client mic frame (16 kHz PCM16) at the given amplitude. */
function micFrame(amplitude: number): Buffer {
	const f = Buffer.alloc(480 * 2);
	for (let i = 0; i < f.length; i += 2) f.writeInt16LE(amplitude, i);
	return f;
}

function setup(responseWatchdogMs = 8000) {
	const transport = createMockTransport();
	const session = new VoiceSession({
		sessionId: 'sess_watchdog',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		clientAudioVad: { bargeInConfirmMs: 0 },
		responseWatchdogMs,
	});
	return { transport, session };
}

/** Drive client audio VAD to a completed user turn (arms the watchdog). */
function completeUserTurn(session: VoiceSession) {
	session.feedAudioFromClient(micFrame(2400)); // speech start
	vi.advanceTimersByTime(150); // > AUDIO_VAD_MIN_SPEECH_MS (120)
	session.feedAudioFromClient(micFrame(2400)); // still speaking; duration ~150ms
	vi.advanceTimersByTime(500); // >= AUDIO_VAD_SILENCE_MS (500)
	session.feedAudioFromClient(micFrame(0)); // silence → completeClientAudioVad('silence')
}

async function activate(session: VoiceSession, transport: LLMTransport) {
	await session.start();
	transport.onSessionReady?.('mock_session'); // → ACTIVE
	transport.onResumptionUpdate?.('handle-1', true); // give reconnect a handle
}

describe('response watchdog', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('forces a reconnect when the model is silent after the user turn ends', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			expect(s.transport.reconnect).not.toHaveBeenCalled();

			vi.advanceTimersByTime(8000); // watchdog fires
			vi.advanceTimersByTime(1000); // RECONNECT_BACKOFF_MS[0] (first backoff delay) → reconnect()
			expect(s.transport.reconnect).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});

	it('does not reconnect when the model responds before the timeout', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			s.transport.onModelTurnStart?.(); // sign of life → disarm

			vi.advanceTimersByTime(20000);
			expect(s.transport.reconnect).not.toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});

	it('fires only once when the user speaks twice before any model output', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session); // arm
			vi.advanceTimersByTime(3000); // not yet fired
			completeUserTurn(session); // re-arm (restart timer)
			vi.advanceTimersByTime(8000); // fires once
			vi.advanceTimersByTime(1000); // RECONNECT_BACKOFF_MS[0] (first backoff delay) → reconnect()
			expect(s.transport.reconnect).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});

	it('is disabled when responseWatchdogMs <= 0', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup(0);
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			vi.advanceTimersByTime(20000);
			expect(s.transport.reconnect).not.toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});

	it('disarms on teardown so a closed session never reconnects', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session); // arm
			await session.close(); // teardown → clearResponseWatchdog
			session = undefined; // already closed; skip the finally double-close

			vi.advanceTimersByTime(20000);
			expect(s.transport.reconnect).not.toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});
});
