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
		elicitResponse: vi.fn(),
	};
}

/** A 30 ms client mic frame (16 kHz PCM16) at the given amplitude. */
function micFrame(amplitude: number): Buffer {
	const f = Buffer.alloc(480 * 2);
	for (let i = 0; i < f.length; i += 2) f.writeInt16LE(amplitude, i);
	return f;
}

function setup(responseWatchdogMs = 8000, transcriptionMode?: 'agent' | 'transcription') {
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
		transcriptionMode,
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

	it('re-elicits a response after a watchdog-driven reconnect', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			vi.advanceTimersByTime(8000); // fire
			vi.advanceTimersByTime(1000); // backoff → reconnect resolves
			await vi.runAllTimersAsync(); // let the reconnect().then() microtasks flush
			expect(s.transport.elicitResponse).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});

	it('stays recovered when the re-elicit nudge throws (best-effort)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			// Simulate a half-open SDK session whose nudge throws synchronously.
			s.transport.elicitResponse = vi.fn(() => {
				throw new Error('half-open');
			});
			await activate(session, s.transport);

			completeUserTurn(session);
			vi.advanceTimersByTime(8000); // fire
			vi.advanceTimersByTime(1000); // backoff → reconnect resolves
			await vi.runAllTimersAsync(); // flush reconnect().then() → nudge throws + is swallowed

			expect(s.transport.reconnect).toHaveBeenCalledTimes(1);
			expect(s.transport.elicitResponse).toHaveBeenCalledTimes(1);
			// A throwing nudge must NOT undo a successful reconnect.
			expect(session.sessionManager.state).toBe('ACTIVE');
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

	it('defers (no reconnect) when the watchdog fires mid-speech, then recovers (flag off)', async () => {
		// Regression: a multi-segment user turn must not be cut off. The watchdog is armed by
		// segment N's completion, but segment N+1 starts before it fires; the fire must DEFER
		// (R7a) instead of forcing a reconnect — even with watchdogReplayRecovery off (the
		// default here), where the mid-speech guard used to be unwired.
		let session: VoiceSession | undefined;
		try {
			const s = setup(); // no watchdogReplayRecovery → retainer absent (the bug condition)
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session); // segment N completes → arms watchdog (fires ~8s later)

			// Segment N+1 STARTS (~4s into the window) but does NOT complete: the user is
			// actively speaking when the stale segment-N timer fires.
			vi.advanceTimersByTime(4000);
			session.feedAudioFromClient(micFrame(2400)); // speech start → speechActive = true
			vi.advanceTimersByTime(150);
			session.feedAudioFromClient(micFrame(2400)); // still voiced; no completing silence

			vi.advanceTimersByTime(4000); // segment-N timer fires here, mid-speech → DEFER
			vi.advanceTimersByTime(1000); // would-be reconnect backoff window
			expect(s.transport.reconnect).not.toHaveBeenCalled();
			expect(session.sessionManager.state).toBe('ACTIVE');

			// No-strand guarantee: when the user finally stops, the segment completes and
			// re-arms; a genuine model-silence window after that still recovers.
			session.feedAudioFromClient(micFrame(0)); // silence → complete → re-arm watchdog
			vi.advanceTimersByTime(8000); // fresh window elapses, model still silent → fires
			vi.advanceTimersByTime(1000); // backoff → reconnect()
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

	it('never arms in transcription mode (model intentionally silent)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup(8000, 'transcription');
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session); // would arm in agent mode; must no-op here
			vi.advanceTimersByTime(20000);
			expect(s.transport.reconnect).not.toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});
});
