import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { speechSpeed } from '../../src/behaviors/presets.js';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ClientMediaProfile } from '../../src/types/client-media.js';
import type { MemoryStore } from '../../src/types/memory.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

/**
 * Host client callbacks: the `clientConnected` getter, socket health and
 * close on the attached client connection, host command routing, the
 * attach and detach hooks, the `suppressClientAutoActions` gate, and the
 * reattach greeting and context-replay policy, including an attach to a
 * session parked in UPSTREAM_LOST.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

const GREETING = '[System: Greet the user warmly.]';
const CLIENT_REPLAY = 'The client reconnected.';
const UPSTREAM_REPLAY = 'You just reconnected.';

interface StubTransport {
	transport: LLMTransport;
	connect: ReturnType<typeof vi.fn>;
	clearResumption: ReturnType<typeof vi.fn>;
	/** The raw spy: the session wraps the transport's `sendContent`. */
	sendContent: ReturnType<typeof vi.fn>;
}

/**
 * A transport with the host-recovery primitives: a dial counter that advances
 * per dial and on `abortIncumbent()`, a post-setup generation counter, and a
 * `connect()` that reports setup complete before it resolves.
 */
function createStubTransport(): StubTransport {
	let dialGen = 0;
	let transportGeneration = 0;
	let connected = false;
	const sendContent = vi.fn();
	const clearResumption = vi.fn();
	const connect = vi.fn(async () => {
		const gen = ++dialGen;
		transportGeneration += 1;
		connected = true;
		transport.onSessionReady?.(`stub_${gen}`);
	});
	const transport: LLMTransport = {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
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
		get isConnected() {
			return connected;
		},
		get currentDialGen() {
			return dialGen;
		},
		get currentTransportGeneration() {
			return transportGeneration;
		},
		connect,
		disconnect: vi.fn(async () => {
			connected = false;
		}),
		reconnect: vi.fn(async () => {}),
		abortIncumbent: vi.fn(async (): Promise<'closed' | 'forced'> => {
			dialGen += 1;
			connected = false;
			return 'closed';
		}),
		clearResumption,
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn(async () => {}),
		sendContent,
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
	return { transport, connect, clearResumption, sendContent };
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
		sessionId: 'sess_host_client',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [greetingAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport: stub.transport,
		...(config.port === undefined ? { clientSender: hostedSender() } : {}),
		log: () => {},
		...config,
	});
}

function sentTexts(stub: StubTransport): string[] {
	return stub.sendContent.mock.calls.flatMap((c) =>
		(c[0] as Array<{ text: string }>).map((t) => t.text),
	);
}

function greetingCount(stub: StubTransport): number {
	return sentTexts(stub).filter((t) => t.includes(GREETING)).length;
}

function jsonTypes(sender: ReturnType<typeof hostedSender>): unknown[] {
	return sender.sendJson.mock.calls.map((c) => (c[0] as { type?: unknown }).type);
}

/** One model turn from start to completion. */
function completeTurn(stub: StubTransport): void {
	stub.transport.onModelTurnStart?.();
	stub.transport.onTurnComplete?.();
}

/** Open a WebSocket, collecting its text frames from creation, and resolve once it is open. */
function openCollecting(url: string): Promise<{ ws: WebSocket; frames: string[] }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const frames: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) frames.push(data.toString());
		});
		ws.on('open', () => resolve({ ws, frames }));
		ws.on('error', reject);
	});
}

function frameTypes(frames: string[]): unknown[] {
	return frames.map((frame) => (JSON.parse(frame) as { type?: unknown }).type);
}

describe('VoiceSession host client callbacks', () => {
	let session: VoiceSession | undefined;

	afterEach(async () => {
		await session?.close().catch(() => {});
		session = undefined;
	});

	describe('client connection state and socket access', () => {
		it('clientConnected follows notifyClientConnected and notifyClientDisconnected', async () => {
			session = createSession(createStubTransport());
			await session.start();
			expect(session.clientConnected).toBe(false);

			session.notifyClientConnected();
			expect(session.clientConnected).toBe(true);

			session.notifyClientDisconnected();
			expect(session.clientConnected).toBe(false);
		});

		it.each<[string, ClientMediaProfile]>([
			['a host-owned WebSocket channel', { kind: 'websocket' }],
			['a direct-RTC channel', { kind: 'direct_rtc' }],
		])(
			'on %s, socket health is null and closeClientConnection() returns false without calling the sender',
			async (_label, clientMedia) => {
				const sender = hostedSender();
				session = createSession(createStubTransport(), { clientSender: sender, clientMedia });
				await session.start();
				session.notifyClientConnected();
				expect(jsonTypes(sender)).toContain('session.config');
				sender.sendJson.mockClear();
				sender.sendAudio.mockClear();

				expect(session.getClientSocketHealth()).toBeNull();
				expect(session.closeClientConnection(4000, 'goodbye')).toBe(false);
				expect(session.closeClientConnection()).toBe(false);

				expect(sender.sendJson).not.toHaveBeenCalled();
				expect(sender.sendAudio).not.toHaveBeenCalled();
				expect(session.clientConnected).toBe(true);
			},
		);

		it('on the owned socket, health reports the attached client and closeClientConnection(4000, "goodbye") closes only that client', async () => {
			session = createSession(createStubTransport(), { port: 9963 });
			await session.start();
			const s = session;
			expect(s.sessionManager.state).toBe('ACTIVE');
			expect(s.getClientSocketHealth()).toBeNull();
			expect(s.closeClientConnection(4000, 'goodbye')).toBe(false);

			const first = await openCollecting('ws://localhost:9963');
			await vi.waitFor(() => expect(frameTypes(first.frames)).toContain('session.config'));
			expect(s.clientConnected).toBe(true);
			expect(s.getClientSocketHealth()).toEqual({
				readyState: WebSocket.OPEN,
				bufferedAmount: expect.any(Number),
			});

			const closedBy = new Promise<{ code: number; reason: string }>((resolve) => {
				first.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
			});
			expect(s.closeClientConnection(4000, 'goodbye')).toBe(true);
			expect(await closedBy).toEqual({ code: 4000, reason: 'goodbye' });
			await vi.waitFor(() => expect(s.clientConnected).toBe(false));
			expect(s.getClientSocketHealth()).toBeNull();
			expect(s.sessionManager.state).toBe('ACTIVE');

			// The listener still accepts: the next client attaches and is configured.
			const second = await openCollecting('ws://localhost:9963');
			await vi.waitFor(() => expect(frameTypes(second.frames)).toContain('session.config'));
			expect(s.clientConnected).toBe(true);
			expect(s.getClientSocketHealth()?.readyState).toBe(WebSocket.OPEN);
			expect(s.sessionManager.state).toBe('ACTIVE');

			second.ws.close();
			await new Promise<void>((r) => second.ws.on('close', () => r()));
		});
	});

	describe('client commands', () => {
		it('an unrecognized type reaches onClientJson, then onClientCommand', async () => {
			const order: Array<[string, Record<string, unknown>]> = [];
			session = createSession(createStubTransport(), {
				onClientJson: (m) => order.push(['onClientJson', m]),
				onClientCommand: (m) => order.push(['onClientCommand', m]),
			});
			await session.start();
			session.notifyClientConnected();

			const command = { type: 'voice.retryUpstream', attempt: 1 };
			session.feedJsonFromClient(command);

			expect(order).toEqual([
				['onClientJson', command],
				['onClientCommand', command],
			]);
		});

		it.each(['onClientJson', 'onClientCommand'] as const)(
			'%s throwing on the first of two queued frames is reported, and the drain and the attach go on',
			async (throwing) => {
				const onError = vi.fn();
				const hooks = { onClientJson: vi.fn(), onClientCommand: vi.fn() };
				hooks[throwing].mockImplementationOnce(() => {
					throw new Error(`${throwing} failed`);
				});
				// A memory restore the test releases: the attach bootstrap waits for it,
				// so client frames that arrive meanwhile wait in the bootstrap queue.
				let releaseRestore!: () => void;
				const restore = new Promise<void>((resolve) => {
					releaseRestore = resolve;
				});
				const store: MemoryStore = {
					addFacts: async () => {},
					getAll: async () => {
						await restore;
						return [];
					},
					replaceAll: async () => {},
					getDirectives: async () => ({}),
					setDirectives: async () => {},
				};
				const sender = hostedSender();
				const stub = createStubTransport();
				session = createSession(stub, {
					clientSender: sender,
					memory: { store },
					hooks: { onError },
					...hooks,
				});
				await session.start();
				session.notifyClientConnected();
				const first = { type: 'app.retry', attempt: 1 };
				const second = { type: 'app.retry', attempt: 2 };
				session.feedJsonFromClient(first);
				session.feedJsonFromClient(second);
				expect(hooks[throwing]).not.toHaveBeenCalled();
				expect(jsonTypes(sender)).not.toContain('session.config');

				releaseRestore();
				const s = session;
				await vi.waitFor(() => expect(greetingCount(stub)).toBe(1));

				expect(jsonTypes(sender)).toContain('session.config');
				expect(s.clientConnected).toBe(true);
				expect(hooks.onClientJson.mock.calls).toEqual([[first], [second]]);
				expect(hooks.onClientCommand.mock.calls).toEqual([[first], [second]]);
				expect(onError).toHaveBeenCalledTimes(1);
				expect(onError).toHaveBeenCalledWith(
					expect.objectContaining({
						component: `hook.${throwing}`,
						error: expect.objectContaining({ message: `${throwing} failed` }),
					}),
				);
			},
		);

		it('a malformed built-in is dropped with a log line and reaches neither hook', async () => {
			const onClientJson = vi.fn();
			const onClientCommand = vi.fn();
			const lines: string[] = [];
			const stub = createStubTransport();
			session = createSession(stub, {
				onClientJson,
				onClientCommand,
				log: (l) => lines.push(l),
			});
			await session.start();
			session.notifyClientConnected();
			stub.sendContent.mockClear();

			session.feedJsonFromClient({ type: 'text_input', text: 42 });

			expect(onClientJson).not.toHaveBeenCalled();
			expect(onClientCommand).not.toHaveBeenCalled();
			expect(stub.sendContent).not.toHaveBeenCalled();
			expect(lines.some((l) => l.includes('dropped malformed built-in "text_input"'))).toBe(true);
		});
	});

	describe('attach and detach hooks', () => {
		it('onClientConnected runs once clientConnected is true, before the catalog, session.config and greeting; onClientDisconnected once it is false', async () => {
			const events: string[] = [];
			const stub = createStubTransport();
			stub.sendContent.mockImplementation(() => events.push('generation'));
			const s = createSession(stub, {
				behaviors: [speechSpeed()],
				clientSender: {
					sendAudio: vi.fn(),
					sendJson: (m) => events.push(`json:${m.type}`),
				},
				onClientConnected: () => events.push(`connected:${s.clientConnected}`),
				onClientDisconnected: () => events.push(`disconnected:${s.clientConnected}`),
			});
			session = s;
			await s.start();

			s.notifyClientConnected();
			expect(events).toEqual([
				'connected:true',
				'json:behavior.catalog',
				'json:session.config',
				'generation',
			]);

			events.length = 0;
			s.notifyClientDisconnected();
			expect(events).toEqual(['disconnected:false']);
		});

		it('a throwing hook is reported through hooks.onError and does not block the bootstrap', async () => {
			const onError = vi.fn();
			const sender = hostedSender();
			const stub = createStubTransport();
			session = createSession(stub, {
				clientSender: sender,
				hooks: { onError },
				onClientConnected: () => {
					throw new Error('attach hook failed');
				},
				onClientDisconnected: () => {
					throw new Error('detach hook failed');
				},
			});
			await session.start();

			expect(() => session?.notifyClientConnected()).not.toThrow();
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'hook.onClientConnected',
					error: expect.objectContaining({ message: 'attach hook failed' }),
				}),
			);
			expect(jsonTypes(sender)).toContain('session.config');
			expect(greetingCount(stub)).toBe(1);
			expect(session.clientConnected).toBe(true);

			expect(() => session?.notifyClientDisconnected()).not.toThrow();
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'hook.onClientDisconnected',
					error: expect.objectContaining({ message: 'detach hook failed' }),
				}),
			);
			expect(session.clientConnected).toBe(false);
		});
	});

	describe('suppressClientAutoActions', () => {
		it.each([
			['to an ACTIVE session', false],
			['before the first setup completes', true],
		])(
			'an attach %s sends the catalog and session.config, reads the gate after them, and sends no greeting',
			async (_label, attachBeforeStart) => {
				const events: string[] = [];
				const stub = createStubTransport();
				stub.sendContent.mockImplementation(() => events.push('generation'));
				const suppressClientAutoActions = vi.fn(() => {
					events.push('gate');
					return true;
				});
				session = createSession(stub, {
					behaviors: [speechSpeed()],
					clientSender: {
						sendAudio: vi.fn(),
						sendJson: (m) => events.push(`json:${m.type}`),
					},
					suppressClientAutoActions,
				});

				if (attachBeforeStart) session.notifyClientConnected();
				await session.start();
				if (!attachBeforeStart) session.notifyClientConnected();

				expect(session.sessionManager.state).toBe('ACTIVE');
				expect(events.slice(0, 3)).toEqual([
					'json:behavior.catalog',
					'json:session.config',
					'gate',
				]);
				expect(events).not.toContain('generation');
				expect(greetingCount(stub)).toBe(0);
				expect(stub.connect).toHaveBeenCalledTimes(1);
			},
		);

		it.each([
			['to an ACTIVE session', false, 1],
			['before the first setup completes', true, 2],
		])(
			'a gate that throws on an attach %s is logged and read as not suppressed, so the client is greeted',
			async (_label, attachBeforeStart, gateReads) => {
				const lines: string[] = [];
				const sender = hostedSender();
				const stub = createStubTransport();
				session = createSession(stub, {
					clientSender: sender,
					log: (l) => lines.push(l),
					suppressClientAutoActions: () => {
						throw new Error('gate broke');
					},
				});

				// Before start the attach bootstrap reads the gate and the setup
				// completion reads it again; on an ACTIVE session only the attach does.
				if (attachBeforeStart) expect(() => session?.notifyClientConnected()).not.toThrow();
				await expect(session.start()).resolves.toBeUndefined();
				if (!attachBeforeStart) expect(() => session?.notifyClientConnected()).not.toThrow();

				expect(session.sessionManager.state).toBe('ACTIVE');
				expect(jsonTypes(sender)).toContain('session.config');
				expect(greetingCount(stub)).toBe(1);
				expect(
					lines.filter((l) =>
						l.includes(
							'Host client auto-action gate threw (treated as not suppressed): gate broke',
						),
					),
				).toHaveLength(gateReads);
				expect(lines.some((l) => l.includes('suppressed by host gate'))).toBe(false);
			},
		);

		it('a suppressed reattach after a completed turn replays no context', async () => {
			let suppressed = false;
			const sender = hostedSender();
			const stub = createStubTransport();
			session = createSession(stub, {
				clientSender: sender,
				reattachGreeting: 'until-first-turn',
				reattachContextReplay: true,
				suppressClientAutoActions: () => suppressed,
			});
			await session.start();
			session.notifyClientConnected();
			completeTurn(stub);
			session.conversationContext.addUserMessage('what is the weather');
			session.conversationContext.addAssistantMessage('sunny');
			session.notifyClientDisconnected();
			sender.sendJson.mockClear();
			stub.sendContent.mockClear();

			suppressed = true;
			session.notifyClientConnected();

			expect(jsonTypes(sender)).toContain('session.config');
			expect(stub.sendContent).not.toHaveBeenCalled();
		});

		it('a suppressed attach to a session parked in UPSTREAM_LOST sends session.config and dials nothing', async () => {
			const sender = hostedSender();
			const stub = createStubTransport();
			session = createSession(stub, {
				clientSender: sender,
				upstreamLossPolicy: 'hold',
				suppressClientAutoActions: () => true,
			});
			await session.start();
			stub.transport.onClose?.(1006, 'socket lost');
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');

			session.notifyClientConnected();
			await new Promise((r) => setTimeout(r, 10));

			expect(jsonTypes(sender)).toContain('session.config');
			expect(stub.connect).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
			expect(stub.sendContent).not.toHaveBeenCalled();
		});
	});

	describe('reattach policy', () => {
		it("'per-client' (the default) greets again after a completed turn", async () => {
			const stub = createStubTransport();
			session = createSession(stub);
			await session.start();
			session.notifyClientConnected();
			expect(greetingCount(stub)).toBe(1);
			completeTurn(stub);
			session.conversationContext.addUserMessage('what is the weather');
			session.notifyClientDisconnected();

			session.notifyClientConnected();

			expect(greetingCount(stub)).toBe(2);
			expect(sentTexts(stub).some((t) => t.includes('reconnected'))).toBe(false);
		});

		it("'until-first-turn' greets the first attach; after a completed turn it does not greet but replays recent context quietly", async () => {
			const stub = createStubTransport();
			session = createSession(stub, {
				reattachGreeting: 'until-first-turn',
				reattachContextReplay: true,
			});
			await session.start();
			session.notifyClientConnected();
			expect(greetingCount(stub)).toBe(1);
			expect(sentTexts(stub).some((t) => t.includes('reconnected'))).toBe(false);
			completeTurn(stub);
			session.conversationContext.addUserMessage('what is the weather');
			session.conversationContext.addAssistantMessage('sunny');
			session.notifyClientDisconnected();
			stub.sendContent.mockClear();

			session.notifyClientConnected();

			expect(greetingCount(stub)).toBe(0);
			expect(stub.sendContent).toHaveBeenCalledTimes(1);
			const [turns, turnComplete] = stub.sendContent.mock.calls[0] as [
				Array<{ role: string; text: string }>,
				boolean,
			];
			expect(turnComplete).toBe(false); // quiet: no response requested
			expect(turns).toHaveLength(1);
			expect(turns[0].role).toBe('user');
			expect(turns[0].text).toContain(CLIENT_REPLAY);
			expect(turns[0].text).toContain('user: what is the weather\nassistant: sunny');
		});

		it('under the synthetic hold the reattach context is not injected', async () => {
			const lines: string[] = [];
			const stub = createStubTransport();
			session = createSession(stub, {
				upstreamLossPolicy: 'hold',
				reattachGreeting: 'until-first-turn',
				reattachContextReplay: true,
				log: (l) => lines.push(l),
			});
			await session.start();
			completeTurn(stub);
			session.conversationContext.addUserMessage('what is the weather');
			session.conversationContext.addAssistantMessage('sunny');
			const r = session.recoverUpstream({
				reason: 'active-silence',
				skipContextInjection: true,
				holdSyntheticUntilFreshSpeech: true,
			});
			await r.activated;
			expect(session.isSyntheticHoldActive()).toBe(true);
			stub.sendContent.mockClear();

			session.notifyClientConnected();

			expect(stub.sendContent).not.toHaveBeenCalled();
			expect(lines.some((l) => l.includes('suppressed client-reconnect-context'))).toBe(true);
		});

		it('a CLOSED attach sends session.config and neither dials nor greets', async () => {
			const sender = hostedSender();
			const stub = createStubTransport();
			session = createSession(stub, { clientSender: sender });
			await session.start();
			await session.close();
			expect(session.sessionManager.state).toBe('CLOSED');
			stub.sendContent.mockClear();

			session.notifyClientConnected();
			await new Promise((r) => setTimeout(r, 10));

			expect(jsonTypes(sender)).toContain('session.config');
			expect(stub.connect).toHaveBeenCalledTimes(1);
			expect(stub.sendContent).not.toHaveBeenCalled();
			expect(session.sessionManager.state).toBe('CLOSED');
		});

		it('an UPSTREAM_LOST attach dials fresh, does not greet, and injects quiet context after activation', async () => {
			const lines: string[] = [];
			const stub = createStubTransport();
			session = createSession(stub, {
				upstreamLossPolicy: 'hold',
				log: (l) => lines.push(l),
			});
			await session.start();
			session.conversationContext.addUserMessage('what is the weather');
			session.conversationContext.addAssistantMessage('sunny');
			stub.transport.onResumptionUpdate?.('handle-1', true);
			await session.parkUpstream('idle');
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
			expect(session.sessionManager.resumptionHandle).toBe('handle-1');

			session.notifyClientConnected();

			// The redial started synchronously, without the resumption handle.
			expect(session.sessionManager.state).toBe('RECONNECTING');
			expect(session.sessionManager.resumptionHandle).toBeNull();
			expect(stub.clearResumption).toHaveBeenCalled();
			expect(
				lines.some((l) => l.includes('client attach: redialing UPSTREAM_LOST session, attempt 3')),
			).toBe(true);
			expect(sentTexts(stub).some((t) => t.includes('reconnected'))).toBe(false);

			const s = session;
			await vi.waitFor(() => expect(s.sessionManager.state).toBe('ACTIVE'));
			expect(stub.connect).toHaveBeenCalledTimes(2);
			expect(greetingCount(stub)).toBe(0);
			const injected = stub.sendContent.mock.calls.filter((c) =>
				(c[0] as Array<{ text: string }>).some((t) => t.text.includes(UPSTREAM_REPLAY)),
			);
			expect(injected).toHaveLength(1);
			const [turns, turnComplete] = injected[0] as [Array<{ text: string }>, boolean];
			expect(turnComplete).toBe(false);
			expect(turns[0].text).toContain('user: what is the weather\nassistant: sunny');
		});
	});
});
