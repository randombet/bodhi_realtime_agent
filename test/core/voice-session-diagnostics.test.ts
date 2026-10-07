import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import { OpenAIRealtimeTransport } from '../../src/transport/openai-realtime-transport.js';
import { QwenRealtimeTransport } from '../../src/transport/qwen-realtime-transport.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { EventPayloadMap } from '../../src/types/events.js';
import type {
	AudioFormatSpec,
	ConnectionLifecycleEvent,
	LLMTransport,
	TransportCapabilities,
	TransportUsageMetadata,
} from '../../src/types/transport.js';

declare module '@google/genai' {
	function _getMessageHandler(): ((message: unknown) => void) | null;
}

// Mock the external deps
vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					// Fire setupComplete so connect() resolves (it awaits this)
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					return {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
				}),
			},
		})),
		_getMessageHandler: () => messageHandler,
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

/** A complete injected transport that declares none of the diagnostics hooks. */
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

/** Fire a server message on the default Gemini transport's live socket. */
async function fireGeminiMessage(msg: unknown): Promise<void> {
	const { _getMessageHandler } = await import('@google/genai');
	const fire = _getMessageHandler();
	if (!fire) throw new Error('no live Gemini socket');
	fire(msg);
}

describe('VoiceSession diagnostics', () => {
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

	// Reachability: diagnostics must be readable from the session a caller
	// actually holds, fed by real audio through the client-boundary entry point.
	it('getDiagnostics reflects audio sent through the client path', async () => {
		const { session } = createDefaultSession();
		await session.start();

		const before = session.getDiagnostics();
		expect(before.transportGeneration).toBe(1);
		expect(before.echoSuppressed).toBe(0);
		expect(before.upstream?.audio.attempted).toBe(0);

		// The host-owned channel's audio seam — production audio entry.
		session.feedAudioFromClient(Buffer.alloc(320));

		const after = session.getDiagnostics();
		expect(after.upstream?.audio.attempted).toBe(1);
		expect(after.upstream?.audio.queued).toBe(1);
		expect(after.upstream?.audio.queuedRawBytes).toBe(320);
		expect(after.upstream?.audio.lastQueuedAt).not.toBeNull();
	});

	it('getDiagnostics reports null upstream for a transport without diagnostics', () => {
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

		expect(session.getDiagnostics()).toEqual({
			upstream: null,
			transportGeneration: null,
			echoSuppressed: 0,
		});
		// Nothing configured, nothing to warn about.
		expect(warnings(log)).toEqual([]);
	});

	it('surfaces connection-lifecycle events through the default VoiceSession path', async () => {
		const events: ConnectionLifecycleEvent[] = [];
		const { session, log } = createDefaultSession({
			onConnectionLifecycle: (e) => events.push(e),
		});
		await session.start();

		expect(events.map((e) => e.kind)).toEqual(['attempt', 'setup-ok']);
		expect(events[1]).toMatchObject({ connectAttemptId: 'att_1', transportGeneration: 1 });
		// The Gemini transport declares the hooks: no construction warning.
		expect(warnings(log)).toEqual([]);
	});

	// A caller using the DEFAULT constructor must be able to observe usage.
	// Asserting on a concrete transport's property would pass while VoiceSession
	// never wired it.
	it('surfaces usage metadata through the default new VoiceSession(...) path', async () => {
		const onUsageMetadata = vi.fn();
		const { session } = createDefaultSession({ onUsageMetadata });
		await session.start();

		const usage = { promptTokenCount: 4096, totalTokenCount: 4200 };
		await fireGeminiMessage({ usageMetadata: usage });

		expect(onUsageMetadata).toHaveBeenCalledWith(usage);
	});

	it('does not wire usage metadata when no callback is supplied', async () => {
		const { session } = createDefaultSession();
		await session.start();

		const transport = (session as unknown as { transport: LLMTransport }).transport;
		expect(transport.onUsageMetadata).toBeUndefined();
		expect(transport.onConnectionLifecycle).toBeUndefined();
		// Must not throw with nothing wired.
		await expect(fireGeminiMessage({ usageMetadata: { promptTokenCount: 1 } })).resolves.toBe(
			undefined,
		);
	});

	it('a throwing config usage callback stops neither `realtime.usage` nor audio delivery', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onUsageMetadata = vi.fn(() => {
			throw new Error('metrics failed');
		});
		const { session, clientSender } = createDefaultSession({ onUsageMetadata });
		const published: EventPayloadMap['realtime.usage'][] = [];
		session.eventBus.subscribe('realtime.usage', (p) => published.push(p));
		await session.start();

		await fireGeminiMessage({
			usageMetadata: { promptTokenCount: 7, responseTokenCount: 1, totalTokenCount: 8 },
			serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
		});

		expect(onUsageMetadata).toHaveBeenCalledTimes(1);
		expect(published).toHaveLength(1);
		expect(published[0].usage).toMatchObject({ provider: 'gemini_live', inputTokens: 7 });
		expect(clientSender.sendAudio).toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('onUsageMetadata observer threw'),
			expect.any(Error),
		);
		warn.mockRestore();
	});

	it('a throwing `hooks.onRealtimeLLMUsage` does not stop the publish', async () => {
		const onError = vi.fn();
		const { session, clientSender } = createDefaultSession({
			hooks: {
				onRealtimeLLMUsage: () => {
					throw new Error('hook failed');
				},
				onError,
			},
		});
		const published: EventPayloadMap['realtime.usage'][] = [];
		session.eventBus.subscribe('realtime.usage', (p) => published.push(p));
		await session.start();

		await fireGeminiMessage({
			usageMetadata: { promptTokenCount: 7, responseTokenCount: 1, totalTokenCount: 8 },
			serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } },
		});

		expect(published).toHaveLength(1);
		expect(clientSender.sendAudio).toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'hook.onRealtimeLLMUsage' }),
		);
	});

	it('a transport without the hooks yields null diagnostics and one construction warning', () => {
		const log = vi.fn();
		const onConnectionLifecycle = vi.fn();
		const onUsageMetadata = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_diag_unsupported',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			model: mockModel,
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			transport: createBareTransport(),
			onConnectionLifecycle,
			onUsageMetadata,
			log,
		});

		const warned = warnings(log);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain('onConnectionLifecycle and onUsageMetadata configured');
		expect(warned[0]).toContain('declares neither');
		expect(warned[0]).toContain('they are not expected to fire');
		expect(session.getDiagnostics()).toEqual({
			upstream: null,
			transportGeneration: null,
			echoSuppressed: 0,
		});
	});

	it('the OpenAI and Qwen transports declare no hooks: one warning naming the configured callback', async () => {
		// Fresh transports per callback: wiring a callback creates the member, so a
		// reused instance would no longer look undeclared to the next session.
		for (const callback of ['onConnectionLifecycle', 'onUsageMetadata'] as const) {
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
					[callback]: vi.fn(),
					log,
				});
				try {
					const warned = warnings(log);
					expect(warned).toHaveLength(1);
					expect(warned[0]).toContain(`${callback} configured`);
					expect(warned[0]).toContain('it is not expected to fire');
					expect(s.getDiagnostics()).toEqual({
						upstream: null,
						transportGeneration: null,
						echoSuppressed: 0,
					});
				} finally {
					await s.close();
				}
			}
		}
	});

	it('config callbacks chain over handlers a pre-configured transport already attached', () => {
		const log = vi.fn();
		const preLifecycle = vi.fn(() => {
			throw new Error('pre-attached failed');
		});
		const preUsage = vi.fn();
		const transport: LLMTransport = {
			...createBareTransport(),
			onConnectionLifecycle: preLifecycle,
			onUsageMetadata: preUsage,
		};
		const lifecycle: ConnectionLifecycleEvent[] = [];
		const usage: TransportUsageMetadata[] = [];
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
			onUsageMetadata: (u) => usage.push(u),
			log,
		});

		const attempt: ConnectionLifecycleEvent = {
			kind: 'attempt',
			connectAttemptId: 'att_1',
			handleSupplied: false,
		};
		transport.onConnectionLifecycle?.(attempt);
		transport.onUsageMetadata?.({ promptTokenCount: 3 });

		expect(preLifecycle).toHaveBeenCalledWith(attempt);
		expect(lifecycle).toEqual([attempt]); // a throwing pre-attached handler does not block it
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('pre-attached onConnectionLifecycle threw: pre-attached failed'),
		);
		expect(preUsage).toHaveBeenCalledWith({ promptTokenCount: 3 });
		expect(usage).toEqual([{ promptTokenCount: 3 }]);
		// The transport declares the hooks: no construction warning.
		expect(warnings(log)).toEqual([]);
	});
});
