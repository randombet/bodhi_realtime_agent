import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientVadDetector } from '../../src/core/client-vad-detector.js';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import { decodeMulawToPcm, encodePcmToMulaw } from '../../src/telephony/audio-codec.js';
import { EchoGuard } from '../../src/transport/echo-guard.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	STTProvider,
	TransportCapabilities,
} from '../../src/types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../../src/types/tts.js';

/**
 * Echo suppression on a session: the decoded native model audio is the echo
 * guard's reference, and the audio router drops inbound client audio that
 * echoes it before the VAD, the transport or STT see it.
 *
 * The transport is an injected mock whose callbacks the tests drive directly.
 * `Date` is faked so the guard's timestamps (it reads `Date.now()`) are exact.
 */

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({ text: 'subagent done' })),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

/** Build an s16le mono PCM buffer whose 20ms-frame RMS follows `envelope` (0..1). */
function pcmFromEnvelope(envelope: number[], sampleRate: number): Buffer {
	const samplesPerFrame = Math.round((sampleRate * 20) / 1000);
	const buf = Buffer.alloc(envelope.length * samplesPerFrame * 2);
	let idx = 0;
	for (const level of envelope) {
		for (let i = 0; i < samplesPerFrame; i++) {
			// square wave at the target RMS — deterministic, RMS == level
			const s = Math.round((i % 2 === 0 ? level : -level) * 32767 * 0.99);
			buf.writeInt16LE(s, idx * 2);
			idx++;
		}
	}
	return buf;
}

/** Random-walk envelope — enough structure for correlation to be meaningful. */
function randomWalkEnvelope(n: number, seed = 42): number[] {
	let x = 0.5;
	// Warm the LCG up: small seeds fed straight in start on near-identical
	// trajectories, which made "unrelated" test envelopes spuriously correlated
	// (a test artifact, not a guard weakness).
	let s = (seed * 2654435761) % 2 ** 31;
	for (let i = 0; i < 20; i++) s = (s * 1103515245 + 12345) % 2 ** 31;
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		x += (s / 2 ** 31 - 0.5) * 0.3;
		x = Math.min(0.95, Math.max(0.05, x));
		out.push(x);
	}
	return out;
}

function createAgent(greeting?: string): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [], greeting };
}

interface MockTransportOptions {
	encoding?: 'pcm' | 'pcmu';
	inputSampleRate?: number;
	outputSampleRate?: number;
	greetingInterruptGraceMs?: number;
}

function createMockTransport(opts: MockTransportOptions = {}): LLMTransport & {
	sendAudio: ReturnType<typeof vi.fn>;
} {
	const transport: LLMTransport = {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
			contextCompression: true,
			groundingMetadata: true,
			textResponseModality: true,
			...(opts.greetingInterruptGraceMs !== undefined && {
				greetingInterruptGraceMs: opts.greetingInterruptGraceMs,
				frameworkOwnsInterrupt: true,
			}),
		} satisfies TransportCapabilities,
		audioFormat: {
			inputSampleRate: opts.inputSampleRate ?? 16000,
			outputSampleRate: opts.outputSampleRate ?? 24000,
			channels: 1,
			bitDepth: 16,
			encoding: opts.encoding ?? 'pcm',
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
		cancelResponse: vi.fn(async () => {}),
	};
	return transport as LLMTransport & { sendAudio: ReturnType<typeof vi.fn> };
}

function createMockTTSProvider(): TTSProvider {
	return {
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
}

function createMockSttProvider(): STTProvider & { feedAudio: ReturnType<typeof vi.fn> } {
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

/** Base time of every scenario (the guard stamps frames with `Date.now()`). */
const T0 = 1_700_000_000_000;

/**
 * Loopback scenario: a 48-frame (960ms) envelope is played as one 24 kHz
 * native output chunk at T0, and the same envelope comes back on the 16 kHz
 * mic 600ms later, delivered as two 24-frame chunks (the first half ends
 * 480ms before the echo's end). Time only moves forward.
 */
const ECHO_LAG_MS = 600;
const PLAYED = randomWalkEnvelope(48);
const ECHO_FIRST_HALF = pcmFromEnvelope(PLAYED.slice(0, 24), 16000);
const ECHO_SECOND_HALF = pcmFromEnvelope(PLAYED.slice(24), 16000);

/** Mic arrival times of the two loopback halves of audio whose play ended at `playedAt`. */
function loopbackTimes(playedAt: number): [number, number] {
	return [playedAt - 480 + ECHO_LAG_MS, playedAt + ECHO_LAG_MS];
}

/**
 * Double talk: the user speaks while the played audio echoes back, so each
 * inbound half carries both. The helpers emit in-phase square waves, so a
 * half built from the weighted sum of the two envelopes is (up to rounding)
 * the sample-by-sample sum of the scaled echo and the scaled speech. The
 * weights sum to 1, so the mix never clips.
 */
const USER_SPEECH = randomWalkEnvelope(48, 25);
function mixedHalves(echoWeight: number): [Buffer, Buffer] {
	const mix = PLAYED.map((level, i) => echoWeight * level + (1 - echoWeight) * USER_SPEECH[i]);
	return [pcmFromEnvelope(mix.slice(0, 24), 16000), pcmFromEnvelope(mix.slice(24), 16000)];
}

/**
 * The ported guard's own verdict (`suppress`) for each half, computed on a
 * standalone EchoGuard fed the same reference at T0 and checking the halves
 * at the same arrival times the session sees.
 */
function guardDecisions(halves: [Buffer, Buffer]): boolean[] {
	const guard = new EchoGuard({ enabled: true });
	guard.feedReference(pcmFromEnvelope(PLAYED, 24000), 24000, T0);
	const times = loopbackTimes(T0);
	return halves.map((pcm, i) => guard.check(pcm, 16000, times[i]).suppress);
}

describe('VoiceSession echo guard', () => {
	let session: VoiceSession | null = null;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(T0);
	});

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	function createSession(
		transport: LLMTransport,
		overrides: Partial<VoiceSessionConfig> = {},
	): { session: VoiceSession; log: ReturnType<typeof vi.fn>; sendAudio: ReturnType<typeof vi.fn> } {
		const log = vi.fn();
		const sendAudio = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_echo',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			clientSender: { sendAudio, sendJson: vi.fn() },
			log,
			...overrides,
		});
		return { session, log, sendAudio };
	}

	/** A started session with a client attached and the upstream ready. */
	async function startSession(
		transport: LLMTransport,
		overrides: Partial<VoiceSessionConfig> = {},
	): Promise<ReturnType<typeof createSession>> {
		const created = createSession(transport, overrides);
		await created.session.start();
		created.session.notifyClientConnected();
		transport.onSessionReady?.('mock_session');
		await new Promise((r) => setTimeout(r, 5));
		return created;
	}

	/** The model speaks `pcm` (base64 on the transport's output encoding) at `atMs`. */
	function playNative(transport: LLMTransport, pcm: Buffer, atMs: number): void {
		vi.setSystemTime(atMs);
		transport.onModelTurnStart?.();
		transport.onAudioOutput?.(pcm.toString('base64'));
	}

	/** Feed two inbound halves (the pure echo by default) at their loopback
	 *  times for a play ending at `playedAt`. */
	function feedEcho(
		s: VoiceSession,
		playedAt: number,
		[first, second]: [Buffer, Buffer] = [ECHO_FIRST_HALF, ECHO_SECOND_HALF],
	): void {
		const [firstAt, secondAt] = loopbackTimes(playedAt);
		vi.setSystemTime(firstAt);
		s.feedAudioFromClient(first);
		vi.setSystemTime(secondAt);
		s.feedAudioFromClient(second);
	}

	function sentPayloads(transport: { sendAudio: ReturnType<typeof vi.fn> }): string[] {
		return transport.sendAudio.mock.calls.map((c) => String(c[0]));
	}

	it('feeds the decoded native output to the reference at the transport output rate (24000)', async () => {
		const feed = vi.spyOn(EchoGuard.prototype, 'feedReference');
		const transport = createMockTransport();
		const { sendAudio } = await startSession(transport, { echoGuard: { enabled: true } });

		const pcm = pcmFromEnvelope(PLAYED, 24000);
		playNative(transport, pcm, T0);

		expect(feed).toHaveBeenCalledTimes(1);
		expect(feed).toHaveBeenCalledWith(pcm, 24000);
		expect(sendAudio).toHaveBeenCalledWith(pcm);
	});

	it('feeds μ-law output to the reference as decoded PCM at 8000 on a pcmu transport', async () => {
		const feed = vi.spyOn(EchoGuard.prototype, 'feedReference');
		const transport = createMockTransport({
			encoding: 'pcmu',
			inputSampleRate: 8000,
			outputSampleRate: 8000,
		});
		await startSession(transport, { echoGuard: { enabled: true } });

		const mulaw = encodePcmToMulaw(pcmFromEnvelope(PLAYED, 8000));
		playNative(transport, mulaw, T0);

		expect(feed).toHaveBeenCalledTimes(1);
		expect(feed).toHaveBeenCalledWith(decodeMulawToPcm(mulaw), 8000);
	});

	it('an inbound echo of played audio never reaches transport.sendAudio once recognized', async () => {
		const transport = createMockTransport();
		const { session: s } = await startSession(transport, { echoGuard: { enabled: true } });

		playNative(transport, pcmFromEnvelope(PLAYED, 24000), T0);
		feedEcho(s, T0);

		// One correlated window is never enough (default streak of 2): the first
		// half is forwarded, the second is recognized as echo and dropped.
		const sent = sentPayloads(transport);
		expect(sent).toContain(ECHO_FIRST_HALF.toString('base64'));
		expect(sent).not.toContain(ECHO_SECOND_HALF.toString('base64'));
		expect(s.getDiagnostics().echoSuppressed).toBe(1);
	});

	it('BODHI_ECHO_GUARD=0 disables suppression', async () => {
		vi.stubEnv('BODHI_ECHO_GUARD', '0');
		const transport = createMockTransport();
		const { session: s } = await startSession(transport, { echoGuard: { enabled: true } });

		playNative(transport, pcmFromEnvelope(PLAYED, 24000), T0);
		feedEcho(s, T0);

		expect(sentPayloads(transport)).toEqual([
			ECHO_FIRST_HALF.toString('base64'),
			ECHO_SECOND_HALF.toString('base64'),
		]);
		expect(s.getDiagnostics().echoSuppressed).toBe(0);
	});

	it('passes the same audio through when nothing played recently', async () => {
		const transport = createMockTransport();
		const { session: s } = await startSession(transport, { echoGuard: { enabled: true } });

		// The same audio arrives 5 s after it played: the reference is stale, so
		// the guard fails open.
		playNative(transport, pcmFromEnvelope(PLAYED, 24000), T0);
		feedEcho(s, T0 + 5000);

		expect(sentPayloads(transport)).toEqual([
			ECHO_FIRST_HALF.toString('base64'),
			ECHO_SECOND_HALF.toString('base64'),
		]);
		expect(s.getDiagnostics().echoSuppressed).toBe(0);
	});

	it('greeting grace still drops frames the guard admits', async () => {
		const transport = createMockTransport({ greetingInterruptGraceMs: 1000 });
		const { session: s } = await startSession(transport, {
			agents: [createAgent('Hi there!')],
			orchestrationMode: 'actor',
			echoGuard: { enabled: true },
		});

		// The greeting's first audio arms the grace window and feeds the reference.
		playNative(transport, pcmFromEnvelope(PLAYED, 24000), T0);
		const sentBefore = transport.sendAudio.mock.calls.length;

		// Speech unrelated to the greeting: the guard admits it, the grace gate drops it.
		vi.setSystemTime(T0 + 100);
		s.feedAudioFromClient(pcmFromEnvelope(randomWalkEnvelope(24, 7), 16000));
		vi.setSystemTime(T0 + 580);
		s.feedAudioFromClient(pcmFromEnvelope(randomWalkEnvelope(24, 13), 16000));

		expect(s.getDiagnostics().echoSuppressed).toBe(0);
		expect(transport.sendAudio.mock.calls.length).toBe(sentBefore);
	});

	it('with ttsProvider in actor mode, logs the warning once and feeds nothing from the TTS pipeline', async () => {
		const feed = vi.spyOn(EchoGuard.prototype, 'feedReference');
		const provider = createMockTTSProvider();
		const transport = createMockTransport();
		const {
			session: s,
			log,
			sendAudio,
		} = createSession(transport, {
			orchestrationMode: 'actor',
			ttsProvider: provider,
			echoGuard: { enabled: true },
		});

		const warnings = log.mock.calls
			.map((c) => String(c[0]))
			.filter((line) => line.includes('echoGuard is configured with ttsProvider'));
		expect(warnings).toHaveLength(1);

		await s.start();
		transport.onTextOutput?.('Hello there.');
		transport.onTextDone?.();
		const pcm = pcmFromEnvelope(PLAYED, 24000);
		provider.onAudio?.(pcm.toString('base64'), 960, 1);

		expect(sendAudio).toHaveBeenCalledWith(pcm);
		expect(feed).not.toHaveBeenCalled();
	});

	describe('double talk (inbound frames mixing user speech with the echo)', () => {
		const everywhere = { vad: true, stt: true, transport: true };
		const nowhere = { vad: false, stt: false, transport: false };
		const routesFor = (suppressed: boolean) => (suppressed ? nowhere : everywhere);

		/**
		 * Plays the reference at T0 on a session with a PCM STT provider, feeds
		 * `halves` at the loopback times, and reports which of the client VAD,
		 * STT and the transport each half reached.
		 */
		async function playThenFeed(halves: [Buffer, Buffer]) {
			const vadProcess = vi.spyOn(ClientVadDetector.prototype, 'process');
			const stt = createMockSttProvider();
			const transport = createMockTransport();
			const { session: s } = await startSession(transport, {
				echoGuard: { enabled: true },
				sttProvider: stt,
			});

			playNative(transport, pcmFromEnvelope(PLAYED, 24000), T0);
			feedEcho(s, T0, halves);

			const routes = halves.map((frame) => {
				const base64 = frame.toString('base64');
				return {
					vad: vadProcess.mock.calls.some(([data]) => data === frame),
					stt: stt.feedAudio.mock.calls.some(([sent]) => sent === base64),
					transport: transport.sendAudio.mock.calls.some(([sent]) => sent === base64),
				};
			});
			return { routes, echoSuppressed: s.getDiagnostics().echoSuppressed };
		}

		it('an echo-dominant mix is suppressed before the VAD, STT and the transport', async () => {
			const halves = mixedHalves(0.9);
			const decisions = guardDecisions(halves);
			// One correlated window only starts the streak; the second half is echo.
			expect(decisions).toEqual([false, true]);

			const { routes, echoSuppressed } = await playThenFeed(halves);
			expect(routes).toEqual(decisions.map(routesFor));
			expect(echoSuppressed).toBe(1);
		});

		it('a speech-dominant mix passes and reaches the VAD, STT and the transport', async () => {
			const halves = mixedHalves(0.2);
			const decisions = guardDecisions(halves);
			expect(decisions).toEqual([false, false]);

			const { routes, echoSuppressed } = await playThenFeed(halves);
			expect(routes).toEqual(decisions.map(routesFor));
			expect(echoSuppressed).toBe(0);
		});

		it('documented limitation: under strong echo, overlapping user speech is suppressed with it', async () => {
			// The user talks over the model as loudly as its echo. The guard admits
			// the same speech on its own, but mixed with the echo the frame still
			// tracks the played envelope, so the user's words are dropped with the
			// echo. This double-talk cost is why the guard is opt-in; it is asserted
			// here so that any change to it is a visible decision.
			expect(guardDecisions(mixedHalves(0))).toEqual([false, false]);
			const halves = mixedHalves(0.5);
			const decisions = guardDecisions(halves);
			expect(decisions).toEqual([false, true]);

			const { routes, echoSuppressed } = await playThenFeed(halves);
			expect(routes).toEqual(decisions.map(routesFor));
			expect(echoSuppressed).toBe(1);
		});
	});
});
