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
 * Plumbing verification — `VoiceSessionConfig.greetingInterruptible: false`
 * arms full-greeting suppression in the GreetingController at sendGreeting,
 * and `finalizeTurn` (the greeting turn's post-playback finalization) releases
 * it. Default (flag omitted) keeps today's behavior: no suppression beyond the
 * grace window.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: [],
		greeting: 'Hello there!',
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

describe('VoiceSession greetingInterruptible plumbing', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	function logContains(needle: string): boolean {
		return logSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes(needle));
	}

	async function greetThenCompleteTurn(opts: { greetingInterruptible?: boolean }): Promise<void> {
		const transport = createMockTransport();
		const session = new VoiceSession({
			sessionId: 'sess_uninterruptible',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			...(opts.greetingInterruptible !== undefined && {
				greetingInterruptible: opts.greetingInterruptible,
			}),
		});
		try {
			await session.start();
			session.notifyClientConnected();
			transport.onSessionReady?.('mock_session');
			// Allow the memory-ready → sendGreeting microtask chain to settle.
			await new Promise((r) => setTimeout(r, 10));
			// Greeting response output creates the turn, then completes.
			transport.onTextOutput?.('Hello there!');
			transport.onTurnComplete?.();
			await new Promise((r) => setTimeout(r, 10));
		} finally {
			await session.close();
		}
	}

	it('greetingInterruptible: false — suppression arms at sendGreeting and releases at turn finalization', async () => {
		await greetThenCompleteTurn({ greetingInterruptible: false });
		expect(logContains('greeting finished — interrupt suppression released')).toBe(true);
	});

	it('default (flag omitted) — no full-greeting suppression is armed', async () => {
		await greetThenCompleteTurn({});
		expect(logContains('greeting finished — interrupt suppression released')).toBe(false);
	});
});

describe('H1 turn-bound release hardening (Phase 3)', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
		vi.useRealTimers();
	});

	const released = () =>
		logSpy.mock.calls.some(
			([m]) => typeof m === 'string' && m.includes('interrupt suppression released'),
		);

	async function gatedSession() {
		const transport = createMockTransport();
		const session = new VoiceSession({
			sessionId: 'sess_h1',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			greetingInterruptible: false,
		});
		await session.start();
		session.notifyClientConnected();
		transport.onSessionReady?.('mock_session');
		await vi.advanceTimersByTimeAsync(10);
		return { session, transport };
	}

	it("the greeting turn's own INTERRUPTED finalization releases (provider truncation must not deafen)", async () => {
		const { session, transport } = await gatedSession();
		try {
			transport.onModelTurnStart?.(); // greeting turn starts → binds
			transport.onAudioOutput?.(Buffer.alloc(4800).toString('base64'));
			transport.onInterrupted?.(); // provider truncates the greeting
			await vi.advanceTimersByTimeAsync(10);
			expect(released()).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('typed input pre-empts and releases even PRE-TURN (before any model turn exists)', async () => {
		const { session } = await gatedSession();
		try {
			await (session as unknown as { handleTextInput(t: string): Promise<void> }).handleTextInput(
				'hello',
			);
			await vi.advanceTimersByTimeAsync(10);
			expect(released()).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('a greeting whose response never starts hits the no-start timeout and releases (no deaf session)', async () => {
		const { session } = await gatedSession();
		try {
			// No model turn, no terminal — advance past the no-start timeout.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(released()).toBe(true);
		} finally {
			await session.close();
		}
	});
});

describe('coordinator enforcement: assistant-initiated triggers (P1-2)', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
		vi.useRealTimers();
	});

	const released = () =>
		logSpy.mock.calls.some(
			([m]) => typeof m === 'string' && m.includes('interrupt suppression released'),
		);

	it('guardedTriggerGeneration invalidates a live greeting token — its turn must not bind as the greeting', async () => {
		const transport = createMockTransport();
		const session = new VoiceSession({
			sessionId: 'sess_h1_trigger',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			greetingInterruptible: false,
		});
		try {
			await session.start();
			session.notifyClientConnected();
			transport.onSessionReady?.('mock_session');
			await vi.advanceTimersByTimeAsync(10); // greeting sent → token live

			session.guardedTriggerGeneration('proactively check in with the user');
			await vi.advanceTimersByTimeAsync(10);
			expect(released()).toBe(true);
		} finally {
			await session.close();
		}
	});
});
