import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import type { InjectTextOptions } from '../../src/index.js';
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
 * Session injection seams: `injectText(input, { mode })` and
 * `sendRealtimeMedia(base64, mime)`, plus the private `injectTextInternal`
 * behind `injectText`, whose `preempt` / `respectSyntheticHold` /
 * `stillValid` options framework-generated corrections use.
 *
 * Wire shapes are asserted on the built-in Gemini transport over a mocked
 * SDK; the preemption, hold and mode cases run on an injected mock transport.
 */

declare module '@google/genai' {
	function _getMessageHandler(): ((message: unknown) => void) | null;
	function _getMockSession(): Record<string, ReturnType<typeof vi.fn>> | null;
}

vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	let mockSession: Record<string, ReturnType<typeof vi.fn>> | null = null;

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					// Fire setupComplete so connect() resolves (it awaits this)
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					mockSession = {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
					return mockSession;
				}),
			},
		})),
		_getMessageHandler: () => messageHandler,
		_getMockSession: () => mockSession,
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({ text: 'subagent done' })),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(greeting?: string): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: [],
		...(greeting ? { greeting } : {}),
	};
}

/** Options of the private `injectTextInternal`. */
type InternalInjectOptions = InjectTextOptions & {
	preempt?: boolean;
	respectSyntheticHold?: boolean;
	stillValid?: () => boolean;
	origin?: string;
};

interface SessionInternals {
	injectTextInternal(input: string | ContentTurn[], opts: InternalInjectOptions): Promise<boolean>;
	isSyntheticHoldActive(): boolean;
	handleTextInput(text: string): Promise<void>;
	turns: { numericId: number; active(): unknown };
}

function internals(session: VoiceSession): SessionInternals {
	return session as unknown as SessionInternals;
}

/** Base64 of `ms` of 24 kHz 16-bit mono PCM (48 bytes/ms). */
function pcm(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

// ─── Injected mock transport ──────────────────────────────────────────────

interface MockTransportHandle {
	transport: LLMTransport;
	/** The raw spies: the session's dictation controller replaces
	 *  `transport.sendContent` / `sendLiveText` with guarded wrappers, so
	 *  assertions read these, not the transport's current members. */
	sendLiveText: ReturnType<typeof vi.fn>;
	sendContent: ReturnType<typeof vi.fn>;
	sendFile: ReturnType<typeof vi.fn>;
	cancelResponse: ReturnType<typeof vi.fn>;
	setConnected(connected: boolean): void;
	/** Wire-order log of cancels and sends. */
	order: string[];
}

function createMockTransport(opts: { liveText?: boolean } = {}): MockTransportHandle {
	let connected = true;
	const order: string[] = [];
	const sendLiveText = vi.fn((_turns: ContentTurn[]) => {
		order.push('sendLiveText');
		return true;
	});
	const sendContent = vi.fn((_turns: ContentTurn[], _turnComplete?: boolean) => {
		order.push('sendContent');
	});
	const sendFile = vi.fn();
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
		get isConnected() {
			return connected;
		},
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent,
		sendFile,
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
		cancelResponse,
	};
	if (opts.liveText !== false) transport.sendLiveText = sendLiveText;
	return {
		transport,
		sendLiveText,
		sendContent,
		sendFile,
		cancelResponse,
		setConnected: (value) => {
			connected = value;
		},
		order,
	};
}

function createWhisperProvider(): STTProvider {
	return {
		configure: vi.fn(),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		feedAudio: vi.fn(),
		commit: vi.fn(),
		handleInterrupted: vi.fn(),
		handleTurnComplete: vi.fn(),
	};
}

describe('VoiceSession injection seams', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	/** A started legacy-mode session over the mock transport, upstream ready. */
	async function startMockSession(
		handle: MockTransportHandle,
		overrides: Partial<VoiceSessionConfig> = {},
	) {
		const log = vi.fn();
		const sendJson = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_inject',
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
		await session.start();
		session.notifyClientConnected();
		handle.transport.onSessionReady?.('mock_session');
		await new Promise((r) => setTimeout(r, 5));
		return { session, log, sendJson };
	}

	/** Begin a model response with audio, so the session has an in-flight turn. */
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

	// ─── Wire shapes on the built-in Gemini transport ─────────────────────────

	describe('on the Gemini transport', () => {
		async function startGeminiSession(overrides: Partial<VoiceSessionConfig> = {}) {
			const log = vi.fn();
			session = new VoiceSession({
				sessionId: 'sess_inject_gemini',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createAgent()],
				initialAgent: 'main',
				model: mockModel,
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				log,
				...overrides,
			});
			await session.start();
			const { _getMockSession } = await import('@google/genai');
			const sdk = _getMockSession();
			if (!sdk) throw new Error('no live Gemini session');
			sdk.sendRealtimeInput.mockClear();
			sdk.sendClientContent.mockClear();
			return { session, sdk, log };
		}

		it('live mode sends realtime text and leaves conversationContext.items unchanged', async () => {
			const { session, sdk } = await startGeminiSession();
			const before = [...session.conversationContext.items];

			const sent = await session.injectText(
				[
					{ role: 'user', text: 'What changed?' },
					{ role: 'assistant', text: 'The build finished.' },
				],
				{ mode: 'live' },
			);

			expect(sent).toBe(true);
			// Realtime text with role prefixes: the live-text path, not the
			// sendContent facade (which joins turns without prefixes).
			expect(sdk.sendRealtimeInput).toHaveBeenCalledTimes(1);
			expect(sdk.sendRealtimeInput).toHaveBeenCalledWith({
				text: 'user: What changed?\nmodel: The build finished.',
			});
			expect(sdk.sendClientContent).not.toHaveBeenCalled();
			expect(session.conversationContext.items).toEqual(before);
		});

		it('quiet mode sends clientContent with turnComplete: false and records nothing', async () => {
			const { session, sdk } = await startGeminiSession();
			const before = [...session.conversationContext.items];

			const sent = await session.injectText('The user opened the pricing page.', {
				mode: 'quiet',
			});

			expect(sent).toBe(true);
			expect(sdk.sendClientContent).toHaveBeenCalledTimes(1);
			expect(sdk.sendClientContent).toHaveBeenCalledWith({
				turns: [{ role: 'user', parts: [{ text: 'The user opened the pricing page.' }] }],
				turnComplete: false,
			});
			expect(sdk.sendRealtimeInput).not.toHaveBeenCalled();
			expect(session.conversationContext.items).toEqual(before);
		});

		it('sendRealtimeMedia puts a jpeg in the realtime video slot with no history record', async () => {
			const { session, sdk } = await startGeminiSession();
			const before = [...session.conversationContext.items];

			expect(session.sendRealtimeMedia('/9j/4AAQ', 'image/jpeg')).toBe(true);

			expect(sdk.sendRealtimeInput).toHaveBeenCalledTimes(1);
			expect(sdk.sendRealtimeInput).toHaveBeenCalledWith({
				video: { data: '/9j/4AAQ', mimeType: 'image/jpeg' },
			});
			expect(sdk.sendClientContent).not.toHaveBeenCalled();
			expect(session.conversationContext.items).toEqual(before);
		});

		it('a live send buffered in the wind-down buffer resolves true', async () => {
			const { session, sdk } = await startGeminiSession({ responseModality: 'text' });
			const { _getMessageHandler } = await import('@google/genai');
			const fire = _getMessageHandler();
			if (!fire) throw new Error('no live Gemini socket');
			// An early-completed text-mode turn opens the wind-down window, which
			// buffers generation-triggering sends until the server turn completes.
			fire({ serverContent: { outputTranscription: { text: 'Hi.' } } });
			fire({ serverContent: { generationComplete: true } });
			sdk.sendRealtimeInput.mockClear();

			// Accepted into the buffer counts as delivered, before it is on the wire.
			await expect(session.injectText('next', { mode: 'live' })).resolves.toBe(true);
			expect(sdk.sendRealtimeInput).not.toHaveBeenCalledWith({ text: 'next' });

			// The server turn completing flushes it.
			fire({ serverContent: { turnComplete: true } });
			expect(sdk.sendRealtimeInput).toHaveBeenCalledWith({ text: 'next' });
		});

		it('a quiet send that throws resolves false and does not reject', async () => {
			const { session, sdk, log } = await startGeminiSession();
			sdk.sendClientContent.mockImplementationOnce(() => {
				throw new Error('socket write failed');
			});

			await expect(session.injectText('context', { mode: 'quiet' })).resolves.toBe(false);

			expect(sdk.sendClientContent).toHaveBeenCalledTimes(1);
			expect(
				logLines(log).some(
					(l) => l.includes('injectText (host-inject)') && l.includes('socket write failed'),
				),
			).toBe(true);
		});
	});

	// ─── Guards ───────────────────────────────────────────────────────────────

	it('both seams return false and send nothing in transcription mode', async () => {
		const handle = createMockTransport();
		const { session } = await startMockSession(handle, {
			whisperProvider: createWhisperProvider(),
		});
		await session.setTranscriptionMode('transcription');
		handle.sendContent.mockClear();

		await expect(session.injectText('hello', { mode: 'live' })).resolves.toBe(false);
		await expect(session.injectText('hello', { mode: 'quiet' })).resolves.toBe(false);
		expect(session.sendRealtimeMedia('/9j/4AAQ', 'image/jpeg')).toBe(false);

		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(handle.sendContent).not.toHaveBeenCalled();
		expect(handle.sendFile).not.toHaveBeenCalled();
	});

	it('sendRealtimeMedia returns false and does not throw when the transport send throws', async () => {
		const handle = createMockTransport();
		const { session } = await startMockSession(handle);
		handle.sendFile.mockImplementation(() => {
			throw new Error('socket closed');
		});

		let result: boolean | undefined;
		expect(() => {
			result = session.sendRealtimeMedia('/9j/4AAQ', 'image/jpeg');
		}).not.toThrow();
		expect(result).toBe(false);
		expect(handle.sendFile).toHaveBeenCalledTimes(1);
	});

	it('both seams return false and send nothing when the transport is not connected', async () => {
		const handle = createMockTransport();
		const { session } = await startMockSession(handle);
		handle.setConnected(false);
		handle.sendContent.mockClear();

		await expect(session.injectText('hello', { mode: 'live' })).resolves.toBe(false);
		await expect(session.injectText('hello', { mode: 'quiet' })).resolves.toBe(false);
		expect(session.sendRealtimeMedia('/9j/4AAQ', 'image/jpeg')).toBe(false);

		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(handle.sendContent).not.toHaveBeenCalled();
		expect(handle.sendFile).not.toHaveBeenCalled();
	});

	it('empty text resolves false and sends nothing', async () => {
		const handle = createMockTransport();
		const { session } = await startMockSession(handle);
		handle.sendContent.mockClear();

		await expect(session.injectText('', { mode: 'live' })).resolves.toBe(false);
		await expect(
			session.injectText([{ role: 'user', text: '  ' }], { mode: 'quiet' }),
		).resolves.toBe(false);

		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(handle.sendContent).not.toHaveBeenCalled();
	});

	// ─── Live versus quiet dispatch ───────────────────────────────────────────

	it('live mode invalidates a live greeting token; quiet mode leaves it alone', async () => {
		const handle = createMockTransport();
		const { session, log } = await startMockSession(handle, {
			agents: [createAgent('Hello there!')],
			greetingInterruptible: false,
		});
		const released = () => logLines(log).some((l) => l.includes('interrupt suppression released'));
		// The greeting was sent on connect, so its token is live and suppressing.
		expect(logLines(log).some((l) => l.includes('Sending greeting'))).toBe(true);
		expect(released()).toBe(false);

		await expect(session.injectText('silent context', { mode: 'quiet' })).resolves.toBe(true);
		expect(handle.sendContent).toHaveBeenLastCalledWith(
			[{ role: 'user', text: 'silent context' }],
			false,
		);
		expect(released()).toBe(false);

		await expect(session.injectText('say something', { mode: 'live' })).resolves.toBe(true);
		expect(handle.sendLiveText).toHaveBeenCalledWith([{ role: 'user', text: 'say something' }]);
		expect(logLines(log).some((l) => l.includes('competing trigger: assistant-initiated'))).toBe(
			true,
		);
	});

	it('the response to a live injection starts with origin assistant_initiated', async () => {
		const handle = createMockTransport();
		const { session } = await startMockSession(handle);
		const origins: string[] = [];
		session.eventBus.subscribe('response.started', (p) => origins.push(p.origin));

		await expect(session.injectText('say something', { mode: 'live' })).resolves.toBe(true);
		startModelTurn(handle);

		expect(origins).toEqual(['assistant_initiated']);
	});

	it('live mode falls back to sendContent(turns, true) on a transport without sendLiveText', async () => {
		const handle = createMockTransport({ liveText: false });
		const { session } = await startMockSession(handle);
		handle.sendContent.mockClear();

		await expect(session.injectText('hello', { mode: 'live' })).resolves.toBe(true);

		expect(handle.sendContent).toHaveBeenCalledTimes(1);
		expect(handle.sendContent).toHaveBeenCalledWith([{ role: 'user', text: 'hello' }], true);
	});

	// ─── Private options: hold, preemption, validity ──────────────────────────

	it('respectSyntheticHold under an active hold returns false before any preemption', async () => {
		const handle = createMockTransport();
		const { session, sendJson } = await startMockSession(handle);
		startModelTurn(handle);
		vi.spyOn(internals(session), 'isSyntheticHoldActive').mockReturnValue(true);
		handle.sendContent.mockClear();

		await expect(
			internals(session).injectTextInternal('correction', {
				mode: 'live',
				preempt: true,
				respectSyntheticHold: true,
			}),
		).resolves.toBe(false);

		// The in-flight turn is left alone and nothing is sent.
		expect(handle.cancelResponse).not.toHaveBeenCalled();
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(0);
		expect(internals(session).turns.active()).not.toBeNull();
		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(handle.sendContent).not.toHaveBeenCalled();

		// Host content bypasses the hold.
		await expect(session.injectText('host update', { mode: 'live' })).resolves.toBe(true);
		expect(handle.sendLiveText).toHaveBeenCalledTimes(1);
	});

	it('preempt finalizes the in-flight turn as interrupted before sending', async () => {
		const handle = createMockTransport();
		const { session, sendJson } = await startMockSession(handle);
		const interrupted: string[] = [];
		session.eventBus.subscribe('turn.interrupted', (p) => {
			interrupted.push(p.turnId);
			handle.order.push('turn.interrupted');
		});
		startModelTurn(handle);
		const turnId = internals(session).turns.numericId;
		// Evaluated at the head of the FIFO, before the preemption advances the turn.
		const stillValid = vi.fn(() => internals(session).turns.numericId === turnId);
		handle.order.length = 0;

		const sent = await internals(session).injectTextInternal('correction', {
			mode: 'live',
			preempt: true,
			stillValid,
		});

		expect(sent).toBe(true);
		expect(stillValid).toHaveBeenCalledTimes(1);
		expect(handle.cancelResponse).toHaveBeenCalledWith({ waitForDone: true });
		expect(interrupted).toHaveLength(1);
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(1);
		expect(handle.order).toEqual(['cancelResponse', 'turn.interrupted', 'sendLiveText']);
		expect(handle.sendLiveText).toHaveBeenCalledWith([{ role: 'user', text: 'correction' }]);
	});

	it('stillValid false after the FIFO wait abandons the injection with no preemption', async () => {
		const handle = createMockTransport();
		const { session, sendJson } = await startMockSession(handle);
		startModelTurn(handle);
		const turnId = internals(session).turns.numericId;
		const stillValid = vi.fn(() => internals(session).turns.numericId === turnId);

		// Newer typed input is queued first and pre-empts the turn.
		const typed = internals(session).handleTextInput('a newer question');
		const injected = internals(session).injectTextInternal('correction', {
			mode: 'live',
			preempt: true,
			stillValid,
		});
		expect(stillValid).not.toHaveBeenCalled();
		await typed;

		await expect(injected).resolves.toBe(false);
		expect(stillValid).toHaveBeenCalledTimes(1);
		expect(stillValid).toHaveLastReturnedWith(false);
		// Only the typed input pre-empted; the correction sent nothing.
		expect(handle.cancelResponse).toHaveBeenCalledTimes(1);
		expect(jsonOfType(sendJson, 'turn.interrupted')).toHaveLength(1);
		expect(handle.sendLiveText).not.toHaveBeenCalled();
		expect(handle.sendContent).toHaveBeenCalledTimes(1);
		expect(handle.sendContent).toHaveBeenCalledWith(
			[{ role: 'user', text: 'a newer question' }],
			true,
		);
	});

	// ─── Public surface ───────────────────────────────────────────────────────

	it('InjectTextOptions is root-exported and carries only mode', () => {
		const live: InjectTextOptions = { mode: 'live' };
		// @ts-expect-error preempt is not a public injection option
		const preempting: InjectTextOptions = { mode: 'live', preempt: true };
		// @ts-expect-error origin is not a public injection option
		const labelled: InjectTextOptions = { mode: 'quiet', origin: 'host' };
		expect([live.mode, preempting.mode, labelled.mode]).toEqual(['live', 'live', 'quiet']);
	});
});
