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
 * Client-VAD barge-in for the non-cancellable transport shape (Gemini native, no
 * playback gate). A transport that declares `bufferedUncancellableAudio` has no
 * playback gate (`liveGate()` is null) and its interrupts are provider-driven,
 * which makes a long, client-buffered greeting hard to interrupt. So once a turn
 * has emitted audio past the echo-skip window, `isAssistantAudioActive()` is true
 * and a client-VAD barge-in (a) calls `cancelResponse()` — which the transport
 * uses to stop the trailing audio — and (b) finalizes the turn (`turn.interrupted`).
 * The trailing-audio suppression itself is the transport's job and is tested in
 * gemini-live-transport.test.ts. See design-noncancellable-transport-barge-in.md.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

/** Gemini-like transport: `playbackGatedTurnComplete` + `bufferedUncancellableAudio`,
 *  no `frameworkOwnsInterrupt` → no playback gate, `cancelResponse` suppresses. */
function createGeminiLikeTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: true,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: true,
			sessionResumption: false,
			contextCompression: false,
			groundingMetadata: false,
			textResponseModality: true,
			playbackGatedTurnComplete: true,
			bufferedUncancellableAudio: true,
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
		cancelResponse: vi.fn().mockResolvedValue(undefined),
	};
}

/** Base64 of `ms` of 24 kHz 16-bit mono PCM (48 bytes/ms). */
function pcm(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

type JsonCall = [Record<string, unknown>];
function countJson(sendJson: ReturnType<typeof vi.fn>, type: string): number {
	return sendJson.mock.calls.filter((c: JsonCall) => c[0]?.type === type).length;
}

function setup() {
	const transport = createGeminiLikeTransport();
	const sendAudio = vi.fn();
	const sendJson = vi.fn();
	const session = new VoiceSession({
		sessionId: 'sess_gemini_bargein',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: true },
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: true, // gated OFF by playbackGatedTurnComplete
	});
	const internals = session as unknown as {
		isAssistantAudioActive(): boolean;
		handleClientTtsBargeIn(): void;
		liveGate(): unknown;
	};
	return { transport, sendAudio, sendJson, session, internals };
}

/** Framework-owned, generation-gated transport (OpenAI/Qwen shape): no
 *  `playbackGatedTurnComplete`/`bufferedUncancellableAudio`, `frameworkOwnsInterrupt: true`. */
function createFrameworkOwnedTransport(): LLMTransport {
	const t = createGeminiLikeTransport() as LLMTransport & {
		capabilities: TransportCapabilities;
	};
	t.capabilities.playbackGatedTurnComplete = false;
	t.capabilities.bufferedUncancellableAudio = false;
	t.capabilities.frameworkOwnsInterrupt = true;
	return t;
}

describe('barge-in scope — framework-owned no-gate transport', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('a no-gate OpenAI/Qwen-shaped session does NOT get the client-VAD fallback', async () => {
		let session: VoiceSession | undefined;
		try {
			const transport = createFrameworkOwnedTransport();
			const sendJson = vi.fn();
			session = new VoiceSession({
				sessionId: 'sess_fw_owned',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createAgent()],
				initialAgent: 'main',
				model: mockModel,
				transport,
				orchestrationMode: 'actor',
				clientSender: { sendAudio: vi.fn(), sendJson, supportsPlaybackStateProtocol: true },
				// Mobile/phone shape: native gating disabled → liveGate() is null.
				nativePlaybackGating: false,
			});
			const internals = session as unknown as {
				isAssistantAudioActive(): boolean;
				handleClientTtsBargeIn(): void;
				liveGate(): unknown;
			};
			await session.start();

			expect(internals.liveGate()).toBeNull(); // no gate, like Gemini…
			transport.onModelTurnStart?.();
			transport.onAudioOutput?.(pcm(1000));
			vi.advanceTimersByTime(1000); // well past any echo-skip window

			// …but the fallback is NOT consulted for this framework-owned shape.
			expect(internals.isAssistantAudioActive()).toBe(false);
			internals.handleClientTtsBargeIn();
			expect(countJson(sendJson, 'turn.interrupted')).toBe(0);
		} finally {
			await session?.close();
		}
	});
});

describe('Gemini native client-VAD barge-in', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('liveGate() is null for the Gemini native path', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();
			expect(s.internals.liveGate()).toBeNull();
		} finally {
			await session?.close();
		}
	});

	it('isAssistantAudioActive: false before audio, false within the echo-skip window, true after', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			expect(s.internals.isAssistantAudioActive()).toBe(false); // no audio yet

			s.transport.onAudioOutput?.(pcm(100)); // first audio starts the window
			vi.advanceTimersByTime(399);
			expect(s.internals.isAssistantAudioActive()).toBe(false); // within echo-skip
			vi.advanceTimersByTime(1);
			expect(s.internals.isAssistantAudioActive()).toBe(true); // past echo-skip
		} finally {
			await session?.close();
		}
	});

	it('a client-VAD barge-in calls cancelResponse and finalizes the turn (turn.interrupted)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcm(1000)); // greeting audio
			vi.advanceTimersByTime(500); // past the echo-skip window

			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(0);
			s.internals.handleClientTtsBargeIn();
			// (a) tells the transport to stop the response reaching the user…
			expect(s.transport.cancelResponse).toHaveBeenCalledTimes(1);
			// (b) …and finalizes the framework turn.
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(1);

			// Turn is finalized → no longer "speaking", so a second barge-in no-ops.
			expect(s.internals.isAssistantAudioActive()).toBe(false);
			s.internals.handleClientTtsBargeIn();
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(1);
			expect(s.transport.cancelResponse).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});

	it('a barge-in before any assistant audio is a no-op (nothing to interrupt)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			vi.advanceTimersByTime(1000); // time passes, but no audio emitted
			s.internals.handleClientTtsBargeIn();
			expect(countJson(s.sendJson, 'turn.interrupted')).toBe(0);
			expect(s.transport.cancelResponse).not.toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});
});
