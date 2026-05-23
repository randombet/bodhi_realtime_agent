// SPDX-License-Identifier: MIT

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
 * See dev_docs/framework/design-greeting-interrupt-grace.md §7.5.
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
			await session.handleTextInput?.('hello');
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
			const p1 = session.handleTextInput?.('first');
			const p2 = session.handleTextInput?.('second');
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

	it('survives a transport without cancelResponse (optional-chain no-op)', async () => {
		const transport = createMockTransport({ includeCancelResponse: false });
		const session = await buildSession(transport);
		try {
			const beforeCount = transport.__sentContent.length;
			await session.handleTextInput?.('hi');
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
			const p1 = session.handleTextInput?.('A');
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
