import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { STTProvider } from '../../src/types/transport.js';

/**
 * Conversation continuity seams on VoiceSession: `resetConversationContext`
 * (flush, seal, persist once, then clear) and the session-owned
 * `SessionManager`, whose `reset()` refuses once the session is finalized.
 * Runs on the built-in Gemini transport over a mocked SDK with a host-owned
 * client sender, so no port is bound.
 */

declare module '@google/genai' {
	function _getMessageHandler(): ((message: unknown) => void) | null;
}

vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
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
});
