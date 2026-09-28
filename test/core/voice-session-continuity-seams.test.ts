import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SessionError } from '../../src/core/errors.js';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import { InMemoryPostSessionPipeline } from '../../src/post-session/pipeline.js';
import { type PostSessionContext, PostSessionProcessor } from '../../src/post-session/types.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ConversationItem } from '../../src/types/conversation.js';
import type {
	ConversationHistoryStore,
	SessionRecord,
	SessionReport,
} from '../../src/types/history.js';
import type { MemoryStore } from '../../src/types/memory.js';
import type { AudioOutputObserver } from '../../src/types/session-seams.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	STTProvider,
	TransportCapabilities,
} from '../../src/types/transport.js';

/**
 * Continuity and extension seams on VoiceSession: `resetConversationContext`
 * (flush, seal, persist once, then clear), the session-owned `SessionManager`,
 * whose `reset()` refuses once the session is finalized, the audio observers
 * and output interceptor, and the runtime tool and instruction updates. Runs
 * on the built-in Gemini transport over a mocked SDK, or on a stub transport,
 * with a host-owned client sender, so no port is bound.
 */

declare module '@google/genai' {
	function _getMessageHandler(): ((message: unknown) => void) | null;
	function _getConnectConfigs(): Record<string, unknown>[];
}

vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	const connectConfigs: Record<string, unknown>[] = [];

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					connectConfigs.push(params.config as Record<string, unknown>);
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
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
		_getConnectConfigs: () => connectConfigs,
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({ text: 'mock' })),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function makeAgent(): MainAgent {
	return { name: 'echo', instructions: 'test', tools: [] };
}

function makeFakeStore(): {
	store: ConversationHistoryStore;
	addItems: ReturnType<typeof vi.fn>;
	saveSessionReport: ReturnType<typeof vi.fn>;
} {
	const addItems = vi.fn(async (_id: string, _items: ConversationItem[]) => {});
	const saveSessionReport = vi.fn(async (_report: SessionReport) => {});
	const store: ConversationHistoryStore = {
		createSession: vi.fn(async (_s: SessionRecord) => {}),
		updateSession: vi.fn(async () => {}),
		addItems,
		saveSessionReport,
		getSession: vi.fn(async () => null),
		getSessionItems: vi.fn(async () => []),
		listUserSessions: vi.fn(async () => []),
	};
	return { store, addItems, saveSessionReport };
}

function makeMemoryStore(): MemoryStore {
	return {
		addFacts: vi.fn(async () => {}),
		getAll: vi.fn(async () => []),
		replaceAll: vi.fn(async () => {}),
		getDirectives: vi.fn(async () => ({})),
		setDirectives: vi.fn(async () => {}),
	};
}

function makeSttProvider(): STTProvider {
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

/** Contents of every item handed to `addItems`, in call order. */
function persistedContents(addItems: ReturnType<typeof vi.fn>): string[] {
	return addItems.mock.calls.flatMap((call) =>
		(call[1] as ConversationItem[]).map((item) => item.content),
	);
}

function settle(ms = 50): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function fire(): Promise<(msg: unknown) => void> {
	const { _getMessageHandler } = await import('@google/genai');
	const handler = _getMessageHandler();
	if (!handler) throw new Error('Gemini message handler not captured');
	return handler;
}

/** One clean model turn: user transcription, assistant transcription, completion. */
async function runTurn(user: string, assistant: string): Promise<void> {
	const send = await fire();
	send({ serverContent: { inputTranscription: { text: user } } });
	send({ serverContent: { outputTranscription: { text: assistant } } });
	send({ serverContent: { turnComplete: true } });
	await settle();
}

/** One chunk of native model audio. */
async function sendModelAudio(pcm: Buffer): Promise<void> {
	const send = await fire();
	send({
		serverContent: {
			modelTurn: {
				parts: [{ inlineData: { data: pcm.toString('base64'), mimeType: 'audio/pcm;rate=24000' } }],
			},
		},
	});
}

/** Function names declared on the most recent Gemini connect. */
async function lastConnectToolNames(): Promise<string[]> {
	const { _getConnectConfigs } = await import('@google/genai');
	const configs = _getConnectConfigs();
	const tools = (configs[configs.length - 1]?.tools ?? []) as Array<{
		functionDeclarations?: Array<{ name: string }>;
	}>;
	return tools.flatMap((entry) => entry.functionDeclarations?.map((d) => d.name) ?? []);
}

/** A GoAway after a resumable handle: the session redials the Gemini transport. */
async function reconnectUpstream(s: VoiceSession, handle: string): Promise<void> {
	const send = await fire();
	send({ sessionResumptionUpdate: { newHandle: handle, resumable: true } });
	send({ goAway: { timeLeft: '10s' } });
	await settle(100);
	expect(s.sessionManager.state).toBe('ACTIVE');
}

function makeTool(name: string, result: unknown): ToolDefinition {
	return {
		name,
		description: `The ${name} tool`,
		parameters: z.object({}),
		execution: 'inline',
		execute: async () => result,
	};
}

function createStubTransport(): {
	transport: LLMTransport;
	updateSession: ReturnType<typeof vi.fn>;
	sendToolResult: ReturnType<typeof vi.fn>;
} {
	const updateSession = vi.fn(async () => {});
	const sendToolResult = vi.fn();
	const transport: LLMTransport = {
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
		updateSession,
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult,
		triggerGeneration: vi.fn(),
		elicitResponse: vi.fn(),
	};
	return { transport, updateSession, sendToolResult };
}

describe('VoiceSession continuity seams', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	function createSession(overrides: Partial<VoiceSessionConfig> = {}): VoiceSession {
		session = new VoiceSession({
			sessionId: 'sess_continuity',
			userId: 'u_1',
			apiKey: 'test-key',
			agents: [makeAgent()],
			initialAgent: 'echo',
			model: mockModel,
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			log: () => {},
			...overrides,
		});
		return session;
	}

	describe('resetConversationContext', () => {
		it('persists both turns once, empties the items, and leaves only post-reset items for the close report and post-session snapshot', async () => {
			const { store, addItems, saveSessionReport } = makeFakeStore();
			let snapshotItems: string[] | undefined;
			class CaptureProcessor extends PostSessionProcessor {
				readonly name = 'capture';
				async run(ctx: PostSessionContext) {
					snapshotItems = ctx.conversation.items.map((item) => item.content);
				}
			}
			const pipeline = new InMemoryPostSessionPipeline();
			pipeline.register(new CaptureProcessor());
			pipeline.freeze();
			const logs: string[] = [];
			const s = createSession({
				conversationHistoryStore: store,
				postSessionPipeline: pipeline,
				drainPostSession: true,
				log: (line) => logs.push(line),
			});
			await s.start();
			await settle();

			await runTurn('Hello', 'Hi there');
			await runTurn('How are you', 'Fine, thanks');
			expect(persistedContents(addItems)).toEqual([
				'Hello',
				'Hi there',
				'How are you',
				'Fine, thanks',
			]);

			const { cleared } = s.resetConversationContext('topic change');

			expect(cleared).toBe(4);
			expect(s.conversationContext.items).toEqual([]);
			expect(logs.some((line) => line.includes('[WARN]'))).toBe(false);

			await runTurn('New topic', 'Sure');
			await s.close();
			session = null;

			expect(persistedContents(addItems)).toEqual([
				'Hello',
				'Hi there',
				'How are you',
				'Fine, thanks',
				'New topic',
				'Sure',
			]);
			expect(snapshotItems).toEqual(['New topic', 'Sure']);
			const report = saveSessionReport.mock.calls[0][0] as SessionReport;
			expect(report.items.map((item) => item.content)).toEqual(['New topic', 'Sure']);
		});

		it('flushes a buffered partial assistant transcript into the history store before clearing', async () => {
			const { store, addItems, saveSessionReport } = makeFakeStore();
			const s = createSession({ conversationHistoryStore: store });
			await s.start();
			await settle();

			await runTurn('Hello', 'Hi there');
			// The model is mid-reply: its transcript is still buffered, not yet an item.
			const send = await fire();
			send({ serverContent: { outputTranscription: { text: 'Once upon a time' } } });
			await settle();
			expect(s.conversationContext.items.map((item) => item.content)).toEqual([
				'Hello',
				'Hi there',
			]);

			const { cleared } = s.resetConversationContext('reset mid-reply');
			await settle();

			expect(cleared).toBe(3);
			expect(s.conversationContext.items).toEqual([]);
			expect(persistedContents(addItems)).toEqual(['Hello', 'Hi there', 'Once upon a time']);

			await runTurn('New topic', 'Sure');
			await s.close();
			session = null;

			expect(persistedContents(addItems)).toEqual([
				'Hello',
				'Hi there',
				'Once upon a time',
				'New topic',
				'Sure',
			]);
			const report = saveSessionReport.mock.calls[0][0] as SessionReport;
			expect(report.items.map((item) => item.content)).toEqual(['New topic', 'Sure']);
		});

		it('seals a pending STT reservation with its fallback text and persists it before clearing', async () => {
			const { store, addItems } = makeFakeStore();
			const s = createSession({ conversationHistoryStore: store, sttProvider: makeSttProvider() });
			await s.start();
			await settle();

			// Only the transport's own transcription arrives before the turn ends, so the
			// user message is reserved and holds back everything from it onwards.
			await runTurn('what time is it', 'It is noon.');
			expect(s.conversationContext.hasPendingUserMessages).toBe(true);
			expect(persistedContents(addItems)).toEqual([]);

			const { cleared } = s.resetConversationContext('reset with a pending transcript');
			await settle();

			expect(cleared).toBe(2);
			expect(s.conversationContext.items).toEqual([]);
			expect(s.conversationContext.hasPendingUserMessages).toBe(false);
			expect(persistedContents(addItems)).toEqual(['what time is it', 'It is noon.']);
			const timers = (s as unknown as { reservationTimers: Map<number, unknown> })
				.reservationTimers;
			expect(timers.size).toBe(0);
		});

		it('logs the in-flight memory extraction warning when memory is configured', () => {
			const logs: string[] = [];
			const s = createSession({
				memory: { store: makeMemoryStore() },
				log: (line) => logs.push(line),
			});

			expect(s.resetConversationContext('memory configured')).toEqual({ cleared: 0 });

			const warning = logs.find((line) => line.includes('[WARN] resetConversationContext'));
			expect(warning).toContain('memory extraction in flight');
			expect(warning).toContain('never appended to the history store');
		});
	});

	describe('session-owned SessionManager.reset()', () => {
		it('resets before start() and throws a guided SessionError once close() has run', async () => {
			const s = createSession();

			s.sessionManager.reset();
			expect(s.sessionManager.state).toBe('CREATED');

			await s.close();
			session = null;

			expect(() => s.sessionManager.reset()).toThrow(SessionError);
			expect(() => s.sessionManager.reset()).toThrow(/managed/);
			expect(s.sessionManager.state).toBe('CLOSED');
		});
	});

	describe('audio observers and the output interceptor', () => {
		const chunk = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);

		it('observeAudioOutput receives decoded PCM with the turn id before the sender, until unsubscribed', async () => {
			const order: string[] = [];
			const sendAudio = vi.fn(() => {
				order.push('sender');
			});
			const s = createSession({ clientSender: { sendAudio, sendJson: vi.fn() } });
			const seen: Array<{ pcm: Buffer; meta: Parameters<AudioOutputObserver>[1] }> = [];
			const unsubscribe = s.observeAudioOutput((pcm, meta) => {
				order.push('observer');
				seen.push({ pcm, meta });
			});
			const turnEnds: string[] = [];
			s.eventBus.subscribe('turn.end', (payload) => turnEnds.push(payload.turnId));
			await s.start();
			await settle();

			await sendModelAudio(chunk);

			expect(order).toEqual(['observer', 'sender']);
			expect(seen).toHaveLength(1);
			expect(seen[0].pcm).toEqual(chunk);
			expect(seen[0].meta).toEqual({
				turnId: expect.any(String),
				sampleRate: 24000,
				encoding: 'pcm',
			});
			expect(sendAudio).toHaveBeenCalledWith(chunk);

			unsubscribe();
			await sendModelAudio(chunk);

			expect(sendAudio).toHaveBeenCalledTimes(2);
			expect(seen).toHaveLength(1);

			(await fire())({ serverContent: { turnComplete: true } });
			await settle();
			expect(turnEnds).toEqual([seen[0].meta.turnId]);
		});

		it('reports a throwing output observer through onError without blocking delivery', async () => {
			const sendAudio = vi.fn();
			const onError = vi.fn();
			const s = createSession({
				clientSender: { sendAudio, sendJson: vi.fn() },
				hooks: { onError },
			});
			const later = vi.fn();
			s.observeAudioOutput(() => {
				throw new Error('observer failed');
			});
			s.observeAudioOutput(later);
			await s.start();
			await settle();

			await sendModelAudio(chunk);

			expect(sendAudio).toHaveBeenCalledTimes(1);
			expect(later).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'audio-output-observer',
					error: expect.objectContaining({ message: 'observer failed' }),
				}),
			);
		});

		it('drops a native audio chunk before the sender when outputInterceptor.audio returns false', async () => {
			const sendAudio = vi.fn();
			const dropped = Buffer.from([9, 0, 9, 0]);
			const audio = vi.fn((chunkBase64: string) => chunkBase64 !== dropped.toString('base64'));
			const s = createSession({
				clientSender: { sendAudio, sendJson: vi.fn() },
				outputInterceptor: { audio },
			});
			const observed = vi.fn();
			s.observeAudioOutput(observed);
			await s.start();
			await settle();

			await sendModelAudio(dropped);

			expect(audio).toHaveBeenCalledWith(dropped.toString('base64'));
			expect(sendAudio).not.toHaveBeenCalled();
			expect(observed).not.toHaveBeenCalled();

			await sendModelAudio(chunk);

			expect(sendAudio).toHaveBeenCalledTimes(1);
			expect(sendAudio).toHaveBeenCalledWith(chunk);
		});

		it('commits a transcript chunk held by the interceptor and forwarded from beforeTranscriptFlush exactly once', async () => {
			const held: Array<{ text: string; forward: (text: string) => void }> = [];
			const beforeTranscriptFlush = vi.fn(() => {
				for (const entry of held.splice(0)) entry.forward(entry.text);
			});
			const s = createSession({
				outputInterceptor: {
					transcript(chunk, forward) {
						if (chunk.startsWith('[held]')) held.push({ text: chunk, forward });
						else forward(chunk);
					},
					beforeTranscriptFlush,
				},
			});
			await s.start();
			await settle();

			const send = await fire();
			send({ serverContent: { inputTranscription: { text: 'Tell me' } } });
			send({ serverContent: { outputTranscription: { text: 'Here it is ' } } });
			send({ serverContent: { outputTranscription: { text: '[held] the rest' } } });
			expect(held).toHaveLength(1);
			send({ serverContent: { turnComplete: true } });
			await settle();

			expect(beforeTranscriptFlush).toHaveBeenCalled();
			const assistant = s.conversationContext.items
				.filter((item) => item.role === 'assistant')
				.map((item) => item.content);
			expect(assistant).toEqual(['Here it is [held] the rest']);
		});

		it('reports a throwing interceptor transcript hook and forwards the original chunk unchanged', async () => {
			const onError = vi.fn();
			const s = createSession({
				hooks: { onError },
				outputInterceptor: {
					transcript(chunk, forward) {
						if (chunk.includes('secret')) throw new Error('screen failed');
						forward(chunk.toUpperCase());
					},
				},
			});
			await s.start();
			await settle();

			const send = await fire();
			send({ serverContent: { inputTranscription: { text: 'Tell me' } } });
			send({ serverContent: { outputTranscription: { text: 'hello ' } } });
			send({ serverContent: { outputTranscription: { text: 'the secret ' } } });
			send({ serverContent: { outputTranscription: { text: 'bye' } } });
			send({ serverContent: { turnComplete: true } });
			await settle();

			const assistant = s.conversationContext.items
				.filter((item) => item.role === 'assistant')
				.map((item) => item.content);
			expect(assistant).toEqual(['HELLO the secret BYE']);
			expect(onError).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'output-interceptor.transcript',
					error: expect.objectContaining({ message: 'screen failed' }),
				}),
			);
		});

		it('reports a throwing interceptor audio hook and delivers the chunk', async () => {
			const sendAudio = vi.fn();
			const onError = vi.fn();
			const s = createSession({
				clientSender: { sendAudio, sendJson: vi.fn() },
				hooks: { onError },
				outputInterceptor: {
					audio() {
						throw new Error('audio gate failed');
					},
				},
			});
			const observed = vi.fn();
			s.observeAudioOutput(observed);
			await s.start();
			await settle();

			await sendModelAudio(chunk);

			expect(sendAudio).toHaveBeenCalledTimes(1);
			expect(sendAudio).toHaveBeenCalledWith(chunk);
			expect(observed).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'output-interceptor.audio',
					error: expect.objectContaining({ message: 'audio gate failed' }),
				}),
			);
		});

		it('reports a throwing beforeTranscriptFlush and still commits the turn transcript', async () => {
			const onError = vi.fn();
			const s = createSession({
				hooks: { onError },
				outputInterceptor: {
					beforeTranscriptFlush() {
						throw new Error('release failed');
					},
				},
			});
			await s.start();
			await settle();

			await runTurn('Hello', 'Hi there');

			expect(s.conversationContext.items.map((item) => item.content)).toEqual([
				'Hello',
				'Hi there',
			]);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'output-interceptor.beforeTranscriptFlush',
					error: expect.objectContaining({ message: 'release failed' }),
				}),
			);
			expect(onError).not.toHaveBeenCalledWith(
				expect.objectContaining({ component: 'finalizeTurn' }),
			);
		});

		it('completes close() with a throwing beforeTranscriptFlush, committing the buffered reply and ending the turn', async () => {
			const { store, addItems, saveSessionReport } = makeFakeStore();
			const onError = vi.fn();
			const s = createSession({
				conversationHistoryStore: store,
				hooks: { onError },
				outputInterceptor: {
					beforeTranscriptFlush() {
						throw new Error('release failed');
					},
				},
			});
			const turnEnds: string[] = [];
			s.eventBus.subscribe('turn.end', (payload) => turnEnds.push(payload.turnId));
			await s.start();
			await settle();

			// The model is mid-reply when the session closes: its transcript is still buffered.
			const send = await fire();
			send({ serverContent: { inputTranscription: { text: 'Tell me a story' } } });
			send({ serverContent: { outputTranscription: { text: 'Once upon a time' } } });
			await settle();

			await s.close();
			session = null;

			expect(s.sessionManager.state).toBe('CLOSED');
			expect(turnEnds).toHaveLength(1);
			expect(persistedContents(addItems)).toEqual(['Tell me a story', 'Once upon a time']);
			const report = saveSessionReport.mock.calls[0][0] as SessionReport;
			expect(report.items.map((item) => item.content)).toEqual([
				'Tell me a story',
				'Once upon a time',
			]);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'output-interceptor.beforeTranscriptFlush',
					error: expect.objectContaining({ message: 'release failed' }),
				}),
			);
		});
	});

	describe('runtime tool and instruction updates', () => {
		const clockTool = makeTool('get_time', { time: 'noon' });
		const lookupTool = makeTool('lookup', { answer: 42 });

		it('registerTools makes an inline tool executable and sends the merged tool list', async () => {
			const { transport, updateSession, sendToolResult } = createStubTransport();
			const s = createSession({
				transport,
				agents: [{ name: 'echo', instructions: 'test', tools: [clockTool] }],
			});
			await s.start();
			transport.onSessionReady?.('stub_session');

			await s.registerTools([lookupTool]);

			expect(updateSession).toHaveBeenLastCalledWith({ tools: [clockTool, lookupTool] });

			transport.onToolCall?.([{ id: 'call_1', name: 'lookup', args: {} }]);
			await settle();

			expect(sendToolResult).toHaveBeenCalledWith(
				expect.objectContaining({ id: 'call_1', name: 'lookup', result: { answer: 42 } }),
			);
		});

		it('rejects registerTools, replaceTools and updateInstructions with SessionError in actor mode', async () => {
			const { transport, updateSession } = createStubTransport();
			const s = createSession({ transport, orchestrationMode: 'actor' });
			updateSession.mockClear();

			await expect(s.registerTools([lookupTool])).rejects.toThrow(SessionError);
			await expect(s.replaceTools([lookupTool])).rejects.toThrow(SessionError);
			await expect(s.updateInstructions('Be brief.')).rejects.toThrow(SessionError);

			expect(updateSession).not.toHaveBeenCalled();
		});

		it('replaceTools hides the excluded tools and a full replacement restores them, across a reconnect', async () => {
			const s = createSession({
				agents: [{ name: 'echo', instructions: 'test', tools: [clockTool, lookupTool] }],
			});
			const transport = (s as unknown as { transport: LLMTransport }).transport;
			const updateSession = vi.spyOn(transport, 'updateSession');
			await s.start();
			await settle();
			expect(await lastConnectToolNames()).toEqual(['get_time', 'lookup']);

			await s.replaceTools([clockTool]);
			expect(updateSession).toHaveBeenLastCalledWith({ tools: [clockTool] });
			await reconnectUpstream(s, 'handle_1');
			expect(await lastConnectToolNames()).toEqual(['get_time']);

			await s.replaceTools([clockTool, lookupTool]);
			expect(updateSession).toHaveBeenLastCalledWith({ tools: [clockTool, lookupTool] });
			await reconnectUpstream(s, 'handle_2');
			expect(await lastConnectToolNames()).toEqual(['get_time', 'lookup']);
		});

		it('restores the previous tool set when updateSession rejects', async () => {
			const { transport, updateSession } = createStubTransport();
			const s = createSession({
				transport,
				agents: [{ name: 'echo', instructions: 'test', tools: [clockTool] }],
			});
			updateSession.mockRejectedValueOnce(new Error('provider refused'));

			await expect(s.replaceTools([lookupTool])).rejects.toThrow('provider refused');

			const weatherTool = makeTool('get_weather', { temp: 72 });
			await s.registerTools([weatherTool]);
			expect(updateSession).toHaveBeenLastCalledWith({ tools: [clockTool, weatherTool] });
		});

		it('updateInstructions sends the instructions with updateSession', async () => {
			const { transport, updateSession } = createStubTransport();
			const s = createSession({ transport });

			await s.updateInstructions('Answer in one sentence.');

			expect(updateSession).toHaveBeenLastCalledWith({ instructions: 'Answer in one sentence.' });
		});
	});
});
