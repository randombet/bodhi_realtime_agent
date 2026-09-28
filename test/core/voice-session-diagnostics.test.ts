import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import { OpenAIRealtimeTransport } from '../../src/transport/openai-realtime-transport.js';
import { QwenRealtimeTransport } from '../../src/transport/qwen-realtime-transport.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	ConnectionLifecycleEvent,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

// Mock the external deps
vi.mock('@google/genai', () => {
	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					const messageHandler = cbs.onmessage as (msg: unknown) => void;
					// Fire setupComplete so connect() resolves (it awaits this)
					setTimeout(() => messageHandler({ setupComplete: { sessionId: 'gs_1' } }), 5);
					return {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
				}),
			},
		})),
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({ text: 'subagent done' })),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createEchoAgent(): MainAgent {
	return {
		name: 'echo',
		instructions: 'You are an echo agent',
		tools: [],
	};
}

/** A complete injected transport that does not declare the lifecycle hook. */
function createBareTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: false,
			contextCompression: false,
			groundingMetadata: false,
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

describe('VoiceSession connection lifecycle', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	/** A default-path (built-in Gemini transport) session on a host-owned channel. */
	function createDefaultSession(overrides: Partial<VoiceSessionConfig> = {}) {
		const log = vi.fn();
		const clientSender = { sendAudio: vi.fn(), sendJson: vi.fn() };
		session = new VoiceSession({
			sessionId: 'sess_diag',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			model: mockModel,
			clientSender,
			log,
			...overrides,
		});
		return { session, log, clientSender };
	}

	function warnings(log: ReturnType<typeof vi.fn>): string[] {
		return log.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('[WARN]'));
	}

	it('surfaces connection-lifecycle events through the default VoiceSession path', async () => {
		const events: ConnectionLifecycleEvent[] = [];
		const { session, log } = createDefaultSession({
			onConnectionLifecycle: (e) => events.push(e),
		});
		await session.start();

		expect(events.map((e) => e.kind)).toEqual(['attempt', 'setup-ok']);
		expect(events[1]).toMatchObject({ connectAttemptId: 'att_1', transportGeneration: 1 });
		// The Gemini transport declares the hook: no construction warning.
		expect(warnings(log)).toEqual([]);
	});

	it('does not wire the lifecycle hook when no callback is supplied', async () => {
		const { session } = createDefaultSession();
		await session.start();

		const transport = (session as unknown as { transport: LLMTransport }).transport;
		expect(transport.onConnectionLifecycle).toBeUndefined();
	});

	it('a transport without the hook and no callback configured logs no warning', () => {
		const log = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_diag_bare',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			model: mockModel,
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			transport: createBareTransport(),
			log,
		});

		// Nothing configured, nothing to warn about.
		expect(warnings(log)).toEqual([]);
	});

	it('a transport without the hook logs one construction warning', () => {
		const log = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_diag_unsupported',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			model: mockModel,
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			transport: createBareTransport(),
			onConnectionLifecycle: vi.fn(),
			log,
		});

		const warned = warnings(log);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain('onConnectionLifecycle configured');
		expect(warned[0]).toContain('does not declare onConnectionLifecycle');
		expect(warned[0]).toContain('it is not expected to fire');
	});

	it('the OpenAI and Qwen transports do not declare the hook: one warning naming the configured callback', async () => {
		const transports: LLMTransport[] = [
			new OpenAIRealtimeTransport({ apiKey: 'test-key', model: 'gpt-realtime' }),
			new QwenRealtimeTransport({ apiKey: 'test-key' }),
		];
		for (const transport of transports) {
			const log = vi.fn();
			const s = new VoiceSession({
				sessionId: 'sess_diag_provider',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createEchoAgent()],
				initialAgent: 'echo',
				model: mockModel,
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				transport,
				onConnectionLifecycle: vi.fn(),
				log,
			});
			try {
				const warned = warnings(log);
				expect(warned).toHaveLength(1);
				expect(warned[0]).toContain('onConnectionLifecycle configured');
				expect(warned[0]).toContain('it is not expected to fire');
			} finally {
				await s.close();
			}
		}
	});

	it('the config callback chains over a handler a pre-configured transport already attached', () => {
		const log = vi.fn();
		const preLifecycle = vi.fn(() => {
			throw new Error('pre-attached failed');
		});
		const transport: LLMTransport = {
			...createBareTransport(),
			onConnectionLifecycle: preLifecycle,
		};
		const lifecycle: ConnectionLifecycleEvent[] = [];
		session = new VoiceSession({
			sessionId: 'sess_diag_chain',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			model: mockModel,
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			transport,
			onConnectionLifecycle: (e) => lifecycle.push(e),
			log,
		});

		const attempt: ConnectionLifecycleEvent = {
			kind: 'attempt',
			connectAttemptId: 'att_1',
			handleSupplied: false,
		};
		transport.onConnectionLifecycle?.(attempt);

		expect(preLifecycle).toHaveBeenCalledWith(attempt);
		expect(lifecycle).toEqual([attempt]); // a throwing pre-attached handler does not block it
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('pre-attached onConnectionLifecycle threw: pre-attached failed'),
		);
		// The transport declares the hook: no construction warning.
		expect(warnings(log)).toEqual([]);
	});
});
