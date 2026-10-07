import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import { decodeMulawToPcm } from '../../src/telephony/audio-codec.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../../src/types/tts.js';

/**
 * Hosted audio conformance: a session whose client connection belongs to the
 * host, which passes a `clientSender` for output, feeds inbound audio with
 * `feedAudioFromClient()` and reports attach edges with
 * `notifyClientConnected()` / `notifyClientDisconnected()`. Built in the
 * default legacy orchestration with no `memory`, as the telephony and room
 * adapters construct it, on a stub transport. Pins which assistant output
 * reaches the sender and which fed frames reach `transport.sendAudio`. One
 * case checks the input observer on the owned client WebSocket as well.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

const GREETING = '[System: Greet the caller.]';

interface StubTransport {
	transport: LLMTransport;
	/** Raw spies: the session wraps some transport methods after construction. */
	sendAudio: ReturnType<typeof vi.fn>;
	sendContent: ReturnType<typeof vi.fn>;
	reconnect: ReturnType<typeof vi.fn>;
	/** What `getActiveServerTurnId()` reports; `undefined` until a test sets it. */
	serverTurn: { id: number | undefined };
}

function createStubTransport(audioFormat: Partial<AudioFormatSpec> = {}): StubTransport {
	const sendAudio = vi.fn();
	const sendContent = vi.fn();
	const reconnect = vi.fn().mockResolvedValue(undefined);
	const serverTurn: { id: number | undefined } = { id: undefined };
	const transport: LLMTransport = {
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
			...audioFormat,
		} satisfies AudioFormatSpec,
		isConnected: true,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		reconnect,
		sendAudio,
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent,
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
		elicitResponse: vi.fn(),
		getActiveServerTurnId: () => serverTurn.id,
	};
	return { transport, sendAudio, sendContent, reconnect, serverTurn };
}

function greetingAgent(): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: [],
		greeting: GREETING,
	};
}

function hostedSender() {
	return { sendAudio: vi.fn(), sendJson: vi.fn() };
}

function createSession(
	stub: StubTransport,
	config: Partial<VoiceSessionConfig> = {},
): VoiceSession {
	return new VoiceSession({
		sessionId: 'sess_hosted_audio',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [greetingAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport: stub.transport,
		// A `port` selects the owned client WebSocket instead of a sender.
		...(config.port === undefined ? { clientSender: hostedSender() } : {}),
		log: () => {},
		...config,
	});
}

/** Start the session and report setup complete: CONNECTING → ACTIVE. */
async function activate(session: VoiceSession, stub: StubTransport): Promise<void> {
	await session.start();
	stub.transport.onSessionReady?.('stub_session');
	expect(session.sessionManager.state).toBe('ACTIVE');
}

/**
 * A 30 ms client frame (16 kHz PCM16) whose samples all carry `marker`. Small
 * markers stay far below the client VAD's speech threshold, and the
 * transport's input rate matches, so a forwarded frame reaches
 * `transport.sendAudio` byte for byte.
 */
function frame(marker: number): Buffer {
	const f = Buffer.alloc(480 * 2);
	for (let i = 0; i < f.length; i += 2) f.writeInt16LE(marker, i);
	return f;
}

/** Frames that reached `transport.sendAudio`, decoded back from base64. */
function upstreamFrames(stub: StubTransport): Buffer[] {
	return stub.sendAudio.mock.calls.map((c) => Buffer.from(c[0] as string, 'base64'));
}

function greetingCount(stub: StubTransport): number {
	return stub.sendContent.mock.calls
		.flatMap((c) => (c[0] as Array<{ text: string }>).map((t) => t.text))
		.filter((t) => t.includes(GREETING)).length;
}

function jsonTypes(sender: ReturnType<typeof hostedSender>): unknown[] {
	return sender.sendJson.mock.calls.map((c) => (c[0] as { type?: unknown }).type);
}

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Open a WebSocket, collecting the `type` of its text frames from creation, and resolve once it is open. */
function openClient(url: string): Promise<{ ws: WebSocket; types: unknown[] }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const types: unknown[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) types.push((JSON.parse(data.toString()) as { type?: unknown }).type);
		});
		ws.on('open', () => resolve({ ws, types }));
		ws.on('error', reject);
	});
}

describe('VoiceSession hosted audio', () => {
	let session: VoiceSession | undefined;

	afterEach(async () => {
		await session?.close().catch(() => {});
		session = undefined;
	});

	describe('output conformance', () => {
		it.each<[string, (t: LLMTransport) => void]>([
			['completed', (t) => t.onTurnComplete?.(1)],
			['interrupted', (t) => t.onInterrupted?.(1)],
		])(
			'drops native audio for an already-%s turn before the sender and the output observer',
			async (_label, finalize) => {
				const sender = hostedSender();
				const stub = createStubTransport();
				session = createSession(stub, { clientSender: sender });
				const observed = vi.fn();
				session.observeAudioOutput(observed);
				await activate(session, stub);
				const first = Buffer.from([1, 0, 2, 0]);
				const trailing = Buffer.from([3, 0, 4, 0]);
				const next = Buffer.from([5, 0, 6, 0]);

				stub.serverTurn.id = 1;
				stub.transport.onModelTurnStart?.();
				stub.transport.onAudioOutput?.(first.toString('base64'));
				expect(sender.sendAudio).toHaveBeenCalledTimes(1);
				expect(sender.sendAudio).toHaveBeenLastCalledWith(first);

				finalize(stub.transport);
				// Trailing audio still tagged with the finalized server turn.
				stub.transport.onAudioOutput?.(trailing.toString('base64'));

				expect(sender.sendAudio).toHaveBeenCalledTimes(1);
				expect(observed).toHaveBeenCalledTimes(1);

				// The next server turn's audio flows again.
				stub.serverTurn.id = 2;
				stub.transport.onModelTurnStart?.();
				stub.transport.onAudioOutput?.(next.toString('base64'));

				expect(sender.sendAudio).toHaveBeenCalledTimes(2);
				expect(sender.sendAudio).toHaveBeenLastCalledWith(next);
			},
		);

		it("drops a late TTS chunk from an interrupted turn's synthesis request before the sender", async () => {
			// An external TTS provider requires actor orchestration, so this one
			// case leaves the legacy shape the hosted adapters use.
			const sender = hostedSender();
			const stub = createStubTransport();
			const format: TTSAudioConfig = {
				sampleRate: 24000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			};
			const tts = {
				configure: vi.fn(() => format),
				synthesize: vi.fn(),
				cancel: vi.fn(),
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
			} as unknown as TTSProvider;
			session = createSession(stub, {
				clientSender: sender,
				orchestrationMode: 'actor',
				ttsProvider: tts,
			});
			await activate(session, stub);
			const chunk = Buffer.alloc(480).toString('base64');

			stub.transport.onModelTurnStart?.();
			stub.transport.onTextOutput?.('Hello there.'); // first text opens request 1
			tts.onAudio?.(chunk, 10, 1);
			expect(sender.sendAudio).toHaveBeenCalledTimes(1);

			stub.transport.onInterrupted?.();
			await flushMicrotasks();
			tts.onAudio?.(chunk, 10, 1); // late chunk of the interrupted request

			expect(sender.sendAudio).toHaveBeenCalledTimes(1);
		});

		it('flushes assistant audio buffered during a reconnect to the sender through stopBuffering(), never upstream', async () => {
			const sender = hostedSender();
			const stub = createStubTransport();
			let finishReconnect: () => void = () => {};
			stub.reconnect.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						finishReconnect = resolve;
					}),
			);
			session = createSession(stub, { clientSender: sender });
			await activate(session, stub);
			stub.transport.onResumptionUpdate?.('handle-1', true);
			const buffered = Buffer.from([7, 0, 8, 0]);

			stub.transport.onGoAway?.('10s');
			expect(session.sessionManager.state).toBe('RECONNECTING');
			stub.transport.onAudioOutput?.(buffered.toString('base64'));
			expect(sender.sendAudio).not.toHaveBeenCalled();

			finishReconnect();
			await flushMicrotasks();

			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(sender.sendAudio).toHaveBeenCalledTimes(1);
			expect(sender.sendAudio).toHaveBeenCalledWith(buffered);
			expect(stub.sendAudio).not.toHaveBeenCalled();
		});
	});

	describe('ingress and egress conformance', () => {
		it('drops frames fed while the session is not ACTIVE', async () => {
			const stub = createStubTransport();
			session = createSession(stub);

			session.feedAudioFromClient(frame(1)); // CREATED
			await session.start();
			expect(session.sessionManager.state).toBe('CONNECTING');
			session.feedAudioFromClient(frame(2));
			stub.transport.onSessionReady?.('stub_session');
			stub.transport.onResumptionUpdate?.('handle-1', true);
			stub.transport.onClose?.(1006, 'socket lost');
			expect(session.sessionManager.state).toBe('RECONNECTING');
			session.feedAudioFromClient(frame(3));

			expect(stub.sendAudio).not.toHaveBeenCalled();
		});

		it('forwards frames fed once ACTIVE to transport.sendAudio with no attach', async () => {
			const stub = createStubTransport();
			session = createSession(stub);
			await activate(session, stub);

			session.feedAudioFromClient(frame(1));
			session.feedAudioFromClient(frame(2));

			expect(session.clientConnected).toBe(false);
			expect(upstreamFrames(stub)).toEqual([frame(1), frame(2)]);
		});

		it('forwards frames fed once ACTIVE to transport.sendAudio after an attach', async () => {
			const stub = createStubTransport();
			session = createSession(stub);
			await activate(session, stub);

			session.notifyClientConnected();
			session.feedAudioFromClient(frame(1));
			session.feedAudioFromClient(frame(2));

			expect(upstreamFrames(stub)).toEqual([frame(1), frame(2)]);
		});

		it('greets exactly once on notifyClientConnected() after ACTIVE', async () => {
			const stub = createStubTransport();
			session = createSession(stub);
			await activate(session, stub);
			expect(greetingCount(stub)).toBe(0);

			session.notifyClientConnected();
			await flushMicrotasks();
			expect(greetingCount(stub)).toBe(1);

			// Setup-complete is the other path that greets an attached client:
			// another one for the same attach must not greet it a second time.
			stub.transport.onSessionReady?.('stub_session');
			await flushMicrotasks();

			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(greetingCount(stub)).toBe(1);
		});

		it("does not greet a second attach after a completed turn under 'until-first-turn'", async () => {
			const stub = createStubTransport();
			session = createSession(stub, { reattachGreeting: 'until-first-turn' });
			await activate(session, stub);
			session.notifyClientConnected();
			expect(greetingCount(stub)).toBe(1);
			// The greeting's response completes a turn.
			stub.transport.onModelTurnStart?.();
			stub.transport.onAudioOutput?.(Buffer.from([1, 0]).toString('base64'));
			stub.transport.onTurnComplete?.();
			stub.sendContent.mockClear();

			// A second attach with no detach in between, as a room adapter does
			// when another participant joins.
			session.notifyClientConnected();
			await flushMicrotasks();

			expect(greetingCount(stub)).toBe(0);
			expect(stub.sendContent).not.toHaveBeenCalled();
		});

		it('sends session.config to sender.sendJson on attach, and no session.ready', async () => {
			const sender = hostedSender();
			const stub = createStubTransport();
			session = createSession(stub, { clientSender: sender });
			await activate(session, stub);

			session.notifyClientConnected();

			expect(sender.sendJson).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'session.config',
					audioFormat: stub.transport.audioFormat,
				}),
			);
			expect(jsonTypes(sender)).not.toContain('session.ready');
		});

		it('observeAudioInput sees every fed frame, including frames the session drops', async () => {
			const stub = createStubTransport();
			session = createSession(stub);
			const seen: Array<{ pcm: Buffer; source: string; sampleRate: number }> = [];
			session.observeAudioInput((pcm, meta) => {
				seen.push({ pcm, source: meta.source, sampleRate: meta.sampleRate });
			});

			await session.start();
			session.feedAudioFromClient(frame(1)); // CONNECTING: dropped
			stub.transport.onSessionReady?.('stub_session');
			session.feedAudioFromClient(frame(2)); // ACTIVE: forwarded
			session.notifyClientConnected();
			session.notifyClientDisconnected();
			session.feedAudioFromClient(frame(3)); // after a detach: dropped

			expect(seen).toEqual([
				{ pcm: frame(1), source: 'websocket', sampleRate: 16000 },
				{ pcm: frame(2), source: 'websocket', sampleRate: 16000 },
				{ pcm: frame(3), source: 'websocket', sampleRate: 16000 },
			]);
			expect(upstreamFrames(stub)).toEqual([frame(2)]);
		});

		it('observeAudioInput fires for frames received on the local ClientTransport', async () => {
			const stub = createStubTransport();
			session = createSession(stub, { port: 9964 });
			const seen: Array<{ pcm: Buffer; source: string; sampleRate: number }> = [];
			session.observeAudioInput((pcm, meta) => {
				seen.push({ pcm, source: meta.source, sampleRate: meta.sampleRate });
			});
			await activate(session, stub);
			const client = await openClient('ws://localhost:9964');
			await vi.waitFor(() => expect(client.types).toContain('session.config'));

			client.ws.send(frame(1));
			client.ws.send(frame(2));
			await vi.waitFor(() => expect(seen).toHaveLength(2));

			expect(seen).toEqual([
				{ pcm: frame(1), source: 'websocket', sampleRate: 16000 },
				{ pcm: frame(2), source: 'websocket', sampleRate: 16000 },
			]);
			expect(upstreamFrames(stub)).toEqual([frame(1), frame(2)]);

			client.ws.close();
			await new Promise<void>((r) => client.ws.on('close', () => r()));
		});

		it.each<[string, Partial<AudioFormatSpec>, (raw: Buffer) => Buffer]>([
			['PCM', {}, (raw) => raw],
			['G.711 mu-law', { outputEncoding: 'pcmu' }, decodeMulawToPcm],
		])(
			'observeAudioOutput sees %s model output as decoded PCM before the sender',
			async (_label, audioFormat, decode) => {
				const order: string[] = [];
				const sender = {
					sendAudio: vi.fn(() => {
						order.push('sender');
					}),
					sendJson: vi.fn(),
				};
				const stub = createStubTransport(audioFormat);
				session = createSession(stub, { clientSender: sender });
				// Captured here and asserted after delivery: the session catches an
				// observer's throw, so an expect inside the observer could never fail.
				const seen: Array<{ pcm: Buffer; meta: unknown }> = [];
				session.observeAudioOutput((pcm, meta) => {
					order.push('observer');
					seen.push({ pcm, meta });
				});
				await activate(session, stub);
				const raw = Buffer.from([0x00, 0x7f, 0x80, 0xff]);

				stub.transport.onModelTurnStart?.();
				stub.transport.onAudioOutput?.(raw.toString('base64'));

				const pcm = decode(raw);
				expect(order).toEqual(['observer', 'sender']);
				expect(seen).toEqual([
					{ pcm, meta: { turnId: expect.any(String), sampleRate: 24000, encoding: 'pcm' } },
				]);
				expect(sender.sendAudio).toHaveBeenCalledWith(pcm);
			},
		);

		it('drops frames fed after notifyClientDisconnected() until the next notifyClientConnected()', async () => {
			const stub = createStubTransport();
			session = createSession(stub);
			await activate(session, stub);
			session.notifyClientConnected();
			session.feedAudioFromClient(frame(1));

			session.notifyClientDisconnected();
			session.feedAudioFromClient(frame(2));
			session.feedAudioFromClient(frame(3));
			expect(upstreamFrames(stub)).toEqual([frame(1)]);

			session.notifyClientConnected();
			session.feedAudioFromClient(frame(4));

			expect(upstreamFrames(stub)).toEqual([frame(1), frame(4)]);
		});
	});
});
