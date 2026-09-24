import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	CancelResponseOptions,
	ContentTurn,
	LLMTransport,
	STTProvider,
	TransportCapabilities,
} from '../../src/types/transport.js';

/**
 * Shadow STT on a session: a second transcriber over the same client audio,
 * compared per turn with the transport's built-in transcription, and the
 * optional spoken correction (`divergenceCorrection`) that pre-empts the
 * wrong answer through the direct-input FIFO.
 *
 * The transport is an injected mock whose callbacks the tests drive directly.
 */

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({ text: 'subagent done' })),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

type MockStt = STTProvider & {
	configure: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	feedAudio: ReturnType<typeof vi.fn>;
	commit: ReturnType<typeof vi.fn>;
	handleInterrupted: ReturnType<typeof vi.fn>;
	handleTurnComplete: ReturnType<typeof vi.fn>;
};

function createMockStt(): MockStt {
	return {
		configure: vi.fn(),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		feedAudio: vi.fn(),
		commit: vi.fn(),
		handleInterrupted: vi.fn(),
		handleTurnComplete: vi.fn(),
		onTranscript: undefined,
		onPartialTranscript: undefined,
	};
}

interface MockTransportHandle {
	transport: LLMTransport;
	/** The raw spies: the dictation controller replaces `transport.sendContent`
	 *  and `sendLiveText` with guarded wrappers, so assertions read these. */
	sendLiveText: ReturnType<typeof vi.fn>;
	sendContent: ReturnType<typeof vi.fn>;
	cancelResponse: ReturnType<typeof vi.fn>;
	/** Wire-order log of cancels, sends and interrupted turns. */
	order: string[];
}

function createMockTransport(): MockTransportHandle {
	const order: string[] = [];
	const sendLiveText = vi.fn((_turns: ContentTurn[]) => {
		order.push('sendLiveText');
		return true;
	});
	const sendContent = vi.fn((_turns: ContentTurn[], _turnComplete?: boolean) => {
		order.push('sendContent');
	});
	const cancelResponse = vi.fn(async (_opts?: CancelResponseOptions) => {
		order.push('cancelResponse');
	});
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
		sendContent,
		sendLiveText,
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
		cancelResponse,
	};
	return { transport, sendLiveText, sendContent, cancelResponse, order };
}

interface SessionInternals {
	turns: { numericId: number; active(): unknown };
	transcriptManager: { handleInput(text: string, turnId?: number): void };
	hold: { engage(): void };
	handleTextInput(text: string): Promise<void>;
}

function internals(session: VoiceSession): SessionInternals {
	return session as unknown as SessionInternals;
}

/** Base64 of `ms` of 24 kHz 16-bit mono PCM (48 bytes/ms). */
function pcm(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

/** Let the direct-input FIFO run its queued bodies to completion. */
function settle(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

describe('VoiceSession shadow STT', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	function createSession(handle: MockTransportHandle, overrides: Partial<VoiceSessionConfig>) {
		const log = vi.fn();
		const sendJson = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_shadow',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport: handle.transport,
			clientSender: { sendAudio: vi.fn(), sendJson },
			log,
			...overrides,
		});
		return { session, log, sendJson };
	}

	/** A started session with a client attached and the upstream ready. */
	async function startSession(handle: MockTransportHandle, overrides: Partial<VoiceSessionConfig>) {
		const created = createSession(handle, overrides);
		await created.session.start();
		created.session.notifyClientConnected();
		handle.transport.onSessionReady?.('mock_session');
		await new Promise((r) => setTimeout(r, 5));
		return created;
	}

	/** The model starts answering (a wrong answer, from the shadow's view). */
	function startModelTurn(handle: MockTransportHandle): void {
		handle.transport.onModelTurnStart?.();
		handle.transport.onAudioOutput?.(pcm(200));
	}

	function logLines(log: ReturnType<typeof vi.fn>): string[] {
		return log.mock.calls.map((c) => String(c[0]));
	}

	function jsonOfType(sendJson: ReturnType<typeof vi.fn>, type: string): unknown[] {
		return sendJson.mock.calls
			.map((c) => c[0] as { type?: string })
			.filter((m) => m?.type === type);
	}

	// ─── Wiring ───────────────────────────────────────────────────────────────

	it('configures the shadow with the client audio format and installs its onTranscript', () => {
		const shadow = createMockStt();
		createSession(createMockTransport(), {
			shadowSttProvider: shadow,
			clientAudioInputRate: 24000,
		});

		expect(shadow.configure).toHaveBeenCalledTimes(1);
		expect(shadow.configure).toHaveBeenCalledWith({
			sampleRate: 24000,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		});
		expect(shadow.onTranscript).toBeTypeOf('function');
	});

	it("live hears 'What is this news', shadow hears 'What is this': the divergence hook fires once", () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const divergences: Array<{ live: string; shadow: string; turnId?: number }> = [];
		const { session } = createSession(handle, {
			shadowSttProvider: shadow,
			onTranscriptionDivergence: (live, heard, turnId) =>
				divergences.push({ live, shadow: heard, turnId }),
		});

		// Built-in transcription accumulates in deltas…
		handle.transport.onInputTranscription?.('What is ');
		handle.transport.onInputTranscription?.('this news');
		// …the model starts answering, which commits the turn…
		handle.transport.onModelTurnStart?.();
		const turnId = internals(session).turns.numericId;
		expect(shadow.commit).toHaveBeenCalledWith(turnId);
		// …and the shadow's transcript for that turn arrives later.
		shadow.onTranscript?.('What is this', turnId);

		expect(divergences).toEqual([{ live: 'What is this news', shadow: 'What is this', turnId }]);
	});

	it('identical hearing yields no divergence, and each turn compares against its own snapshot', () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const onTranscriptionDivergence = vi.fn();
		const { session } = createSession(handle, {
			shadowSttProvider: shadow,
			onTranscriptionDivergence,
		});

		handle.transport.onInputTranscription?.('What is this');
		startModelTurn(handle);
		const firstTurn = internals(session).turns.numericId;
		handle.transport.onTurnComplete?.();
		expect(internals(session).turns.numericId).toBe(firstTurn + 1);

		// The next turn is heard before the first turn's shadow result lands.
		handle.transport.onInputTranscription?.('Hello, Lucy');
		shadow.onTranscript?.('What is this', firstTurn);
		startModelTurn(handle);
		const secondTurn = internals(session).turns.numericId;
		shadow.onTranscript?.('Hello, Lucy', secondTurn);

		expect(shadow.commit.mock.calls.map((c) => c[0])).toEqual([firstTurn, secondTurn]);
		expect(onTranscriptionDivergence).not.toHaveBeenCalled();
	});

	it("a trailing model start for a finalized turn does not use up the next turn's commit", () => {
		const handle = createMockTransport();
		let activeServerTurnId = 1;
		handle.transport.getActiveServerTurnId = () => activeServerTurnId;
		const shadow = createMockStt();
		const onTranscriptionDivergence = vi.fn();
		const { session } = createSession(handle, {
			shadowSttProvider: shadow,
			onTranscriptionDivergence,
		});

		handle.transport.onInputTranscription?.('Good morning');
		startModelTurn(handle);
		const firstTurn = internals(session).turns.numericId;
		handle.transport.onTurnComplete?.(1);
		expect(internals(session).turns.numericId).toBe(firstTurn + 1);

		// A late model start for the finalized server turn: the counter has
		// already moved on, and nothing may be committed for the next turn yet.
		handle.transport.onModelTurnStart?.();
		expect(shadow.commit.mock.calls.map((c) => c[0])).toEqual([firstTurn]);

		// The next turn is heard, and its own model start commits it…
		handle.transport.onInputTranscription?.('What is this news');
		activeServerTurnId = 2;
		startModelTurn(handle);
		const secondTurn = internals(session).turns.numericId;
		expect(secondTurn).toBe(firstTurn + 1);
		expect(shadow.commit.mock.calls.map((c) => c[0])).toEqual([firstTurn, secondTurn]);

		// …so its shadow result is compared against that turn's own transcript.
		shadow.onTranscript?.('What is this', secondTurn);
		expect(onTranscriptionDivergence).toHaveBeenCalledTimes(1);
		expect(onTranscriptionDivergence).toHaveBeenCalledWith(
			'What is this news',
			'What is this',
			secondTurn,
		);
	});

	it('feedAudioFromClient reaches the shadow after start(), and close() stops it', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const { session } = await startSession(handle, { shadowSttProvider: shadow });
		expect(shadow.start).toHaveBeenCalled();

		const frame = Buffer.alloc(320, 1);
		session.feedAudioFromClient(frame);
		expect(shadow.feedAudio).toHaveBeenCalledWith(frame.toString('base64'));

		await session.close();
		expect(shadow.stop).toHaveBeenCalled();
	});

	it('a shadow stop() that rejects on RECONNECTING is logged, not left unhandled', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const handle = createMockTransport();
			let stopCalls = 0;
			const shadow: STTProvider = {
				...createMockStt(),
				// A plain function rather than vi.fn: a mock observes the promise it
				// returns, which would mark the rejection handled.
				stop: () => {
					stopCalls++;
					return Promise.reject(new Error('shadow stop boom'));
				},
			};
			const { session, log } = await startSession(handle, { shadowSttProvider: shadow });

			session.sessionManager.transitionTo('RECONNECTING');
			await new Promise((r) => setTimeout(r, 20));

			expect(stopCalls).toBe(1);
			expect(unhandled).not.toHaveBeenCalled();
			expect(logLines(log)).toContainEqual(
				expect.stringContaining('[ShadowSTT] stop failed: shadow stop boom'),
			);
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	it('is ignored, with a log line, when sttProvider replaces built-in transcription', async () => {
		const handle = createMockTransport();
		const stt = createMockStt();
		const shadow = createMockStt();
		const { session, log } = await startSession(handle, {
			sttProvider: stt,
			shadowSttProvider: shadow,
		});

		expect(shadow.configure).not.toHaveBeenCalled();
		expect(shadow.onTranscript).toBeUndefined();
		expect(logLines(log)).toContainEqual(
			expect.stringContaining(
				'[ShadowSTT] ignored — sttProvider already replaces built-in transcription',
			),
		);

		session.feedAudioFromClient(Buffer.alloc(320, 1));
		startModelTurn(handle);
		expect(stt.feedAudio).toHaveBeenCalledTimes(1);
		expect(shadow.feedAudio).not.toHaveBeenCalled();
		expect(shadow.start).not.toHaveBeenCalled();
		expect(shadow.commit).not.toHaveBeenCalled();
	});

	it('rejects a shadow provider that is the same instance as whisperProvider', () => {
		const shared = createMockStt();
		expect(() =>
			createSession(createMockTransport(), {
				shadowSttProvider: shared,
				whisperProvider: shared,
			}),
		).toThrow(ValidationError);
		// Rejected before either consumer configured the shared instance.
		expect(shared.configure).not.toHaveBeenCalled();
		expect(shared.onTranscript).toBeUndefined();
	});

	it('with distinct providers, dictation still fills its buffer across a mode switch', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const whisper = createMockStt();
		const { session } = await startSession(handle, {
			shadowSttProvider: shadow,
			whisperProvider: whisper,
		});
		const shadowCallback = shadow.onTranscript;
		expect(whisper.configure).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 24000 }));
		expect(shadow.configure).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 16000 }));

		await session.setTranscriptionMode('transcription');
		whisper.onTranscript?.('first dictated line', undefined);
		expect(session.getDictationBuffer()).toBe('first dictated line');

		await session.setTranscriptionMode('agent');
		whisper.onTranscript?.('and a late one', undefined);
		expect(session.getDictationBuffer()).toBe('first dictated line and a late one');

		expect(shadow.onTranscript).toBe(shadowCallback);
		expect(whisper.onTranscript).not.toBe(shadowCallback);
	});

	// ─── Correction ───────────────────────────────────────────────────────────

	it('a current-turn divergence interrupts the wrong answer, then sends one correction', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const { session, sendJson } = await startSession(handle, {
			shadowSttProvider: shadow,
			divergenceCorrection: true,
		});
		const interrupted: string[] = [];
		session.eventBus.subscribe('turn.interrupted', (p) => {
			interrupted.push(p.turnId);
			handle.order.push('turn.interrupted');
		});
		handle.transport.onInputTranscription?.('What is this news');
		startModelTurn(handle);
		const turnId = internals(session).turns.numericId;
		handle.order.length = 0;

		shadow.onTranscript?.('What is this', turnId);
		await settle();

		// The wrong answer is cut through the session's own interrupt path…
		expect(handle.cancelResponse).toHaveBeenCalledTimes(1);
		expect(interrupted).toHaveLength(1);
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(1);
		// …which advances the turn without invalidating the correction queued for it.
		expect(internals(session).turns.numericId).toBe(turnId + 1);
		expect(handle.order).toEqual(['cancelResponse', 'turn.interrupted', 'sendLiveText']);
		expect(handle.sendLiveText).toHaveBeenCalledTimes(1);
		const [turns] = handle.sendLiveText.mock.calls[0] as [ContentTurn[]];
		expect(turns).toHaveLength(1);
		expect(turns[0].role).toBe('user');
		expect(turns[0].text).toContain('TRANSCRIPTION CORRECTION');
		expect(turns[0].text).toContain('"What is this"');
		// A framework-generated correction is not recorded as conversation.
		expect(
			session.conversationContext.items.some((i) => i.content.includes('TRANSCRIPTION CORRECTION')),
		).toBe(false);
	});

	it('a stale turn never fires a correction', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const onTranscriptionDivergence = vi.fn();
		const { session } = await startSession(handle, {
			shadowSttProvider: shadow,
			divergenceCorrection: true,
			onTranscriptionDivergence,
		});
		handle.transport.onInputTranscription?.('What is this news');
		startModelTurn(handle);
		const staleTurn = internals(session).turns.numericId;
		// The answer completes before the shadow result lands.
		handle.transport.onTurnComplete?.();

		shadow.onTranscript?.('What is this', staleTurn);
		await settle();

		expect(onTranscriptionDivergence).toHaveBeenCalledTimes(1);
		expect(handle.cancelResponse).not.toHaveBeenCalled();
		expect(handle.sendLiveText).not.toHaveBeenCalled();
	});

	it('with divergenceCorrection off a divergence is only reported', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const onTranscriptionDivergence = vi.fn();
		const { session, sendJson } = await startSession(handle, {
			shadowSttProvider: shadow,
			onTranscriptionDivergence,
		});
		handle.transport.onInputTranscription?.('What is this news');
		startModelTurn(handle);

		shadow.onTranscript?.('What is this', internals(session).turns.numericId);
		await settle();

		expect(onTranscriptionDivergence).toHaveBeenCalledTimes(1);
		expect(handle.cancelResponse).not.toHaveBeenCalled();
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(0);
		expect(handle.sendLiveText).not.toHaveBeenCalled();
	});

	it('a correction queued behind newer typed input that pre-empted the turn is abandoned', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const { session, log, sendJson } = await startSession(handle, {
			shadowSttProvider: shadow,
			divergenceCorrection: true,
		});
		handle.transport.onInputTranscription?.('What is this news');
		startModelTurn(handle);
		const turnId = internals(session).turns.numericId;
		handle.sendContent.mockClear();

		// Typed input is queued first; the shadow result lands while it waits.
		const typed = internals(session).handleTextInput('a newer question');
		shadow.onTranscript?.('What is this', turnId);
		await typed;
		await settle();

		// Only the typed input pre-empted; the correction sent nothing.
		expect(handle.cancelResponse).toHaveBeenCalledTimes(1);
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(1);
		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(handle.sendContent).toHaveBeenCalledTimes(1);
		expect(handle.sendContent).toHaveBeenCalledWith(
			[{ role: 'user', text: 'a newer question' }],
			true,
		);
		expect(logLines(log)).toContainEqual(
			expect.stringContaining('injectText (shadow-stt-correction): not sent — no longer valid'),
		);
	});

	it('sends nothing in transcription mode', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const { session, log, sendJson } = await startSession(handle, {
			shadowSttProvider: shadow,
			whisperProvider: createMockStt(),
			divergenceCorrection: true,
		});
		handle.transport.onInputTranscription?.('What is this news');
		startModelTurn(handle);
		const turnId = internals(session).turns.numericId;
		await session.setTranscriptionMode('transcription');
		handle.sendContent.mockClear();

		shadow.onTranscript?.('What is this', turnId);
		await settle();

		expect(handle.cancelResponse).not.toHaveBeenCalled();
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(0);
		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(handle.sendContent).not.toHaveBeenCalled();
		expect(logLines(log)).toContainEqual(
			expect.stringContaining('injectText (shadow-stt-correction): not sent — transcription mode'),
		);
	});

	it('never feeds its transcript to transcriptManager.handleInput', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const { session } = await startSession(handle, {
			shadowSttProvider: shadow,
			divergenceCorrection: true,
		});
		const handleInput = vi.spyOn(internals(session).transcriptManager, 'handleInput');

		handle.transport.onInputTranscription?.('What is this news');
		startModelTurn(handle);
		expect(handleInput).toHaveBeenCalledTimes(1);
		expect(handleInput).toHaveBeenCalledWith('What is this news');

		shadow.onTranscript?.('What is this', internals(session).turns.numericId);
		await settle();

		expect(handle.sendLiveText).toHaveBeenCalledTimes(1);
		expect(handleInput).toHaveBeenCalledTimes(1);
	});

	it('is suppressed while the synthetic-output hold is active', async () => {
		const handle = createMockTransport();
		const shadow = createMockStt();
		const { session, log, sendJson } = await startSession(handle, {
			shadowSttProvider: shadow,
			divergenceCorrection: true,
		});
		handle.transport.onInputTranscription?.('What is this news');
		startModelTurn(handle);
		const turnId = internals(session).turns.numericId;
		internals(session).hold.engage();
		expect(session.isSyntheticHoldActive()).toBe(true);

		shadow.onTranscript?.('What is this', turnId);
		await settle();

		// The in-flight turn is left alone and nothing is sent.
		expect(handle.cancelResponse).not.toHaveBeenCalled();
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(0);
		expect(internals(session).turns.active()).not.toBeNull();
		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(logLines(log)).toContainEqual(
			expect.stringContaining(
				'injectText (shadow-stt-correction): not sent — synthetic output is held',
			),
		);
	});
});
