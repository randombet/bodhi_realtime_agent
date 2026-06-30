import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownConversationHistoryStore } from '../../src/core/markdown-conversation-history-store.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ConversationItem } from '../../src/types/conversation.js';
import type {
	ConversationHistoryStore,
	SessionRecord,
	SessionReport,
} from '../../src/types/history.js';

vi.mock('@google/genai', () => ({
	GoogleGenAI: vi.fn().mockImplementation(() => ({
		live: {
			connect: vi.fn(async (params: Record<string, unknown>) => {
				const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
				setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
				return {
					sendRealtimeInput: vi.fn(),
					sendToolResponse: vi.fn(),
					sendClientContent: vi.fn(),
					close: vi.fn(),
				};
			}),
		},
	})),
}));

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({ text: 'mock' })),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function makeAgent(): MainAgent {
	return { name: 'echo', instructions: 'test', tools: [] };
}

function makeFakeStore(): {
	store: ConversationHistoryStore;
	calls: { method: string; args: unknown[] }[];
} {
	const calls: { method: string; args: unknown[] }[] = [];
	const record =
		(method: string) =>
		async (...args: unknown[]) => {
			calls.push({ method, args });
		};
	const store: ConversationHistoryStore = {
		createSession: vi.fn(record('createSession')) as unknown as (s: SessionRecord) => Promise<void>,
		updateSession: vi.fn(record('updateSession')) as unknown as (
			id: string,
			u: Partial<SessionRecord>,
		) => Promise<void>,
		addItems: vi.fn(record('addItems')) as unknown as (
			id: string,
			items: ConversationItem[],
		) => Promise<void>,
		saveSessionReport: vi.fn(record('saveSessionReport')) as unknown as (
			r: SessionReport,
		) => Promise<void>,
		getSession: vi.fn(async () => null) as unknown as ConversationHistoryStore['getSession'],
		getSessionItems: vi.fn(
			async () => [],
		) as unknown as ConversationHistoryStore['getSessionItems'],
		listUserSessions: vi.fn(
			async () => [],
		) as unknown as ConversationHistoryStore['listUserSessions'],
	};
	return { store, calls };
}

// Use a high port range to avoid collisions with other parallel test files
// (e.g. voice-session.test.ts uses ports starting at 9870).
let port = 19_900;
function nextPort() {
	return port++;
}

describe('VoiceSession history fan-out wiring', () => {
	let session: VoiceSession | null = null;
	let baseDir: string;

	beforeEach(async () => {
		baseDir = await mkdtemp(join(tmpdir(), 'vshist-'));
	});

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
		await rm(baseDir, { recursive: true, force: true });
	});

	it('only-singular: legacy conversationHistoryStore still works on its own', async () => {
		const { store, calls } = makeFakeStore();
		session = new VoiceSession({
			sessionId: 'sess_legacy',
			userId: 'u_1',
			apiKey: 'test-key',
			agents: [makeAgent()],
			initialAgent: 'echo',
			port: nextPort(),
			model: mockModel,
			conversationHistoryStore: store,
		});

		await session.start();
		await session.close();
		session = null;

		const methods = calls.map((c) => c.method);
		expect(methods).toContain('createSession');
		expect(methods).toContain('saveSessionReport');
	});

	it('only-plural: a single store passed via conversationHistoryStores works', async () => {
		const { store, calls } = makeFakeStore();
		session = new VoiceSession({
			sessionId: 'sess_plural',
			userId: 'u_1',
			apiKey: 'test-key',
			agents: [makeAgent()],
			initialAgent: 'echo',
			port: nextPort(),
			model: mockModel,
			conversationHistoryStores: [store],
		});

		await session.start();
		await session.close();
		session = null;

		const methods = calls.map((c) => c.method);
		expect(methods).toContain('createSession');
		expect(methods).toContain('saveSessionReport');
	});

	it('both fields: writes fan out to every configured store', async () => {
		const a = makeFakeStore();
		const b = makeFakeStore();
		session = new VoiceSession({
			sessionId: 'sess_both',
			userId: 'u_1',
			apiKey: 'test-key',
			agents: [makeAgent()],
			initialAgent: 'echo',
			port: nextPort(),
			model: mockModel,
			conversationHistoryStore: a.store,
			conversationHistoryStores: [b.store],
		});

		await session.start();
		await session.close();
		session = null;

		// Both stores see the same lifecycle methods.
		expect(a.calls.map((c) => c.method)).toContain('createSession');
		expect(a.calls.map((c) => c.method)).toContain('saveSessionReport');
		expect(b.calls.map((c) => c.method)).toContain('createSession');
		expect(b.calls.map((c) => c.method)).toContain('saveSessionReport');
	});

	it('sole markdown store works (writes succeed; reads throw if app calls them)', async () => {
		const markdown = new MarkdownConversationHistoryStore({ baseDir });
		session = new VoiceSession({
			sessionId: 'sess_markdown_only',
			userId: 'u_1',
			apiKey: 'test-key',
			agents: [makeAgent()],
			initialAgent: 'echo',
			port: nextPort(),
			model: mockModel,
			conversationHistoryStores: [markdown],
		});

		await session.start();
		await session.close();
		session = null;

		// ConversationHistoryWriter fires store calls without await, so the
		// markdown store's per-session queue still has work to drain after close
		// returns. Wait briefly for the file to land on disk.
		await new Promise((r) => setTimeout(r, 50));

		const md = await readFile(join(baseDir, 'sess_markdown_only.md'), 'utf-8');
		expect(md).toContain('# Voice session sess_markdown_only');
		expect(md).toContain('Session ended');
	});

	it('neither field: no writer is constructed (no errors during lifecycle)', async () => {
		session = new VoiceSession({
			sessionId: 'sess_no_store',
			userId: 'u_1',
			apiKey: 'test-key',
			agents: [makeAgent()],
			initialAgent: 'echo',
			port: nextPort(),
			model: mockModel,
		});

		await session.start();
		await session.close();
		session = null;
		// Reaching this point with no thrown error is the assertion.
	});
});
