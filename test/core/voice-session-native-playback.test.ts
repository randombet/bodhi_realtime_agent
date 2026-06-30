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
 * Unit tests for native-audio playback-end gating (the OpenAI native path).
 * The mock transport reports `playbackGatedTurnComplete: false`, so the gate
 * engages; a mock client sender carries `supportsPlaybackStateProtocol`.
 * See dev_docs/framework/design-playback-end-gating-openai-native.md.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

/** Mock transport — generation-gated (`playbackGatedTurnComplete` defaults false). */
function createMockTransport(): LLMTransport {
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

/** Base64 of `ms` of 24 kHz 16-bit mono PCM (24000·2 = 48 bytes/ms). */
function pcmBase64(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

/** A 30 ms client mic frame (16 kHz PCM16) at the given amplitude. */
function micFrame(amplitude: number): Buffer {
	const f = Buffer.alloc(480 * 2);
	for (let i = 0; i < f.length; i += 2) f.writeInt16LE(amplitude, i);
	return f;
}

type JsonCall = [Record<string, unknown>];

function jsonOfType(sendJson: ReturnType<typeof vi.fn>, type: string): Record<string, unknown>[] {
	return sendJson.mock.calls
		.filter((c: JsonCall) => c[0]?.type === type)
		.map((c: JsonCall) => c[0]);
}

function setupNative(opts?: {
	nativePlaybackGating?: boolean;
	clientAudioVad?: { bargeInConfirmMs?: number };
	preSpeechStarted?: () => void;
}) {
	const transport = createMockTransport();
	if (opts?.preSpeechStarted) transport.onSpeechStarted = opts.preSpeechStarted;
	const sendAudio = vi.fn();
	const sendJson = vi.fn();
	const session = new VoiceSession({
		sessionId: 'sess_native_playback',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: true },
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: opts?.nativePlaybackGating ?? true,
		...(opts?.clientAudioVad ? { clientAudioVad: opts.clientAudioVad } : {}),
	});
	return { transport, sendJson, session };
}

describe('native playback-end gating — deferred completion', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('sends one audio.done at native turn-complete and does not finalize synchronously', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			const audioDone = jsonOfType(s.sendJson, 'audio.done');
			expect(audioDone).toHaveLength(1);
			expect(audioDone[0]).toMatchObject({ type: 'audio.done', playbackId: 1 });
			// Deferred — no turn.end yet.
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);
		} finally {
			await session?.close();
		}
	});

	it('sends no audio.done when nativePlaybackGating is off', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative({ nativePlaybackGating: false });
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(0);
			// Immediate finalize — the gate never engaged.
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('the fallback timer finalizes a native turn when no playback.ended arrives', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);

			// estimate (~1176 ms) + fallback margin (1500 ms).
			vi.advanceTimersByTime(3000);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a no-audio native turn does not engage the gate', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onTurnComplete?.(1); // no onAudioOutput

			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(0);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a tool-dispatching response does not engage the gate', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(400)); // a spoken preamble
			s.transport.onToolCall?.([{ id: 'c1', name: 'get_time', arguments: {} }]);
			s.transport.onTurnComplete?.(1);

			// _nativeResponseDispatchedToolCall is set → the gate is skipped.
			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(0);
		} finally {
			await session?.close();
		}
	});

	it('playback.ended completes a native turn before the fallback fires', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);

			// Advancing past the fallback adds no second turn.end.
			vi.advanceTimersByTime(5000);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('rejects a stale playback.ended (wrong playbackId)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 99 });
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0); // ignored

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1); // honoured
		} finally {
			await session?.close();
		}
	});

	it('rejects a premature playback.ended (before the gate is armed)', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			// playback.ended before onTurnComplete arms the gate.
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });

			s.transport.onTurnComplete?.(1);
			// The premature signal was dropped — completion still pends.
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);
		} finally {
			await session?.close();
		}
	});

	it('a duplicate / post-completion playback.ended is idempotent', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a client-VAD barge-in during the native playback-pending window interrupts', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative({ clientAudioVad: { bargeInConfirmMs: 0 } });
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session'); // → session ACTIVE

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);
			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(1);

			// User speaks loudly over the still-playing buffered audio.
			session.feedAudioFromClient(micFrame(2400));
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(1);

			// The gate was torn down — the fallback drives no second finalization.
			const turnEnds = jsonOfType(s.sendJson, 'turn.end').length;
			vi.advanceTimersByTime(5000);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(turnEnds);
		} finally {
			await session?.close();
		}
	});

	it('a sub-threshold (echo-level) client frame does not barge in', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative({ clientAudioVad: { bargeInConfirmMs: 0 } });
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session'); // → session ACTIVE

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			// Quiet, echo-level audio must not clear the barge-in energy floor.
			session.feedAudioFromClient(micFrame(80));
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(0);
		} finally {
			await session?.close();
		}
	});

	it('onSpeechStarted during the native playback-pending window interrupts', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			s.transport.onSpeechStarted?.();
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('onSpeechStarted outside the playback-pending window finalizes nothing', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			// No native turn armed — onSpeechStarted must be a no-op.
			s.transport.onSpeechStarted?.();
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(0);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);
		} finally {
			await session?.close();
		}
	});

	it('a pre-attached onSpeechStarted handler still fires (chaining)', async () => {
		let session: VoiceSession | undefined;
		const preAttached = vi.fn();
		try {
			const s = setupNative({ preSpeechStarted: preAttached });
			session = s.session;
			await session.start();

			s.transport.onSpeechStarted?.();
			expect(preAttached).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});

	it('a text_input during the native playback-pending window interrupts the turn', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session'); // handleTextInput needs ACTIVE

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			session.feedJsonFromClient({ type: 'text_input', text: 'wait, stop' });
			// handleTextInput is now async (serializes via the direct-input
			// FIFO). Flush a few microtask ticks so the queued body runs to
			// completion under fake timers.
			await vi.runAllTimersAsync();
			await Promise.resolve();
			await Promise.resolve();
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('injectTranscript during the window interrupts; outside it does not', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			// Outside any window — no interrupt.
			await session.injectTranscript('hello there');
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(0);

			// Inside the playback-pending window — interrupt first.
			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);
			await session.injectTranscript('actually, never mind');
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a playback.ended during an active VAD segment defers, then force-completes', async () => {
		let session: VoiceSession | undefined;
		try {
			// High bargeInConfirmMs — a loud frame marks the segment energy-eligible
			// but does not fire a barge-in, so the signal must defer.
			const s = setupNative({ clientAudioVad: { bargeInConfirmMs: 5000 } });
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session');

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			// User speech is mid-flight (a potential barge-in).
			session.feedAudioFromClient(micFrame(2400));
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			// Deferred — not completed while the VAD segment is unresolved.
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0);
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(0);

			// Mic frames stop — the bounded re-armed timer force-completes.
			vi.advanceTimersByTime(7000);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a deferred native turn that confirms as a barge-in is interrupted', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative({ clientAudioVad: { bargeInConfirmMs: 200 } });
			session = s.session;
			await session.start();
			s.transport.onSessionReady?.('mock_session');

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);

			// First frame — segment starts, energy-eligible, not yet confirmed.
			session.feedAudioFromClient(micFrame(2400));
			session.feedJsonFromClient({ type: 'playback.ended', playbackId: 1 });
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(0); // deferred

			// Sustained speech past bargeInConfirmMs confirms the barge-in.
			vi.advanceTimersByTime(250);
			session.feedAudioFromClient(micFrame(2400));
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(1);
		} finally {
			await session?.close();
		}
	});

	it('a barge-in during the playback-pending window finalizes exactly once', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setupNative();
			session = s.session;
			await session.start();

			s.transport.onModelTurnStart?.();
			s.transport.onAudioOutput?.(pcmBase64(1000));
			s.transport.onTurnComplete?.(1);
			expect(jsonOfType(s.sendJson, 'audio.done')).toHaveLength(1);

			s.transport.onInterrupted?.(1);
			expect(jsonOfType(s.sendJson, 'turn.interrupted')).toHaveLength(1);
			const turnEndAfterInterrupt = jsonOfType(s.sendJson, 'turn.end').length;

			// The fallback callback must not drive a second finalization.
			vi.advanceTimersByTime(5000);
			expect(jsonOfType(s.sendJson, 'turn.end')).toHaveLength(turnEndAfterInterrupt);
		} finally {
			await session?.close();
		}
	});
});
