// SPDX-License-Identifier: MIT

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
 * Phase C2/C3 verification — grace arming + interrupt suppression.
 * See dev_docs/framework/design-greeting-interrupt-grace.md §4, §6.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are concise.', tools: [], greeting: 'Hi there!' };
}

function createMockTransport(opts: {
	frameworkOwnsInterrupt?: boolean;
	greetingInterruptGraceMs?: number;
	hasCancelResponse?: boolean;
}): LLMTransport & {
	__clearInputAudioCalls: number;
	__cancelResponseCalls: number;
} {
	let clearInputAudioCalls = 0;
	let cancelResponseCalls = 0;
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
			...(opts.frameworkOwnsInterrupt !== undefined && {
				frameworkOwnsInterrupt: opts.frameworkOwnsInterrupt,
			}),
			...(opts.greetingInterruptGraceMs !== undefined && {
				greetingInterruptGraceMs: opts.greetingInterruptGraceMs,
			}),
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
	if (opts.hasCancelResponse !== false) {
		transport.cancelResponse = vi.fn(async () => {
			cancelResponseCalls += 1;
		});
	}
	transport.clearInputAudio = vi.fn(() => {
		clearInputAudioCalls += 1;
	});
	const tagged = transport as LLMTransport & {
		__clearInputAudioCalls: number;
		__cancelResponseCalls: number;
	};
	Object.defineProperty(tagged, '__clearInputAudioCalls', { get: () => clearInputAudioCalls });
	Object.defineProperty(tagged, '__cancelResponseCalls', { get: () => cancelResponseCalls });
	return tagged;
}

async function buildSession(opts: {
	greetingInterruptGraceMs?: number;
	transport: LLMTransport;
}): Promise<VoiceSession> {
	const session = new VoiceSession({
		sessionId: 'sess_grace_arm',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport: opts.transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		...(opts.greetingInterruptGraceMs !== undefined && {
			greetingInterruptGraceMs: opts.greetingInterruptGraceMs,
		}),
	});
	await session.start();
	session.notifyClientConnected();
	opts.transport.onSessionReady?.('mock_session');
	await new Promise((r) => setTimeout(r, 5));
	return session;
}

describe('VoiceSession greeting-grace arming + suppression', () => {
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

	it('first onAudioOutput chunk arms the window AND calls transport.clearInputAudio', async () => {
		const transport = createMockTransport({
			frameworkOwnsInterrupt: true,
			greetingInterruptGraceMs: 1000,
			hasCancelResponse: true,
		});
		const session = await buildSession({ transport });
		try {
			// Pre-arming: clearInputAudio not yet called.
			expect(transport.__clearInputAudioCalls).toBe(0);
			// First audio chunk → arm.
			const pcm = Buffer.alloc(960).toString('base64');
			transport.onAudioOutput?.(pcm);
			expect(transport.__clearInputAudioCalls).toBe(1);
			expect(logContains('[Latency] Interrupt grace window armed (1000ms)')).toBe(true);
			// Subsequent chunks idempotent — no second clearInputAudio call,
			// no second armed-log.
			transport.onAudioOutput?.(pcm);
			transport.onAudioOutput?.(pcm);
			expect(transport.__clearInputAudioCalls).toBe(1);
			const armedLogs = logSpy.mock.calls.filter(
				([msg]) => typeof msg === 'string' && msg.includes('Interrupt grace window armed'),
			);
			expect(armedLogs).toHaveLength(1);
		} finally {
			await session.close();
		}
	});

	it('grace window of 0 (caller override) skips arming entirely', async () => {
		const transport = createMockTransport({
			frameworkOwnsInterrupt: true,
			greetingInterruptGraceMs: 1000,
			hasCancelResponse: true,
		});
		const session = await buildSession({ transport, greetingInterruptGraceMs: 0 });
		try {
			const pcm = Buffer.alloc(960).toString('base64');
			transport.onAudioOutput?.(pcm);
			expect(transport.__clearInputAudioCalls).toBe(0);
			expect(logContains('Interrupt grace window armed')).toBe(false);
		} finally {
			await session.close();
		}
	});

	it('downgraded session (no frameworkOwnsInterrupt) does not arm', async () => {
		const transport = createMockTransport({
			frameworkOwnsInterrupt: false,
			greetingInterruptGraceMs: 1000,
			hasCancelResponse: true,
		});
		const session = await buildSession({ transport });
		try {
			const pcm = Buffer.alloc(960).toString('base64');
			transport.onAudioOutput?.(pcm);
			expect(transport.__clearInputAudioCalls).toBe(0);
			expect(logContains('Interrupt grace window armed')).toBe(false);
		} finally {
			await session.close();
		}
	});

	it('onSpeechStarted during arming window is suppressed (no cancelResponse, no interrupt)', async () => {
		const transport = createMockTransport({
			frameworkOwnsInterrupt: true,
			greetingInterruptGraceMs: 1000,
			hasCancelResponse: true,
		});
		const session = await buildSession({ transport });
		try {
			// Arm the window.
			const pcm = Buffer.alloc(960).toString('base64');
			transport.onAudioOutput?.(pcm);
			const cancelsBeforeBarge = transport.__cancelResponseCalls;

			// Simulate a barge-in during the window. wireNativeBargeIn's
			// chained handler reads currentTurn — the session has one
			// because of the greeting that started.
			transport.onSpeechStarted?.();

			// requestInterrupt should have denied → no cancelResponse, and
			// the suppression log should have fired.
			expect(transport.__cancelResponseCalls).toBe(cancelsBeforeBarge);
			expect(logContains('[Latency] interrupt suppressed (grace,')).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('handleClientConnected (reconnect) resets the window — next chunk re-arms', async () => {
		const transport = createMockTransport({
			frameworkOwnsInterrupt: true,
			greetingInterruptGraceMs: 1000,
			hasCancelResponse: true,
		});
		const session = await buildSession({ transport });
		try {
			const pcm = Buffer.alloc(960).toString('base64');
			transport.onAudioOutput?.(pcm); // arm
			expect(transport.__clearInputAudioCalls).toBe(1);
			// Reconnect.
			session.notifyClientConnected();
			// Next chunk re-arms.
			transport.onAudioOutput?.(pcm);
			expect(transport.__clearInputAudioCalls).toBe(2);
			const armedLogs = logSpy.mock.calls.filter(
				([msg]) => typeof msg === 'string' && msg.includes('Interrupt grace window armed'),
			);
			expect(armedLogs).toHaveLength(2);
		} finally {
			await session.close();
		}
	});
});
