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
