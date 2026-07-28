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

function createAgent(greeting?: string): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: [],
		...(greeting !== undefined ? { greeting } : {}),
	};
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

/**
 * Phase-0 phantom-arm fix (investigation tests 1-4, 3b — see
 * dev_docs/framework/investigation-greeting-suppression-watchdog-regreet.md).
 * The watchdog must arm only for segments whose voiced audio was admitted
 * past the greeting gate; fully gated segments skip (and log), abort
 * retention, and notify the reconnector instead.
 */

type GatedTransport = LLMTransport & {
	reconnect: ReturnType<typeof vi.fn>;
	elicitResponse: ReturnType<typeof vi.fn>;
	triggerGeneration: ReturnType<typeof vi.fn>;
	replayUserTurn: ReturnType<typeof vi.fn>;
};

function setupGated(opts: { replayRecovery?: boolean } = {}) {
	const transport = createMockTransport() as GatedTransport;
	transport.replayUserTurn = vi.fn().mockReturnValue(true);
	const session = new VoiceSession({
		sessionId: 'sess_watchdog_gated',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent('Hello there!')],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		clientAudioVad: { bargeInConfirmMs: 0 },
		responseWatchdogMs: 8000,
		greetingInterruptible: false,
		...(opts.replayRecovery ? { watchdogReplayRecovery: true } : {}),
	});
	return { transport, session };
}

async function activateWithGreeting(session: VoiceSession, transport: LLMTransport) {
	await session.start();
	session.notifyClientConnected();
	transport.onSessionReady?.('mock_session');
	transport.onResumptionUpdate?.('handle-1', true);
	await vi.advanceTimersByTimeAsync(10); // memory-ready → sendGreeting chain
}

function anyRecoveryFired(t: GatedTransport): boolean {
	return (
		t.reconnect.mock.calls.length > 0 ||
		t.elicitResponse.mock.calls.length > 0 ||
		t.triggerGeneration.mock.calls.length > 0 ||
		t.replayUserTurn.mock.calls.length > 0
	);
}

describe('Phase-2 re-bind: provider-forced retention + H3 stale-candidate guard', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function peek(session: VoiceSession): unknown {
		return (
			(
				session as unknown as { utteranceRetainer?: { peek(m: number): unknown } }
			).utteranceRetainer?.peek(60_000) ?? null
		);
	}

	it('a provider-forced ROUTED segment arms (parity) but never re-seals a candidate for answered speech', async () => {
		let session: VoiceSession | undefined;
		try {
			const transport = createMockTransport();
			session = new VoiceSession({
				sessionId: 'sess_pf',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createAgent()],
				initialAgent: 'main',
				model: mockModel,
				transport,
				orchestrationMode: 'actor',
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				clientAudioVad: { bargeInConfirmMs: 0 },
				responseWatchdogMs: 8000,
				watchdogReplayRecovery: true,
			});
			await activate(session, transport);

			// Routed voiced segment, still open (no completing silence).
			session.feedAudioFromClient(micFrame(2400));
			vi.advanceTimersByTime(150);
			session.feedAudioFromClient(micFrame(2400));
			expect(transport.sendAudio).toHaveBeenCalled();

			// Model answers: onModelTurnStart clears the candidate, then
			// force-completes the segment (provider-recognition). Today the
			// completion re-seals — the Phase-2 truth table aborts instead.
			transport.onModelTurnStart?.();
			expect(peek(session)).toBeNull(); // answered speech leaves NO candidate

			// Watchdog parity: the forced-completed routed segment still arms.
			vi.advanceTimersByTime(8000 + 1000);
			await vi.runAllTimersAsync();
			expect(transport.reconnect).toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});

	it('H3: a sealed candidate survives a later fully-gated segment and stays replayable', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupGated({ replayRecovery: true });
			session = s.session;
			await activateWithGreeting(session, s.transport);
			s.transport.onModelTurnStart?.();
			s.transport.onTurnComplete?.(); // greeting done → gate open
			await vi.advanceTimersByTimeAsync(10);

			completeUserTurn(session); // routed → seals candidate A + arms
			expect(peek(session)).not.toBeNull();
			s.transport.onModelTurnStart?.(); // model answers → clears A + disarms
			s.transport.onAudioOutput?.(Buffer.alloc(4800).toString('base64'));

			// A second routed segment seals candidate B.
			completeUserTurn(session);
			expect(peek(session)).not.toBeNull();

			// A transfer-style second greeting re-arms suppression: simulate the
			// gate re-arming, then a fully-gated segment completes.
			const greeting = (
				session as unknown as {
					greeting: { sendGreeting(): void };
				}
			).greeting;
			greeting.sendGreeting();
			completeUserTurn(session); // fully gated → abort path
			// Candidate B must SURVIVE the gated segment's abort.
			expect(peek(session)).not.toBeNull();

			// And it remains replayable by a legitimately armed recovery: the
			// still-armed watchdog from segment B fires → tier-1 in-place replay.
			vi.advanceTimersByTime(8000 + 1000);
			await vi.runAllTimersAsync();
			expect(s.transport.replayUserTurn).toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});
});

describe('external-audio no-change guard (investigation test 7)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('an external-audio agent-mode segment still arms the watchdog', async () => {
		let session: VoiceSession | undefined;
		try {
			const transport = createMockTransport();
			session = new VoiceSession({
				sessionId: 'sess_watchdog_ext',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [{ ...createAgent(), audioMode: 'external' } as MainAgent],
				initialAgent: 'main',
				model: mockModel,
				transport,
				orchestrationMode: 'actor',
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				clientAudioVad: { bargeInConfirmMs: 0 },
				responseWatchdogMs: 8000,
			});
			await activate(session, transport);

			completeUserTurn(session); // consumed pre-gate by the external route
			expect(transport.sendAudio).not.toHaveBeenCalled(); // never reaches LLM
			vi.advanceTimersByTime(8000 + 1000);
			await vi.runAllTimersAsync();
			expect(transport.reconnect).toHaveBeenCalledTimes(1); // arms as today
		} finally {
			await session?.close();
		}
	});
});

describe.each([{ replayRecovery: false }, { replayRecovery: true }])(
	'phantom watchdog arm under greeting suppression (replayRecovery: $replayRecovery)',
	({ replayRecovery }) => {
		let logSpy: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			vi.useFakeTimers();
			logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		});
		afterEach(() => {
			logSpy.mockRestore();
			vi.useRealTimers();
		});

		const skipLogged = () =>
			logSpy.mock.calls.some(([m]) => typeof m === 'string' && m.includes('arm skipped'));

		it('test 1: a fully gated segment does not arm; a routed one after release does', async () => {
			let session: VoiceSession | undefined;
			try {
				const s = setupGated({ replayRecovery });
				session = s.session;
				await activateWithGreeting(session, s.transport);
				s.transport.onModelTurnStart?.(); // greeting response begins

				completeUserTurn(session); // every voiced frame gated
				expect(s.transport.sendAudio).not.toHaveBeenCalled();

				vi.advanceTimersByTime(8000 + 1000 + 500); // watchdog + backoff + margin
				await vi.runAllTimersAsync();
				expect(anyRecoveryFired(s.transport)).toBe(false);
				expect(skipLogged()).toBe(true);
				// A gated segment must never leave a sealed replay candidate.
				const retainer = (
					session as unknown as { utteranceRetainer?: { peek(m: number): unknown } }
				).utteranceRetainer;
				if (replayRecovery) expect(retainer?.peek(60_000) ?? null).toBeNull();

				// Greeting turn finalizes → suppression releases → routed arms.
				s.transport.onTurnComplete?.();
				await vi.advanceTimersByTimeAsync(10);
				completeUserTurn(session);
				expect(s.transport.sendAudio).toHaveBeenCalled();
				vi.advanceTimersByTime(8000 + 1000);
				await vi.runAllTimersAsync();
				expect(anyRecoveryFired(s.transport)).toBe(true);
			} finally {
				await session?.close();
			}
		});

		it('test 2: suppression releasing during the trailing-silence window still skips', async () => {
			let session: VoiceSession | undefined;
			try {
				const s = setupGated({ replayRecovery });
				session = s.session;
				await activateWithGreeting(session, s.transport);
				s.transport.onModelTurnStart?.();

				// Gated voiced span, then enter the silence window WITHOUT completing.
				session.feedAudioFromClient(micFrame(2400));
				vi.advanceTimersByTime(150);
				session.feedAudioFromClient(micFrame(2400));
				vi.advanceTimersByTime(200); // inside the 500 ms silence window

				// Greeting finalizes now → gate opens mid-silence.
				s.transport.onTurnComplete?.();
				await vi.advanceTimersByTimeAsync(10);

				vi.advanceTimersByTime(400); // silence window elapses
				session.feedAudioFromClient(micFrame(0)); // completion frame (gate open)

				vi.advanceTimersByTime(8000 + 1000 + 500);
				await vi.runAllTimersAsync();
				expect(anyRecoveryFired(s.transport)).toBe(false);
				expect(skipLogged()).toBe(true);
			} finally {
				await session?.close();
			}
		});

		it('test 3b: a provider-forced completion of a fully gated segment does not arm', async () => {
			let session: VoiceSession | undefined;
			try {
				const s = setupGated({ replayRecovery });
				session = s.session;
				await activateWithGreeting(session, s.transport);

				// Gated voiced span, segment still open (no completing silence).
				session.feedAudioFromClient(micFrame(2400));
				vi.advanceTimersByTime(150);
				session.feedAudioFromClient(micFrame(2400));

				// Model turn start force-completes the segment (provider-recognition
				// path) AFTER disarming — the forced completion must not re-arm.
				s.transport.onModelTurnStart?.();

				vi.advanceTimersByTime(8000 + 1000 + 500);
				await vi.runAllTimersAsync();
				expect(anyRecoveryFired(s.transport)).toBe(false);
			} finally {
				await session?.close();
			}
		});

		it('test 4a (straddle): the gate opening mid-speech routes the tail and arms', async () => {
			let session: VoiceSession | undefined;
			try {
				const s = setupGated({ replayRecovery });
				session = s.session;
				await activateWithGreeting(session, s.transport);
				s.transport.onModelTurnStart?.();

				session.feedAudioFromClient(micFrame(2400)); // gated head
				vi.advanceTimersByTime(150); // clear AUDIO_VAD_MIN_SPEECH_MS (120)
				s.transport.onTurnComplete?.(); // greeting finalizes mid-speech
				await vi.advanceTimersByTimeAsync(10);
				session.feedAudioFromClient(micFrame(2400)); // routed tail
				vi.advanceTimersByTime(500);
				session.feedAudioFromClient(micFrame(0)); // completion

				expect(s.transport.sendAudio).toHaveBeenCalled();
				vi.advanceTimersByTime(8000 + 1000);
				await vi.runAllTimersAsync();
				expect(anyRecoveryFired(s.transport)).toBe(true);
			} finally {
				await session?.close();
			}
		});
	},
);
