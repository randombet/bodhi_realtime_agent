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
 * Phase-1 step 1.5: the shadow comparator runs BOTH Phase-2 policies beside
 * the live Phase-0 decisions, classifies enumerated expected divergences
 * (the provider-forced retention fix), and surfaces observable counters —
 * no actuation from policy verdicts in this phase.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

interface ShadowCounters {
	compared: number;
	expected: number;
	unexpected: number;
}

function createTransport(): LLMTransport {
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

function micFrame(amplitude: number): Buffer {
	const f = Buffer.alloc(480 * 2);
	for (let i = 0; i < f.length; i += 2) f.writeInt16LE(amplitude, i);
	return f;
}

function makeSession(opts: { replayRecovery?: boolean; greetingInterruptible?: boolean } = {}) {
	const transport = createTransport();
	const session = new VoiceSession({
		sessionId: 'sess_shadow',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [
			{
				name: 'main',
				instructions: 'x',
				tools: [],
				...(opts.greetingInterruptible === false ? { greeting: 'Hello there!' } : {}),
			} as MainAgent,
		],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		clientAudioVad: { bargeInConfirmMs: 0 },
		responseWatchdogMs: 8000,
		...(opts.replayRecovery ? { watchdogReplayRecovery: true } : {}),
		...(opts.greetingInterruptible !== undefined
			? { greetingInterruptible: opts.greetingInterruptible }
			: {}),
	});
	const counters = () =>
		(
			session as unknown as { getSpeechEvidenceShadowCounters(): ShadowCounters }
		).getSpeechEvidenceShadowCounters();
	return { session, transport, counters };
}

async function activate(session: VoiceSession, transport: LLMTransport, withClient = false) {
	await session.start();
	if (withClient) session.notifyClientConnected();
	transport.onSessionReady?.('mock_session');
	await vi.advanceTimersByTimeAsync(10);
}

function completeUserTurn(session: VoiceSession) {
	session.feedAudioFromClient(micFrame(2400));
	vi.advanceTimersByTime(150);
	session.feedAudioFromClient(micFrame(2400));
	vi.advanceTimersByTime(500);
	session.feedAudioFromClient(micFrame(0));
}

describe('speech-evidence shadow comparator', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('a routed default-config segment compares clean (no divergences)', async () => {
		const { session, transport, counters } = makeSession({ replayRecovery: true });
		try {
			await activate(session, transport);
			completeUserTurn(session);
			expect(counters().compared).toBe(1);
			expect(counters().expected).toBe(0);
			expect(counters().unexpected).toBe(0);
		} finally {
			await session.close();
		}
	});

	it('a fully gated segment compares clean (both live and policy skip)', async () => {
		const { session, transport, counters } = makeSession({
			replayRecovery: true,
			greetingInterruptible: false,
		});
		try {
			await activate(session, transport, true);
			transport.onModelTurnStart?.(); // greeting response begins
			completeUserTurn(session); // all voiced frames gated
			expect(counters().compared).toBeGreaterThan(0);
			expect(counters().unexpected).toBe(0);
		} finally {
			await session.close();
		}
	});

	it('a provider-forced routed segment actuates the policy abort (Phase-2 re-bind: no divergence, no re-seal)', async () => {
		const { session, transport, counters } = makeSession({ replayRecovery: true });
		try {
			await activate(session, transport);
			// Open a routed voiced segment, then force-complete via model start.
			session.feedAudioFromClient(micFrame(2400));
			vi.advanceTimersByTime(150);
			session.feedAudioFromClient(micFrame(2400));
			transport.onModelTurnStart?.(); // complete('provider-recognition')
			expect(counters().compared).toBe(1);
			// Actuation IS the policy verdict now — the formerly-expected
			// divergence class is gone by construction.
			expect(counters().expected).toBe(0);
			expect(counters().unexpected).toBe(0);
			const retainer = (session as unknown as { utteranceRetainer?: { peek(m: number): unknown } })
				.utteranceRetainer;
			expect(retainer?.peek(60_000) ?? null).toBeNull(); // answered speech: no candidate
		} finally {
			await session.close();
		}
	});
});

describe('provider evidence live wiring (P2-5)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('transport-declared kinds reach the ledger and onProviderEvidence feeds it', async () => {
		const transport = createTransport();
		(transport as { capabilities: LLMTransport['capabilities'] }).capabilities = {
			...transport.capabilities,
			providerEvidenceKinds: ['speech-window'],
		};
		const session = new VoiceSession({
			sessionId: 'sess_provider_live',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [{ name: 'main', instructions: 'x', tools: [] } as MainAgent],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			clientAudioVad: { bargeInConfirmMs: 0 },
		});
		try {
			await activate(session, transport);
			const ledger = (
				session as unknown as {
					userTurnEvidence: {
						getActiveSnapshot(): { providerDetected: string } | null;
						getTerminalSnapshot(id: number): { providerDetected: string } | null;
					};
				}
			).userTurnEvidence;

			const t0 = Date.now();
			session.feedAudioFromClient(micFrame(2400));
			vi.advanceTimersByTime(150);
			session.feedAudioFromClient(micFrame(2400));
			// Declared capability ⇒ observable-but-uncorrelated, not not-observable.
			expect(ledger.getActiveSnapshot()?.providerDetected).toBe('unknown');
			vi.advanceTimersByTime(500);
			session.feedAudioFromClient(micFrame(0)); // silence terminal

			// The transport's adapter reports a provider VAD window over the
			// same interval — delivered through the live callback.
			transport.onProviderEvidence?.({
				kind: 'speech-window',
				receiptAtMs: Date.now(),
				windowStartAtMs: t0,
				windowEndAtMs: t0 + 200,
				provenance: 'test-adapter',
				correlation: 'heuristic',
			});
			expect(ledger.getTerminalSnapshot(1)?.providerDetected).toBe('observed');
		} finally {
			await session.close();
		}
	});
});
