import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession, clampGraceMs } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

/**
 * Phase A5 verification — two-pass `greetingInterruptGraceMs` resolution.
 *
 * Pass 1 (constructor): clamps the caller override and stores it.
 * Pass 2 (handleSetupComplete, before sendGreeting): combines override with
 * the transport's post-connect capabilities, validates, finalizes.
 *
 * These tests assert the helper's clamp behaviour and the integration path —
 * specifically the validation warning when grace > 0 resolves against a
 * transport that does not advertise `frameworkOwnsInterrupt` or does not
 * implement `cancelResponse`.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: [],
	};
}

function createMockTransport(opts: {
	greetingInterruptGraceMs?: number;
	frameworkOwnsInterrupt?: boolean;
	hasCancelResponse?: boolean;
}): LLMTransport {
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
			...(opts.greetingInterruptGraceMs !== undefined && {
				greetingInterruptGraceMs: opts.greetingInterruptGraceMs,
			}),
			...(opts.frameworkOwnsInterrupt !== undefined && {
				frameworkOwnsInterrupt: opts.frameworkOwnsInterrupt,
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
	if (opts.hasCancelResponse) {
		transport.cancelResponse = vi.fn(async () => {});
	}
	return transport;
}

describe('clampGraceMs', () => {
	it('returns undefined for undefined input (no override)', () => {
		expect(clampGraceMs(undefined)).toBeUndefined();
	});

	it('returns 0 for negative input', () => {
		expect(clampGraceMs(-1)).toBe(0);
		expect(clampGraceMs(-1000)).toBe(0);
	});

	it('returns 0 for NaN', () => {
		expect(clampGraceMs(Number.NaN)).toBe(0);
	});

	it('returns 0 for non-finite values', () => {
		expect(clampGraceMs(Number.POSITIVE_INFINITY)).toBe(0);
		expect(clampGraceMs(Number.NEGATIVE_INFINITY)).toBe(0);
	});

	it('caps at 5000 ms', () => {
		expect(clampGraceMs(5001)).toBe(5000);
		expect(clampGraceMs(60_000)).toBe(5000);
	});

	it('passes valid values through', () => {
		expect(clampGraceMs(0)).toBe(0);
		expect(clampGraceMs(500)).toBe(500);
		expect(clampGraceMs(1000)).toBe(1000);
		expect(clampGraceMs(5000)).toBe(5000);
	});
});

describe('VoiceSession greeting-grace two-pass resolution', () => {
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

	async function buildSession(opts: {
		override?: number;
		capability?: number;
		frameworkOwnsInterrupt?: boolean;
		hasCancelResponse?: boolean;
	}): Promise<VoiceSession> {
		const transport = createMockTransport({
			greetingInterruptGraceMs: opts.capability,
			frameworkOwnsInterrupt: opts.frameworkOwnsInterrupt,
			hasCancelResponse: opts.hasCancelResponse,
		});
		const session = new VoiceSession({
			sessionId: 'sess_grace',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			...(opts.override !== undefined && { greetingInterruptGraceMs: opts.override }),
		});
		await session.start();
		// Drive the onSessionReady callback to trigger pass 2 finalize.
		transport.onSessionReady?.('mock_session');
		return session;
	}

	it('resolves to capability default when no override given', async () => {
		const session = await buildSession({
			capability: 1000,
			frameworkOwnsInterrupt: true,
			hasCancelResponse: true,
		});
		try {
			expect(logContains('[Latency] greetingInterruptGraceMs resolved to 1000ms')).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('caller override wins over capability', async () => {
		const session = await buildSession({
			override: 250,
			capability: 1000,
			frameworkOwnsInterrupt: true,
			hasCancelResponse: true,
		});
		try {
			expect(logContains('[Latency] greetingInterruptGraceMs resolved to 250ms')).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('caller override 0 disables grace even when capability advertises 1000', async () => {
		const session = await buildSession({
			override: 0,
			capability: 1000,
			frameworkOwnsInterrupt: true,
			hasCancelResponse: true,
		});
		try {
			// 0 is the disabled path — no resolution log; no warn either.
			expect(logContains('[Latency] greetingInterruptGraceMs resolved')).toBe(false);
			expect(logContains('[WARN] greetingInterruptGraceMs')).toBe(false);
		} finally {
			await session.close();
		}
	});

	it('downgrades to 0 with warn when !frameworkOwnsInterrupt', async () => {
		const session = await buildSession({
			capability: 1000,
			frameworkOwnsInterrupt: false,
			hasCancelResponse: true,
		});
		try {
			expect(logContains('[WARN] greetingInterruptGraceMs=1000ms requested but ')).toBe(true);
			expect(logContains('frameworkOwnsInterrupt is not true')).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('downgrades to 0 with warn when frameworkOwnsInterrupt but no cancelResponse', async () => {
		const session = await buildSession({
			capability: 1000,
			frameworkOwnsInterrupt: true,
			hasCancelResponse: false,
		});
		try {
			expect(logContains('[WARN] greetingInterruptGraceMs=1000ms requested but ')).toBe(true);
			expect(logContains('cancelResponse is not implemented on the transport')).toBe(true);
		} finally {
			await session.close();
		}
	});

	it('clamps invalid override at construction (NaN → 0; no warn since 0 is the disabled path)', async () => {
		const session = await buildSession({
			override: Number.NaN,
			capability: 1000,
			frameworkOwnsInterrupt: true,
			hasCancelResponse: true,
		});
		try {
			expect(logContains('[Latency] greetingInterruptGraceMs resolved')).toBe(false);
			expect(logContains('[WARN] greetingInterruptGraceMs')).toBe(false);
		} finally {
			await session.close();
		}
	});

	it('clamps oversized override (10_000 → 5000) before validation', async () => {
		const session = await buildSession({
			override: 10_000,
			capability: 1000,
			frameworkOwnsInterrupt: true,
			hasCancelResponse: true,
		});
		try {
			expect(logContains('[Latency] greetingInterruptGraceMs resolved to 5000ms')).toBe(true);
		} finally {
			await session.close();
		}
	});
});
