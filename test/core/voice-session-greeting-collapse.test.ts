import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { MemoryFact, MemoryStore } from '../../src/types/memory.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

/**
 * Phase B5 verification — sendGreeting() collapses memory facts + session
 * directives + greeting into ONE sendContent call.
 * See dev_docs/framework/design-greeting-interrupt-grace.md §6.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(greeting = 'Hello there!'): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: [],
		greeting,
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

function createInMemoryStore(facts: MemoryFact[] = []): MemoryStore {
	const data = new Map<string, MemoryFact[]>();
	return {
		addFacts: async (userId, newFacts) => {
			data.set(userId, [...(data.get(userId) ?? []), ...newFacts]);
		},
		getAll: async (userId) => data.get(userId) ?? [...facts],
		replaceAll: async (userId, replacement) => {
			data.set(userId, [...replacement]);
		},
		getDirectives: async () => ({}),
		setDirectives: async () => {},
	};
}

describe('VoiceSession.sendGreeting memory-fact collapse', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	async function buildAndGreet(facts: MemoryFact[]): Promise<{
		sendContentCalls: unknown[][];
	}> {
		const transport = createMockTransport();
		// Keep a reference to the ORIGINAL mock; VoiceSession wraps
		// transport.sendContent with a passthrough that still calls the
		// original, so we observe via the captured ref.
		const sendContentMock = transport.sendContent as ReturnType<typeof vi.fn>;
		const session = new VoiceSession({
			sessionId: 'sess_greeting',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			...(facts.length > 0 && { memory: { store: createInMemoryStore(facts) } }),
		});
		try {
			await session.start();
			// Mark the client connected so handleSetupComplete's
			// `if (this.clientConnected)` branch fires sendGreeting.
			session.notifyClientConnected();
			// Drive onSessionReady to fire sendGreeting via the memoryReady chain.
			transport.onSessionReady?.('mock_session');
			// Allow memory cache refresh + greeting microtask chain to settle.
			await new Promise((r) => setTimeout(r, 10));
			return { sendContentCalls: sendContentMock.mock.calls };
		} finally {
			await session.close();
		}
	}

	it('with NO memory facts: one sendContent call, plain greeting text', async () => {
		const { sendContentCalls } = await buildAndGreet([]);
		expect(sendContentCalls).toHaveLength(1);
		const [turns, turnComplete] = sendContentCalls[0] as [
			Array<{ role: string; text: string }>,
			boolean,
		];
		expect(turnComplete).toBe(true);
		expect(turns).toHaveLength(1);
		expect(turns[0].role).toBe('user');
		// No memory prefix, just the greeting text (no session directives by default).
		expect(turns[0].text).toBe('Hello there!');
	});

	it('with memory facts: still EXACTLY one sendContent call (no separate memory turn)', async () => {
		const { sendContentCalls } = await buildAndGreet([
			{ content: 'Prefers concise responses', category: 'preference', timestamp: 0 },
			{ content: 'Works as a data scientist', category: 'entity', timestamp: 0 },
		]);
		expect(sendContentCalls).toHaveLength(1);
		const [turns, turnComplete] = sendContentCalls[0] as [
			Array<{ role: string; text: string }>,
			boolean,
		];
		expect(turnComplete).toBe(true);
		expect(turns).toHaveLength(1);
		expect(turns[0].role).toBe('user');
		// Memory prefix is present and is *prepended* to the greeting.
		expect(turns[0].text).toContain('[MEMORY');
		expect(turns[0].text).toContain('Prefers concise responses');
		expect(turns[0].text).toContain('Works as a data scientist');
		expect(turns[0].text.endsWith('Hello there!')).toBe(true);
	});
});
