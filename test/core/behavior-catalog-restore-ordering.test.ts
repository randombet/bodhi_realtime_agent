import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { speechSpeed } from '../../src/behaviors/presets.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { BehaviorCatalogMessage } from '../../src/types/client-protocol.js';
import type { MemoryStore } from '../../src/types/memory.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

/**
 * Reuse-plan step B5 — catalog-after-restore ordering.
 *
 * `restorePreset()` deliberately does not notify the client; the client
 * learns restored state from `behavior.catalog`. The catalog must therefore
 * be sent AFTER memory restore has applied restored presets and BEFORE the
 * greeting triggers generation — otherwise a restored slow/fast pacing
 * preset never reaches the client's playback rate (the bug this fixes:
 * catalog used to be sent synchronously on client-connect, racing a slower
 * `getDirectives`).
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createMockTransport(): LLMTransport {
	return {
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
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

/** Store whose getDirectives resolves `{ pacing: 'slow' }` after `delayMs` —
 *  the slow-restore case that used to lose the restored preset. */
function slowDirectiveStore(delayMs: number): MemoryStore {
	return {
		addFacts: async () => {},
		getAll: async () => [],
		replaceAll: async () => {},
		getDirectives: async () => {
			await new Promise((r) => setTimeout(r, delayMs));
			return { pacing: 'slow' };
		},
		setDirectives: async () => {},
	};
}

describe('behavior.catalog restore ordering (reuse plan B5)', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => {
		logSpy.mockRestore();
	});

	it('sends the catalog with the RESTORED preset, before greeting generation, despite delayed directives', async () => {
		const transport = createMockTransport();
		const sendContentMock = transport.sendContent as ReturnType<typeof vi.fn>;
		const sequence: string[] = [];
		const catalogs: BehaviorCatalogMessage[] = [];
		sendContentMock.mockImplementation(() => {
			sequence.push('generation');
		});

		const session = new VoiceSession({
			sessionId: 'sess_b5',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [{ name: 'main', instructions: 'assistant', tools: [], greeting: 'Hi!' }],
			initialAgent: 'main',
			model: mockModel,
			transport,
			orchestrationMode: 'actor',
			behaviors: [speechSpeed()],
			memory: { store: slowDirectiveStore(25) },
			clientSender: {
				sendAudio: vi.fn(),
				sendJson: (msg) => {
					sequence.push(`json:${msg.type}`);
					if (msg.type === 'behavior.catalog') catalogs.push(msg as BehaviorCatalogMessage);
				},
			},
		});
		try {
			await session.start();
			session.notifyClientConnected();
			transport.onSessionReady?.('mock_session');
			// Longer than the directive delay so restore + greeting both settle.
			await new Promise((r) => setTimeout(r, 60));

			expect(catalogs).toHaveLength(1);
			const pacing = catalogs[0].categories.find((c) => c.key === 'pacing');
			expect(pacing?.active).toBe('slow');

			const catalogIdx = sequence.indexOf('json:behavior.catalog');
			const generationIdx = sequence.indexOf('generation');
			expect(catalogIdx).toBeGreaterThanOrEqual(0);
			expect(generationIdx).toBeGreaterThanOrEqual(0);
			expect(catalogIdx, `sequence: ${sequence.join(' → ')}`).toBeLessThan(generationIdx);
		} finally {
			await session.close();
		}
	});
});
