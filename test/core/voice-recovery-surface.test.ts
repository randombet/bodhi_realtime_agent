// SPDX-License-Identifier: MIT
//
// Recovery surface a host's active-silence watchdog builds on: atomic
// recoverUpstream, one reconnect boundary per recovery, generation-correlated
// turn.start publication, the versioned capability descriptor, and the
// synthetic-input hold.

import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RECOVERY_CAPABILITIES } from '../../src/core/host-recovery.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ConnectionLifecycleEvent, STTProvider } from '../../src/types/transport.js';

declare module '@google/genai' {
	function _getConnectCalls(): Array<Record<string, unknown>>;
}

vi.mock('@google/genai', () => {
	const connectCalls: Array<Record<string, unknown>> = [];
	let messageHandler: ((msg: unknown) => void) | null = null;
	let mockSession: Record<string, ReturnType<typeof vi.fn>> | null = null;
	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					connectCalls.push(params);
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					setTimeout(() => cbs.onmessage?.({ setupComplete: { sessionId: 'gs' } }), 5);
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
		_getConnectCalls: () => connectCalls,
	};
});
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'ok' })) }));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;
const echo = (overrides: Partial<MainAgent> = {}): MainAgent => ({
	name: 'echo',
	instructions: 'echo',
	tools: [],
	...overrides,
});

async function startSession(
	hooks: Record<string, unknown> = {},
	extraConfig: Record<string, unknown> = {},
	agent: MainAgent = echo(),
): Promise<VoiceSession> {
	const s = new VoiceSession({
		sessionId: 'sess_rs',
		userId: 'u',
		apiKey: 'k',
		agents: [agent],
		initialAgent: 'echo',
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		upstreamLossPolicy: 'hold',
		model: mockModel,
		hooks,
		...extraConfig,
	});
	await s.start();
	await new Promise((r) => setTimeout(r, 40));
	return s;
}
const fire = async (): Promise<(m: unknown) => void> => {
	const { _getMessageHandler } = await import('@google/genai');
	return (_getMessageHandler as unknown as () => (m: unknown) => void)();
};
const connectCalls = async (): Promise<Array<Record<string, unknown>>> => {
	const { _getConnectCalls } = await import('@google/genai');
	return (_getConnectCalls as unknown as () => Array<Record<string, unknown>>)();
};
const fakeStt = (): STTProvider =>
	({
		configure: vi.fn(),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		feedAudio: vi.fn(),
		commit: vi.fn(),
		handleInterrupted: vi.fn(),
		handleTurnComplete: vi.fn(),
	}) as unknown as STTProvider;
/** The session's transport; `sendContent` is spied through this. */
const transportOf = (s: VoiceSession) =>
	(s as unknown as { transport: { sendContent: (c: unknown, t: boolean) => void } }).transport;
const currentDialGen = (s: VoiceSession): number | undefined =>
	(s as unknown as { transport: { currentDialGen?: number } }).transport.currentDialGen;

describe('recovery surface', () => {
	let session: VoiceSession | null = null;
	afterEach(async () => {
		if (session) await session.close();
		session = null;
	});

	it('exports a versioned capability descriptor and exposes it on the session', async () => {
		expect(RECOVERY_CAPABILITIES.version).toBe(1);
		expect(RECOVERY_CAPABILITIES.recoverUpstream).toBe(true);
		expect(RECOVERY_CAPABILITIES.reconnectBoundary).toBe(true);
		expect(RECOVERY_CAPABILITIES.turnStartPublication).toBe(true);
		expect(RECOVERY_CAPABILITIES.syntheticHold).toBe(true);
		session = await startSession();
		expect(session.getRecoveryCapabilities()).toEqual(RECOVERY_CAPABILITIES);
	});

	// Loading the whole barrel from source can take seconds on a busy machine.
	it('exports the recovery API through the package barrel', async () => {
		const barrel = (await import('../../src/index.js')) as Record<string, unknown>;
		expect(barrel.RECOVERY_CAPABILITIES).toBe(RECOVERY_CAPABILITIES);
	}, 30_000);

	it('degrades the descriptor and refuses recoverUpstream on a transport without the primitives', async () => {
		const bare = {
			capabilities: {
				messageTruncation: false,
				turnDetection: true,
				userTranscription: true,
				inPlaceSessionUpdate: false,
				sessionResumption: false,
				contextCompression: false,
				groundingMetadata: false,
			},
			audioFormat: { inputSampleRate: 16000, outputSampleRate: 24000, bitDepth: 16, channels: 1 },
			connect: vi.fn(async () => {}),
			disconnect: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {}),
			updateSession: vi.fn(),
			sendContent: vi.fn(),
			sendToolResult: vi.fn(),
			sendRealtimeAudio: vi.fn(),
			sendAudio: vi.fn(),
		};
		const s = new VoiceSession({
			sessionId: 'sess_bare',
			userId: 'u',
			apiKey: 'k',
			agents: [echo()],
			initialAgent: 'echo',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			upstreamLossPolicy: 'hold',
			model: mockModel,
			hooks: {},
			transport: bare as never,
		});
		const caps = s.getRecoveryCapabilities();
		expect(caps.recoverUpstream).toBe(false);
		expect(caps.transportGenerations).toBe(false);
		expect(() =>
			s.recoverUpstream({
				reason: 'active-silence',
				skipContextInjection: true,
				holdSyntheticUntilFreshSpeech: false,
			}),
		).toThrow(/recovery primitives/);
	});

	it('publishes turn.start carrying the post-setup transport generation, once per turn', async () => {
		session = await startSession();
		const events: unknown[] = [];
		session.eventBus.subscribe('turn.start', (e: unknown) => events.push(e));
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
		expect(events.length).toBe(1);
		const ev = events[0] as { transportGeneration: number };
		// First dial: transportGeneration domain is the setup-ok counter (1),
		// NOT the dial counter — the two diverge after a recovery.
		expect(ev.transportGeneration).toBe(1);
		// Same turn: no duplicate publication.
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'BBBB' } }] } } });
		expect(events.length).toBe(1);
	});

	it('recoverUpstream: atomic sequence, sync attemptEpoch, activated resolves, no greeting/injection', async () => {
		session = await startSession();
		const sent: unknown[] = [];
		const sendSpy = vi
			.spyOn(transportOf(session), 'sendContent')
			.mockImplementation((c: unknown) => {
				sent.push(c);
			});
		const boundaries: unknown[] = [];
		session.eventBus.subscribe('session.reconnectBoundary', (e: unknown) => boundaries.push(e));

		session.sessionManager.updateResumptionHandle('stale_handle');
		expect(session.sessionManager.state).toBe('ACTIVE');

		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		// Synchronous contract: state already RECONNECTING, epoch known.
		expect(typeof r.attemptEpoch).toBe('number');
		expect(session.sessionManager.state).toBe('RECONNECTING');
		expect(session.sessionManager.resumptionHandle).toBe(null);
		expect(boundaries.length).toBe(1);

		await r.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		const text = JSON.stringify(sent);
		expect(text.includes('reconnected')).toBe(false); // no context injection
		expect(text.includes('Greet')).toBe(false); // no greeting
		sendSpy.mockRestore();
	});

	it('attemptEpoch matches the recovery dial lifecycle; turn.start correlates with setup-ok', async () => {
		const lifecycle: ConnectionLifecycleEvent[] = [];
		session = await startSession(
			{},
			{
				onConnectionLifecycle: (e: ConnectionLifecycleEvent) => lifecycle.push(e),
			},
		);
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		await r.activated;
		expect(currentDialGen(session)).toBe(r.attemptEpoch);
		// The recovery dial's attempt event carries att_<attemptEpoch> — the
		// returned epoch and the lifecycle stream must agree, or the reducer
		// can never correlate its restart with the transport's activation.
		const attempts = lifecycle.filter((e) => e.kind === 'attempt');
		const recoveryAttempt = attempts[attempts.length - 1] as { connectAttemptId: string };
		expect(recoveryAttempt.connectAttemptId).toBe(`att_${r.attemptEpoch}`);
		const setupOks = lifecycle.filter((e) => e.kind === 'setup-ok') as Array<{
			connectAttemptId: string;
			transportGeneration: number;
		}>;
		const recoverySetup = setupOks[setupOks.length - 1];
		expect(recoverySetup.connectAttemptId).toBe(`att_${r.attemptEpoch}`);
		// turn.start after recovery carries the SAME transport generation the
		// setup-ok minted — one authoritative counter, not the dial counter.
		const events: Array<{ transportGeneration?: number }> = [];
		session.eventBus.subscribe('turn.start', (e: unknown) =>
			events.push(e as { transportGeneration?: number }),
		);
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
		expect(events.length).toBe(1);
		expect(events[0].transportGeneration).toBe(recoverySetup.transportGeneration);
	});

	it('turn.start carries the dial-domain attemptEpoch, so the documented fence compares like with like', async () => {
		session = await startSession();
		const events: Array<{ transportGeneration?: number; attemptEpoch?: number }> = [];
		session.eventBus.subscribe('turn.start', (e: unknown) =>
			events.push(e as { transportGeneration?: number; attemptEpoch?: number }),
		);
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		await r.activated;
		expect(currentDialGen(session)).toBe(r.attemptEpoch);
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
		expect(events.length).toBe(1);
		// The contract says a turn.start below the epoch is stale. That is only a
		// valid test in ONE domain: the dial counter also advances on failed and
		// aborted dials, so the post-setup counter is legitimately lower and a
		// coordinator comparing it against the epoch rejects a VALID replacement.
		expect(events[0].attemptEpoch).toBe(r.attemptEpoch);
		expect(events[0].attemptEpoch).toBeGreaterThanOrEqual(events[0].transportGeneration as number);
	});

	it('recovery clears the transport-side resumption handle: the redial sends none', async () => {
		session = await startSession();
		// Server grants a resumable handle — the transport stores it and would
		// offer it on the next dial.
		(await fire())({ sessionResumptionUpdate: { newHandle: 'h_stale', resumable: true } });
		const before = (await connectCalls()).length;
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		await r.activated;
		const calls = await connectCalls();
		expect(calls.length).toBe(before + 1);
		const cfg = calls[before].config as { sessionResumption?: { handle?: string } };
		// A recovery redial must NOT resume the wedged server-side turn.
		expect(cfg.sessionResumption?.handle).toBeUndefined();
	});

	it('a reentrant recoverUpstream from a boundary subscriber gets the latched result', async () => {
		session = await startSession();
		const boundaries: unknown[] = [];
		let reentrant: unknown = null;
		session.eventBus.subscribe('session.reconnectBoundary', (e: unknown) => {
			boundaries.push(e);
			reentrant ??= session?.recoverUpstream({
				reason: 'active-silence',
				skipContextInjection: true,
				holdSyntheticUntilFreshSpeech: false,
			});
		});
		const before = (await connectCalls()).length;
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		expect(reentrant).toBe(r);
		expect(boundaries.length).toBe(1);
		await r.activated;
		// Exactly one recovery dial — the reentrant call must not start a second.
		expect((await connectCalls()).length).toBe(before + 1);
	});

	it('recoverUpstream is single-flight while a dial is pending', async () => {
		session = await startSession();
		const a = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		const b = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		expect(b).toBe(a);
		await a.activated;
	});

	it('each recovery publishes exactly one reconnect boundary, with a strictly increasing attemptEpoch', async () => {
		session = await startSession();
		const boundaries: Array<{ attemptEpoch: number }> = [];
		session.eventBus.subscribe('session.reconnectBoundary', (e: unknown) =>
			boundaries.push(e as { attemptEpoch: number }),
		);
		const first = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		expect(boundaries.length).toBe(1);
		await first.activated;
		const second = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		expect(boundaries.length).toBe(2);
		await second.activated;
		expect(boundaries.length).toBe(2);
		expect(boundaries.map((b) => b.attemptEpoch)).toEqual([
			first.attemptEpoch,
			second.attemptEpoch,
		]);
		expect(second.attemptEpoch).toBeGreaterThan(first.attemptEpoch);
	});

	it('synthetic hold: queued notifications stay held until real input transcription, then drain', async () => {
		session = await startSession();
		const sendSpy = vi.spyOn(transportOf(session), 'sendContent').mockImplementation(() => {});
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);

		const notificationQueue = (
			session as unknown as {
				notificationQueue: {
					sendOrQueue: (
						turns: Array<{ role: string; parts: Array<{ text: string }> }>,
						t: boolean,
					) => void;
					onTurnComplete: () => void;
				};
			}
		).notificationQueue;
		notificationQueue.sendOrQueue(
			[{ role: 'user', parts: [{ text: '[SUBAGENT UPDATE]: held?' }] }],
			true,
		);
		const heldCalls = sendSpy.mock.calls.length;
		// Nothing synthetic may reach the transport while held.
		expect(JSON.stringify(sendSpy.mock.calls).includes('held?')).toBe(false);

		// Fresh user speech through the REAL path (built-in input transcription)
		// releases the hold…
		(await fire())({ serverContent: { inputTranscription: { text: 'hello again' } } });
		expect(session.isSyntheticHoldActive()).toBe(false);
		// …and the queue drains through its normal turn-complete path.
		notificationQueue.onTurnComplete();
		expect(JSON.stringify(sendSpy.mock.calls).includes('held?')).toBe(true);
		expect(sendSpy.mock.calls.length).toBeGreaterThan(heldCalls);
		sendSpy.mockRestore();
	});

	it('external STT finals release the hold', async () => {
		const stt = fakeStt();
		session = await startSession({}, { sttProvider: stt });
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);
		(stt as { onTranscript?: (t: string, turnId?: number) => void }).onTranscript?.('hi there');
		expect(session.isSyntheticHoldActive()).toBe(false);
	});

	it('a pre-recovery STT capture completing after the boundary does NOT release the hold', async () => {
		const stt = fakeStt();
		session = await startSession({}, { sttProvider: stt });
		// A turn runs BEFORE recovery: commit() stamps the capture's dial generation.
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
		const commitCalls = (stt.commit as unknown as { mock: { calls: number[][] } }).mock.calls;
		expect(commitCalls.length).toBeGreaterThan(0);
		const preRecoveryTurn = commitCalls[commitCalls.length - 1][0];
		// Complete the turn so the next one can commit again (the commit latch
		// clears on turn completion, not on the next model turn).
		(await fire())({ serverContent: { turnComplete: true } });

		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);

		// The batch request issued before the boundary now resolves. Arriving after
		// the boundary does not place the SPEECH after it — the hold must survive.
		const onTranscript = (stt as { onTranscript?: (t: string, turnId?: number) => void })
			.onTranscript;
		onTranscript?.('speech from before the recovery', preRecoveryTurn);
		expect(session.isSyntheticHoldActive()).toBe(true);

		// Control: a capture stamped on the CURRENT dial still releases it, so the
		// fence is rejecting stale captures rather than all external finals.
		(await fire())({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAAA' } }] } } });
		expect(
			(stt.commit as unknown as { mock: { calls: number[][] } }).mock.calls.length,
		).toBeGreaterThan(commitCalls.length - 1);
		const freshTurn = (stt.commit as unknown as { mock: { calls: number[][] } }).mock.calls.at(
			-1,
		)?.[0];
		onTranscript?.('speech after the recovery', freshTurn);
		expect(session.isSyntheticHoldActive()).toBe(false);
	});

	it('VAD barge-in (interrupted) releases the hold', async () => {
		session = await startSession();
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);
		(await fire())({ serverContent: { interrupted: true } });
		expect(session.isSyntheticHoldActive()).toBe(false);
	});

	it('typed text input releases the hold', async () => {
		session = await startSession();
		const sendSpy = vi.spyOn(transportOf(session), 'sendContent').mockImplementation(() => {});
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);
		void session.injectTranscript('typed');
		expect(session.isSyntheticHoldActive()).toBe(false);
		sendSpy.mockRestore();
	});

	it.todo('the hold gates greetings, directive reinforcement and reconnect context injection');

	it('a tool result issued before recovery is dropped, not sent into the replacement session', async () => {
		let resolveTool!: (v: string) => void;
		const toolDone = new Promise<string>((res) => {
			resolveTool = res;
		});
		const agent = echo({
			tools: [
				{
					name: 'slow_tool',
					description: 'slow',
					parameters: z.object({}),
					execution: 'inline' as const,
					execute: async () => toolDone,
				} as never,
			],
		});
		session = await startSession({}, {}, agent);
		(await fire())({
			toolCall: { functionCalls: [{ id: 'call_old', name: 'slow_tool', args: {} }] },
		});
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		await r.activated;
		const { _getMockSession } = await import('@google/genai');
		const replacement = (
			_getMockSession as unknown as () => { sendToolResponse: ReturnType<typeof vi.fn> }
		)();
		resolveTool('late result');
		await new Promise((res) => setTimeout(res, 20));
		// The stale-generation completion must not reach the new session.
		expect(replacement.sendToolResponse).not.toHaveBeenCalled();
	});

	it('a late incumbent close after the replacement is ACTIVE is a no-op', async () => {
		session = await startSession();
		const { _getMockSession } = await import('@google/genai');
		const incumbent = (_getMockSession as unknown as () => { close: ReturnType<typeof vi.fn> })();
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		await r.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		// Incumbent cleanup ran (close attempted) without touching the new session.
		await r.incumbentClosed;
		expect(incumbent.close).toHaveBeenCalled();
		expect(session.sessionManager.state).toBe('ACTIVE');
	});

	it('incumbentClosed reports forced when the incumbent close throws', async () => {
		session = await startSession();
		const { _getMockSession } = await import('@google/genai');
		const incumbent = (_getMockSession as unknown as () => { close: ReturnType<typeof vi.fn> })();
		incumbent.close.mockImplementation(() => {
			throw new Error('socket already dead');
		});
		const r = session.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: false,
		});
		await expect(r.incumbentClosed).resolves.toBe('forced');
		await r.activated;
	});
});
