import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	ContentTurn,
	LLMTransport,
	STTAudioConfig,
	STTProvider,
	TransportCapabilities,
	TransportToolResult,
} from '../../src/types/transport.js';

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function mainAgent(): MainAgent {
	return { name: 'main', instructions: 'You are helpful.', tools: [] };
}

// ───────────────────────────────────────────────────────────────────────
// Minimal LLMTransport mock — only fields VoiceSession reads in this file.
// ───────────────────────────────────────────────────────────────────────

interface MockTransport extends LLMTransport {
	__sentAudio: string[];
	__sentContent: ContentTurn[][];
	__quiesceCount: number;
	__unquiesceCount: number;
}

function createMockTransport(
	opts: { audioFormat?: AudioFormatSpec; quiescible?: boolean } = {},
): MockTransport {
	const sentAudio: string[] = [];
	const sentContent: ContentTurn[][] = [];
	let quiesceCount = 0;
	let unquiesceCount = 0;

	const audioFormat: AudioFormatSpec = opts.audioFormat ?? {
		inputSampleRate: 24000,
		outputSampleRate: 24000,
		channels: 1,
		bitDepth: 16,
		encoding: 'pcm',
	};

	const capabilities: TransportCapabilities = {
		messageTruncation: true,
		turnDetection: true,
		userTranscription: true,
		inPlaceSessionUpdate: true,
		sessionResumption: false,
		contextCompression: false,
		groundingMetadata: false,
		textResponseModality: true,
		quiescible: opts.quiescible ?? true,
	};

	const transport: Partial<MockTransport> = {
		capabilities,
		audioFormat,
		isConnected: true,
		connect: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		reconnect: vi.fn(async () => {}),
		sendAudio: (b64: string) => {
			sentAudio.push(b64);
		},
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn(async () => {}),
		sendContent: (turns: ContentTurn[]) => {
			sentContent.push(turns);
		},
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};

	if (opts.quiescible !== false) {
		transport.quiesce = async () => {
			quiesceCount += 1;
		};
		transport.unquiesce = async () => {
			unquiesceCount += 1;
		};
	}

	const result = transport as MockTransport;
	Object.defineProperty(result, '__sentAudio', { get: () => sentAudio });
	Object.defineProperty(result, '__sentContent', { get: () => sentContent });
	Object.defineProperty(result, '__quiesceCount', { get: () => quiesceCount });
	Object.defineProperty(result, '__unquiesceCount', { get: () => unquiesceCount });
	return result;
}

// ───────────────────────────────────────────────────────────────────────
// Minimal STTProvider mock for the whisperProvider slot.
// ───────────────────────────────────────────────────────────────────────

interface MockSttProvider extends STTProvider {
	__started: boolean;
	__startCount: number;
	__stopCount: number;
	__fed: string[];
	__triggerTranscript(text: string): void;
	__configuredEncoding?: 'pcm' | 'pcmu';
}

function createMockSttProvider(): MockSttProvider {
	const fed: string[] = [];
	let started = false;
	let startCount = 0;
	let stopCount = 0;
	let configuredEncoding: 'pcm' | 'pcmu' | undefined;

	const provider: Partial<MockSttProvider> = {
		supportedEncodings: ['pcm'],
		configure(audio: STTAudioConfig) {
			configuredEncoding = audio.encoding ?? 'pcm';
		},
		async start() {
			// Idempotent — matches the real OpenAIRealtimeWhisperSTTProvider contract.
			if (started) return;
			startCount += 1;
			started = true;
		},
		async stop() {
			// Idempotent.
			if (!started) return;
			stopCount += 1;
			started = false;
		},
		feedAudio(b64: string) {
			fed.push(b64);
		},
		commit: vi.fn(),
		handleInterrupted: vi.fn(),
		handleTurnComplete: vi.fn(),
		onTranscript: undefined,
	};

	const result = provider as MockSttProvider;
	Object.defineProperty(result, '__started', { get: () => started });
	Object.defineProperty(result, '__startCount', { get: () => startCount });
	Object.defineProperty(result, '__stopCount', { get: () => stopCount });
	Object.defineProperty(result, '__fed', { get: () => fed });
	Object.defineProperty(result, '__configuredEncoding', { get: () => configuredEncoding });
	result.__triggerTranscript = (text: string) => result.onTranscript?.(text, undefined);
	return result;
}

// ───────────────────────────────────────────────────────────────────────
// Helper: build a minimal VoiceSession against the mocks.
// ───────────────────────────────────────────────────────────────────────

function buildSession(opts: {
	transport: LLMTransport;
	whisperProvider?: STTProvider;
	transcriptionMode?: 'agent' | 'transcription';
}): VoiceSession {
	return new VoiceSession({
		sessionId: 'test-session',
		userId: 'test-user',
		apiKey: 'test-key',
		geminiModel: 'gemini-2.5-flash',
		model: mockModel,
		agents: [mainAgent()],
		initialAgent: 'main',
		port: 0,
		transport: opts.transport,
		whisperProvider: opts.whisperProvider,
		transcriptionMode: opts.transcriptionMode,
	});
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('VoiceSession — Phase 3 transcription mode', () => {
	let session: VoiceSession;

	afterEach(async () => {
		await session?.close('test cleanup').catch(() => {});
	});

	describe('construction', () => {
		it('default mode is agent', () => {
			const t = createMockTransport();
			session = buildSession({ transport: t });
			expect(session.getTranscriptionMode()).toBe('agent');
		});

		it('throws if whisperProvider === sttProvider', () => {
			const t = createMockTransport();
			const shared = createMockSttProvider();
			expect(
				() =>
					new VoiceSession({
						sessionId: 'test-session',
						userId: 'test-user',
						apiKey: 'test-key',
						geminiModel: 'gemini-2.5-flash',
						model: mockModel,
						agents: [mainAgent()],
						initialAgent: 'main',
						port: 0,
						transport: t,
						sttProvider: shared,
						whisperProvider: shared,
					}),
			).toThrow(/distinct instance/);
		});

		it('initial transcriptionMode=transcription sets internal mode without flipping', () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({
				transport: t,
				whisperProvider: whisper,
				transcriptionMode: 'transcription',
			});
			// Public mode reflects the request even before audio flows
			expect(session.getTranscriptionMode()).toBe('transcription');
		});

		it('wires whisperProvider.onTranscript to the dictation buffer (not ConversationContext)', () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			whisper.__triggerTranscript('hello world');
			expect(session.getDictationBuffer()).toBe('hello world');
		});
	});

	describe('setTranscriptionMode (round-trip)', () => {
		it('agent → transcription quiesces the transport, starts whisper, emits event', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			const events: unknown[] = [];
			session.eventBus.subscribe('session.transcription_mode_changed', (e) => events.push(e));

			await session.setTranscriptionMode('transcription');

			expect(t.__quiesceCount).toBe(1);
			expect(t.clearAudio).toHaveBeenCalled();
			expect(whisper.__startCount).toBe(1);
			expect(session.getTranscriptionMode()).toBe('transcription');
			expect(events).toHaveLength(1);
			expect((events[0] as { mode: string }).mode).toBe('transcription');
		});

		it('transcription → agent unquiesces the transport, stops whisper, emits event', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			await session.setTranscriptionMode('transcription');
			const events: unknown[] = [];
			session.eventBus.subscribe('session.transcription_mode_changed', (e) => events.push(e));

			await session.setTranscriptionMode('agent');

			expect(t.__unquiesceCount).toBe(1);
			expect(whisper.__stopCount).toBe(1);
			expect(session.getTranscriptionMode()).toBe('agent');
			expect(events).toHaveLength(1);
			expect((events[0] as { mode: string }).mode).toBe('agent');
		});

		it('is idempotent — repeated setTranscriptionMode(same) is a no-op', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			await session.setTranscriptionMode('transcription');
			await session.setTranscriptionMode('transcription');
			expect(whisper.__startCount).toBe(1);
		});

		it('throws if no whisperProvider is configured', async () => {
			const t = createMockTransport();
			session = buildSession({ transport: t });
			await expect(session.setTranscriptionMode('transcription')).rejects.toThrow(
				/no whisperProvider/,
			);
		});

		it('serialises with concurrent transferSession() calls via the mutation queue', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			// Two concurrent flips — second must wait for the first.
			const [a, b] = await Promise.all([
				session.setTranscriptionMode('transcription'),
				session.setTranscriptionMode('agent'),
			]);
			void a;
			void b;
			expect(whisper.__startCount).toBe(1);
			expect(whisper.__stopCount).toBe(1);
			// Final state depends on ordering; either resolution is correct so long as
			// both calls ran without overlapping.
		});

		it('falls back to framework-layer guard when transport is not quiescible', async () => {
			const t = createMockTransport({ quiescible: false });
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			await session.setTranscriptionMode('transcription');
			// quiesce() should NOT have been called (it's undefined on this transport).
			expect(t.quiesce).toBeUndefined();
			// Whisper still starts — the mode flip succeeds.
			expect(whisper.__startCount).toBe(1);
			expect(session.getTranscriptionMode()).toBe('transcription');
		});
	});

	describe('prewarmTranscriptionMode', () => {
		it('starts whisper without changing the public mode', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			await session.prewarmTranscriptionMode();
			expect(whisper.__startCount).toBe(1);
			expect(session.getTranscriptionMode()).toBe('agent');

			// Subsequent setTranscriptionMode('transcription') re-uses the
			// already-started whisper (idempotent start).
			await session.setTranscriptionMode('transcription');
			expect(whisper.__startCount).toBe(1);
		});
	});

	describe('dictation buffer + injection', () => {
		it('dictation transcripts append; getDictationBuffer joins with spaces', () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			whisper.__triggerTranscript('hello');
			whisper.__triggerTranscript('world');
			expect(session.getDictationBuffer()).toBe('hello world');
		});

		it('clearDictationBuffer discards without injecting', () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			whisper.__triggerTranscript('drop me');
			session.clearDictationBuffer();
			expect(session.getDictationBuffer()).toBe('');
			expect(t.__sentContent).toHaveLength(0);
		});

		it('injectDictationBuffer writes to transport AND ConversationContext, then clears', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			// Round-trip through transcription mode so the dictation buffer is the source.
			await session.setTranscriptionMode('transcription');
			whisper.__triggerTranscript('please respond');
			await session.setTranscriptionMode('agent');

			await session.injectDictationBuffer();

			expect(t.__sentContent).toHaveLength(1);
			expect(t.__sentContent[0]).toEqual([{ role: 'user', text: 'please respond' }]);
			// ConversationContext should now have the user turn.
			const items = session.conversationContext.items;
			const hasUserMsg = items.some(
				(it) => it.role === 'user' && it.content.includes('please respond'),
			);
			expect(hasUserMsg).toBe(true);
			// Buffer cleared.
			expect(session.getDictationBuffer()).toBe('');
		});

		it('injectDictationBuffer is a no-op when not in agent mode', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });

			await session.setTranscriptionMode('transcription');
			whisper.__triggerTranscript('dictating');
			await session.injectDictationBuffer();
			expect(t.__sentContent).toHaveLength(0);
			expect(session.getDictationBuffer()).toBe('dictating');
		});
	});

	describe('guardedTriggerGeneration', () => {
		it('forwards in agent mode', () => {
			const t = createMockTransport();
			session = buildSession({ transport: t });
			session.guardedTriggerGeneration('hi');
			expect(t.triggerGeneration).toHaveBeenCalledWith('hi', undefined);
		});

		it('throws TRANSCRIPTION_MODE_LOCKED in transcription mode', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });
			await session.setTranscriptionMode('transcription');

			expect(() => session.guardedTriggerGeneration('hi')).toThrow(/TRANSCRIPTION_MODE_LOCKED/);
		});
	});

	describe('audio routing by mode', () => {
		it('agent mode: PCM → transport.sendAudio + sttProvider.feedAudio', () => {
			const t = createMockTransport();
			session = buildSession({ transport: t });

			// biome-ignore lint/suspicious/noExplicitAny: invoke private state machine for routing test
			(session as any).sessionManager.transitionTo('CONNECTING');
			// biome-ignore lint/suspicious/noExplicitAny: invoke private state machine for routing test
			(session as any).sessionManager.transitionTo('ACTIVE');
			session.feedAudioFromClient(Buffer.from([0, 0, 0, 0]));

			expect(t.__sentAudio).toHaveLength(1);
		});

		it('transcription mode: PCM → whisperProvider.feedAudio (not transport)', async () => {
			const t = createMockTransport();
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });
			await session.setTranscriptionMode('transcription');

			// biome-ignore lint/suspicious/noExplicitAny: invoke private state machine for routing test
			(session as any).sessionManager.transitionTo('CONNECTING');
			// biome-ignore lint/suspicious/noExplicitAny: invoke private state machine for routing test
			(session as any).sessionManager.transitionTo('ACTIVE');
			session.feedAudioFromClient(Buffer.from([0, 0, 0, 0]));

			expect(whisper.__fed).toHaveLength(1);
			// Transport should not see new audio (it might have received earlier session-setup audio,
			// but the just-fed frame should not have landed there).
			const audioBefore = t.__sentAudio.length;
			session.feedAudioFromClient(Buffer.from([1, 1, 1, 1]));
			expect(t.__sentAudio).toHaveLength(audioBefore);
			expect(whisper.__fed).toHaveLength(2);
		});
	});

	describe('cross-provider: Whisper at 24 kHz + transport at 16 kHz', () => {
		it('resamples 16 kHz mic audio to 24 kHz before whisper.feedAudio', async () => {
			const t = createMockTransport({
				audioFormat: {
					inputSampleRate: 16000,
					outputSampleRate: 24000,
					channels: 1,
					bitDepth: 16,
					encoding: 'pcm',
				},
			});
			const whisper = createMockSttProvider();
			session = buildSession({ transport: t, whisperProvider: whisper });
			await session.setTranscriptionMode('transcription');

			// Feed 1600 samples (= 100 ms @ 16 kHz) = 3200 bytes PCM16.
			const pcm16k = Buffer.alloc(3200);
			// biome-ignore lint/suspicious/noExplicitAny: invoke private state machine for routing test
			(session as any).sessionManager.transitionTo('CONNECTING');
			// biome-ignore lint/suspicious/noExplicitAny: invoke private state machine for routing test
			(session as any).sessionManager.transitionTo('ACTIVE');
			session.feedAudioFromClient(pcm16k);

			expect(whisper.__fed).toHaveLength(1);
			// At 24 kHz, 100 ms = 2400 samples = 4800 bytes. base64 length ≈ 4 * ceil(4800/3) = 6400.
			const fedBytes = Buffer.from(whisper.__fed[0], 'base64').length;
			expect(fedBytes).toBe(4800);
		});
	});
});
