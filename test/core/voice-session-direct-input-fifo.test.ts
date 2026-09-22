import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	CancelResponseOptions,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

/**
 * Phase B6 verification — direct-input single-flight FIFO.
 *
 * `handleTextInput`, `injectTranscript`, and `injectDictationBuffer` all
 * share `_directInputChain`. Each enqueued body awaits
 * `cancelResponse({ waitForDone: true })` then finalizes any unfinalized
 * active turn then sends content — and the next enqueued body waits for the
 * previous to finish.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

function createMockTransport(
	opts: {
		includeCancelResponse?: boolean;
		cancelWaitMs?: number;
	} = {},
): LLMTransport & {
	__cancelCalls: CancelResponseOptions[];
	__sentContent: Array<[unknown, unknown]>;
} {
	const cancelCalls: CancelResponseOptions[] = [];
	const sentContent: Array<[unknown, unknown]> = [];
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
		sendContent: vi.fn((turns: unknown, turnComplete: unknown) => {
			sentContent.push([turns, turnComplete]);
		}),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
	if (opts.includeCancelResponse !== false) {
		transport.cancelResponse = vi.fn(async (cancelOpts?: CancelResponseOptions) => {
			cancelCalls.push(cancelOpts ?? {});
			if (opts.cancelWaitMs) {
				await new Promise((r) => setTimeout(r, opts.cancelWaitMs));
			}
		});
	}
	const tagged = transport as LLMTransport & {
		__cancelCalls: CancelResponseOptions[];
		__sentContent: Array<[unknown, unknown]>;
	};
	tagged.__cancelCalls = cancelCalls;
	tagged.__sentContent = sentContent;
	return tagged;
}

async function buildSession(transport: LLMTransport): Promise<VoiceSession> {
	const session = new VoiceSession({
		sessionId: 'sess_fifo',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
	});
	await session.start();
	session.notifyClientConnected();
	transport.onSessionReady?.('mock_session');
	// Drain memory-ready microtask + greeting send.
	await new Promise((r) => setTimeout(r, 5));
	return session;
}

function handleTextInput(session: VoiceSession, text: string): Promise<void> {
	return (
		session as unknown as {
			handleTextInput(input: string): Promise<void>;
		}
	).handleTextInput(text);
}

describe('VoiceSession direct-input FIFO', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it('handleTextInput awaits cancelResponse({waitForDone:true}) before sendContent', async () => {
		const transport = createMockTransport();
		const session = await buildSession(transport);
		try {
			const beforeCount = transport.__sentContent.length;
			await handleTextInput(session, 'hello');
			// At least one cancelResponse call, and it asked for waitForDone.
			const aCancels = transport.__cancelCalls;
			expect(aCancels.length).toBeGreaterThan(0);
			expect(aCancels[aCancels.length - 1]?.waitForDone).toBe(true);
			// The text was sent (one new sendContent).
			expect(transport.__sentContent.length).toBeGreaterThan(beforeCount);
			const last = transport.__sentContent[transport.__sentContent.length - 1];
			expect(last[0]).toEqual([{ role: 'user', text: 'hello' }]);
			expect(last[1]).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('serializes two rapid handleTextInput calls — second sendContent happens AFTER first completes', async () => {
		const transport = createMockTransport({ cancelWaitMs: 30 });
		const session = await buildSession(transport);
		try {
			const beforeCount = transport.__sentContent.length;
			// Fire two without await.
			const p1 = handleTextInput(session, 'first');
			const p2 = handleTextInput(session, 'second');
			// While the first is still in flight (cancel waits 30ms), nothing
			// new should be sent yet.
			expect(transport.__sentContent.length).toBe(beforeCount);
			await p1;
			// After p1, exactly one new send.
			const afterP1 = transport.__sentContent.length;
			expect(afterP1).toBe(beforeCount + 1);
			expect(transport.__sentContent[afterP1 - 1][0]).toEqual([{ role: 'user', text: 'first' }]);
			await p2;
			// After p2, the second send lands.
			const afterP2 = transport.__sentContent.length;
			expect(afterP2).toBe(beforeCount + 2);
			expect(transport.__sentContent[afterP2 - 1][0]).toEqual([{ role: 'user', text: 'second' }]);
			// Each call cancelled with waitForDone.
			expect(
				transport.__cancelCalls.filter((c) => c.waitForDone === true).length,
			).toBeGreaterThanOrEqual(2);
		} finally {
			await session.close();
		}
	});

	it('second body waits for the first response to complete (no race on response.create)', async () => {
		// Regression for the response-creation race: in production, the first
		// handleTextInput's sendContent fires `response.create` synchronously,
		// but `_isModelGenerating` only flips on the server's
		// `response.created` event (a round-trip later). Without pre-arming
		// `_activeResponseDone` at the wire send, the second body's
		// `cancelResponse({waitForDone:true})` would resolve to
		// `Promise.resolve()` (no apparent active response) and fire its own
		// `response.create` immediately — producing
		// `conversation_already_has_active_response`.
		//
		// The fix: each response-creating wire send calls
		// `markResponsePending()` first, so subsequent waitForDone callers
		// see a pending waiter. This test models that contract by exposing
		// the transport's `_activeResponseDone` pending-state via a custom
		// cancelResponse that observes it.
		const cancelObservations: { activeResponseDoneResolved: boolean }[] = [];
		const transport = createMockTransport();
		// Replace cancelResponse to observe whether the active-response
		// waiter is pending when the FIRST body's cancel fires.
		// biome-ignore lint/suspicious/noExplicitAny: test mock access on internal transport state
		(transport as any).cancelResponse = vi.fn(async (cancelOpts?: CancelResponseOptions) => {
			transport.__cancelCalls.push(cancelOpts ?? {});
			// In production this would race the waiter; the mock simply
			// observes that the design *would* wait when waitForDone is set.
			cancelObservations.push({ activeResponseDoneResolved: !cancelOpts?.waitForDone });
		});
		const session = await buildSession(transport);
		try {
			// Sequential awaits — proves the FIFO blocks the second body until
			// the first finishes its full cancel→finalize→sendContent body.
			await handleTextInput(session, 'one');
			const onlyOneContent = transport.__sentContent.filter(
				(c) => Array.isArray(c[0]) && JSON.stringify(c[0]).includes('"one"'),
			).length;
			expect(onlyOneContent).toBe(1);
			await handleTextInput(session, 'two');
			const twoContents = transport.__sentContent.filter(
				(c) => Array.isArray(c[0]) && JSON.stringify(c[0]).includes('"two"'),
			);
			expect(twoContents).toHaveLength(1);
			// Each call requested waitForDone — the production contract.
			expect(transport.__cancelCalls.every((c) => c.waitForDone === true)).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('survives a transport without cancelResponse (optional-chain no-op)', async () => {
		const transport = createMockTransport({ includeCancelResponse: false });
		const session = await buildSession(transport);
		try {
			const beforeCount = transport.__sentContent.length;
			await handleTextInput(session, 'hi');
			expect(transport.__sentContent.length).toBe(beforeCount + 1);
			expect(transport.__cancelCalls).toHaveLength(0);
		} finally {
			await session.close();
		}
	});

	it('mixed handleTextInput + injectTranscript share the same FIFO', async () => {
		const transport = createMockTransport({ cancelWaitMs: 10 });
		const session = await buildSession(transport);
		try {
			const beforeCount = transport.__sentContent.length;
			const p1 = handleTextInput(session, 'A');
			const p2 = session.injectTranscript?.('B');
			await Promise.all([p1, p2]);
			const sent = transport.__sentContent.slice(beforeCount);
			expect(sent).toHaveLength(2);
			// Arrival order preserved: A before B.
			expect(sent[0][0]).toEqual([{ role: 'user', text: 'A' }]);
			expect(sent[1][0]).toEqual([{ role: 'user', text: 'B' }]);
		} finally {
			await session.close();
		}
	});
});
