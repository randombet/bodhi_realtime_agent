import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

/** H2 gate-aware drain: capture-tagged frames whose gate was active at
 *  INGRESS are discarded for LLM drains; admitted frames go through the
 *  router's transform helper (no retention, no live gate read); evidence is
 *  recorded; the returned buffers feed the reconnect speech verdict. */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createTransport(): LLMTransport {
	return {
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
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

function voicedFrame(): Buffer {
	const b = Buffer.alloc(480 * 2);
	for (let i = 0; i < b.length; i += 2) b.writeInt16LE(2000, i);
	return b;
}

describe('drainCapturedInboundFrames', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('discards gate-captured frames, sends admitted ones, records evidence, returns admitted', async () => {
		const transport = createTransport() as LLMTransport & {
			sendAudio: ReturnType<typeof vi.fn>;
		};
		const session = new VoiceSession({
			sessionId: 'sess_drain',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [{ name: 'main', instructions: 'x', tools: [] } as MainAgent],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		});
		try {
			await session.start();
			transport.onSessionReady?.('mock');
			await vi.advanceTimersByTimeAsync(10);

			const gated = voicedFrame();
			const admitted = voicedFrame();
			const silentAdmitted = Buffer.alloc(480 * 2);
			const internals = session as unknown as {
				clientTransport: Record<string, unknown>;
				drainCapturedInboundFrames(reason: string): Buffer[];
				userTurnEvidence: { lastDrainedSpeechAtMs: number | null };
			};
			// Stub the local channel's tagged capture drain.
			internals.clientTransport.stopInboundCapture = () => [
				{ data: gated, voiced: true, gateActiveAtCapture: true },
				{ data: admitted, voiced: true, gateActiveAtCapture: false },
				{ data: silentAdmitted, voiced: false, gateActiveAtCapture: false },
			];

			const returned = internals.drainCapturedInboundFrames('reconnect');
			// Gate-captured frame discarded; BOTH other frames sent (voiced is
			// evidence only, never a drop criterion — silence continuity matters).
			expect(returned).toEqual([admitted, silentAdmitted]);
			expect(transport.sendAudio).toHaveBeenCalledTimes(2);
			expect(transport.sendAudio).toHaveBeenCalledWith(admitted.toString('base64'));
			// Freshness anchor moved (reconnect drain with admitted voiced audio).
			expect(internals.userTurnEvidence.lastDrainedSpeechAtMs).not.toBeNull();
		} finally {
			await session.close();
		}
	});

	it('falls back to the legacy stopBuffering contract when the channel has no inbound capture', async () => {
		const transport = createTransport() as LLMTransport & {
			sendAudio: ReturnType<typeof vi.fn>;
		};
		const session = new VoiceSession({
			sessionId: 'sess_drain2',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [{ name: 'main', instructions: 'x', tools: [] } as MainAgent],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		});
		try {
			await session.start();
			transport.onSessionReady?.('mock');
			await vi.advanceTimersByTimeAsync(10);
			const internals = session as unknown as {
				drainCapturedInboundFrames(reason: string): Buffer[];
			};
			// Hosted adapter shape: stopBuffering returns [] — nothing drained.
			expect(internals.drainCapturedInboundFrames('reconnect')).toEqual([]);
			expect(transport.sendAudio).not.toHaveBeenCalled();
		} finally {
			await session.close();
		}
	});
});
