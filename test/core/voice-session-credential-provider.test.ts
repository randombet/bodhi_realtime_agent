// SPDX-License-Identifier: MIT
//
// VoiceSession with a Gemini `credentialProvider`: every way the session dials
// Gemini (start, GoAway, an unexpected close, a host recovery, a tool change,
// an agent transfer, a client attach to a parked session, a credential
// expiry) fetches a credential for that connect and dials with it.

import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../src/core/errors.js';
import {
	VoiceSession,
	type VoiceSessionConfig,
	type VoiceSessionOptions,
	type VoiceSessionProviderConfig,
} from '../../src/core/voice-session.js';
import {
	DEFAULT_GEMINI_LIVE_MODEL,
	type GeminiCredentialProvider,
	type GeminiLiveSetup,
	GeminiLiveTransport,
} from '../../src/transport/gemini-live-transport.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ConnectionLifecycleEvent } from '../../src/types/transport.js';

type Callbacks = {
	onmessage?: (msg: unknown) => void;
	onclose?: (e: { code?: number; reason?: string }) => void;
};

interface Dial {
	clientOptions: Record<string, unknown>;
	params: { model: string; config: Record<string, unknown>; callbacks: Callbacks };
	session: {
		close: ReturnType<typeof vi.fn>;
		sendRealtimeInput: ReturnType<typeof vi.fn>;
		sendClientContent: ReturnType<typeof vi.fn>;
	};
}

const sdk = vi.hoisted(() => ({
	clientOptions: [] as Array<Record<string, unknown>>,
	dials: [] as unknown[],
	/** When set, each dial's socket opens only once this settles. */
	opening: null as Promise<void> | null,
}));

vi.mock('@google/genai', () => ({
	GoogleGenAI: vi.fn().mockImplementation((options: Record<string, unknown>) => {
		sdk.clientOptions.push(options);
		return {
			live: {
				connect: vi.fn(async (params: Dial['params']) => {
					const session = {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
					sdk.dials.push({ clientOptions: options, params, session });
					if (sdk.opening) await sdk.opening;
					setTimeout(() => params.callbacks.onmessage?.({ setupComplete: { sessionId: 'gs' } }), 5);
					return session;
				}),
			},
		};
	}),
}));
vi.mock('ai', () => ({ generateText: vi.fn(async () => ({ text: 'ok' })) }));

const dials = () => sdk.dials as Dial[];
const lastDial = () => dials()[dials().length - 1] as Dial;
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

const agents = (): MainAgent[] => [
	{ name: 'main', instructions: 'You are the main agent.', tools: [] },
	{ name: 'other', instructions: 'You are the other agent.', tools: [] },
];

function tokenProvider() {
	const setups: GeminiLiveSetup[] = [];
	const provider = vi.fn<GeminiCredentialProvider>(async (setup) => {
		setups.push(setup);
		return {
			apiKey: `auth_tokens/t${setups.length}`,
			apiVersion: 'v1alpha',
			expiresAtMs: Date.now() + 30 * 60_000,
			meta: { credentialId: `cred_${setups.length}` },
		};
	});
	return { provider, setups };
}

/** Every dial used the token of the provider call made for it, with the setup it was given. */
function expectEachDialUsedItsCredential(setups: GeminiLiveSetup[]): void {
	expect(dials()).toHaveLength(setups.length);
	dials().forEach((dial, i) => {
		expect(dial.clientOptions).toMatchObject({
			apiKey: `auth_tokens/t${i + 1}`,
			vertexai: false,
			enterprise: false,
		});
		expect(dial.params.model).toBe(setups[i]?.model);
		expect(dial.params.config).toEqual(setups[i]?.config);
	});
	// No client was ever built from a static key.
	expect(sdk.clientOptions.every((o) => String(o.apiKey).startsWith('auth_tokens/'))).toBe(true);
}

describe('VoiceSession with a credentialProvider', () => {
	let session: VoiceSession | null = null;

	beforeEach(() => {
		sdk.clientOptions.length = 0;
		sdk.dials.length = 0;
		sdk.opening = null;
	});
	afterEach(async () => {
		if (session) await session.close();
		session = null;
	});

	async function start(
		provider: GeminiCredentialProvider,
		extra: Partial<VoiceSessionOptions> = {},
	): Promise<VoiceSession> {
		const lifecycle: ConnectionLifecycleEvent[] = [];
		session = new VoiceSession({
			sessionId: 'sess_cred',
			userId: 'u',
			credentialProvider: provider,
			agents: agents(),
			initialAgent: 'main',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			upstreamLossPolicy: 'hold',
			model: mockModel,
			onConnectionLifecycle: (e) => lifecycle.push(e),
			...extra,
		});
		(session as unknown as { lifecycle: ConnectionLifecycleEvent[] }).lifecycle = lifecycle;
		await session.start();
		await settle();
		return session;
	}

	/** Deliver a resumption handle on the current connection, so GoAway and
	 *  close reconnects have one to resume with. */
	function sendHandle(handle: string): void {
		lastDial().params.callbacks.onmessage?.({
			sessionResumptionUpdate: { newHandle: handle, resumable: true },
		});
	}

	it('starts on the credential the provider minted for the final setup it was given', async () => {
		const { provider, setups } = tokenProvider();
		const s = await start(provider);

		expect(s.sessionManager.state).toBe('ACTIVE');
		expect(provider).toHaveBeenCalledTimes(1);
		expect(setups[0]?.model).toBe(DEFAULT_GEMINI_LIVE_MODEL);
		expect(setups[0]?.config.systemInstruction).toContain('You are the main agent.');
		expect(Object.isFrozen(setups[0])).toBe(true);
		expect(Object.isFrozen(setups[0]?.config)).toBe(true);
		expectEachDialUsedItsCredential(setups);
		const lifecycle = (s as unknown as { lifecycle: ConnectionLifecycleEvent[] }).lifecycle;
		expect(lifecycle.find((e) => e.kind === 'setup-ok')).toMatchObject({
			meta: { credentialId: 'cred_1' },
		});
	});

	it('sends text turns on the default model as the static-key session does', async () => {
		const { provider } = tokenProvider();
		const s = await start(provider);
		const transport = (s as unknown as { transport: GeminiLiveTransport }).transport;
		transport.sendContent([{ role: 'user', text: 'hello' }], true);
		// The default Live model takes text as realtime input, not client content.
		expect(lastDial().session.sendRealtimeInput).toHaveBeenCalledWith({ text: 'hello' });
		expect(lastDial().session.sendClientContent).not.toHaveBeenCalled();
	});

	it('reconnects on GoAway with a new credential for the resumed setup', async () => {
		const { provider, setups } = tokenProvider();
		const s = await start(provider);
		sendHandle('handle-1');
		lastDial().params.callbacks.onmessage?.({ goAway: { timeLeft: '10s' } });
		await settle();

		expect(s.sessionManager.state).toBe('ACTIVE');
		expect(provider).toHaveBeenCalledTimes(2);
		expect(setups[1]?.config.sessionResumption).toEqual({ handle: 'handle-1' });
		expectEachDialUsedItsCredential(setups);
	});

	it('reconnects after an unexpected close (the response watchdog takes the same path)', async () => {
		const { provider, setups } = tokenProvider();
		const s = await start(provider);
		sendHandle('handle-1');
		lastDial().params.callbacks.onclose?.({ code: 1011, reason: 'internal error' });
		await settle(1_200);

		expect(s.sessionManager.state).toBe('ACTIVE');
		expect(provider).toHaveBeenCalledTimes(2);
		expectEachDialUsedItsCredential(setups);
	});

	it('redials a host recovery with a new credential', async () => {
		const { provider, setups } = tokenProvider();
		const s = await start(provider);
		await s.recoverUpstream({
			reason: 'active-silence',
			skipContextInjection: false,
			holdSyntheticUntilFreshSpeech: false,
		}).activated;

		expect(s.sessionManager.state).toBe('ACTIVE');
		expect(provider).toHaveBeenCalledTimes(2);
		expectEachDialUsedItsCredential(setups);
	});

	it('re-arms a tool change with a credential locked to the new tool list', async () => {
		const { provider, setups } = tokenProvider();
		const s = await start(provider);
		await s.registerTools([
			{
				name: 'lookup',
				description: 'Look something up',
				parameters: z.object({ q: z.string() }),
				execution: 'inline',
				execute: async () => 'found',
			},
		]);
		await s.recoverUpstream({
			reason: 'human-retry',
			skipContextInjection: false,
			holdSyntheticUntilFreshSpeech: false,
		}).activated;

		const names = (
			setups[1]?.config.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>
		)
			.flatMap((t) => t.functionDeclarations ?? [])
			.map((d) => d.name);
		expect(names).toContain('lookup');
		expectEachDialUsedItsCredential(setups);
	});

	it('transfers to another agent on a credential for that agent’s setup', async () => {
		const { provider, setups } = tokenProvider();
		const s = await start(provider);
		await s.transfer('other');
		await settle();

		expect(provider).toHaveBeenCalledTimes(2);
		expect(setups[1]?.config.systemInstruction).toContain('You are the other agent.');
		expectEachDialUsedItsCredential(setups);
	});

	it('redials a parked session on a client attach with a new credential', async () => {
		const { provider, setups } = tokenProvider();
		const s = await start(provider);
		await s.parkUpstream('idle');
		expect(s.sessionManager.state).toBe('UPSTREAM_LOST');

		s.notifyClientConnected();
		await settle();

		expect(s.sessionManager.state).toBe('ACTIVE');
		expect(provider).toHaveBeenCalledTimes(2);
		expectEachDialUsedItsCredential(setups);
	});

	it('reconnects at credential expiry, before any GoAway, on a new credential', async () => {
		const setups: GeminiLiveSetup[] = [];
		const provider: GeminiCredentialProvider = async (setup) => {
			setups.push(setup);
			return { apiKey: `auth_tokens/t${setups.length}`, expiresAtMs: Date.now() + 250 };
		};
		const transport = new GeminiLiveTransport(
			{ credentialProvider: provider, connectTimeoutMs: 100, minCredentialLifetimeMs: 0 },
			{},
		);
		session = new VoiceSession({
			sessionId: 'sess_expiry',
			userId: 'u',
			apiKey: 'unused-with-an-injected-transport',
			transport,
			agents: agents(),
			initialAgent: 'main',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			model: mockModel,
		});
		await session.start();
		await settle();
		sendHandle('handle-1');
		const first = lastDial();

		await settle(300);

		expect(first.session.close).toHaveBeenCalled();
		expect(setups.length).toBeGreaterThanOrEqual(2);
		expect(setups[1]?.config.sessionResumption).toEqual({ handle: 'handle-1' });
		expect(session.sessionManager.state).toBe('ACTIVE');
		expectEachDialUsedItsCredential(setups);
	});

	it('survives a token-service error at credential expiry: retried after the backoff on the same handle', async () => {
		const setups: GeminiLiveSetup[] = [];
		const provider: GeminiCredentialProvider = async (setup) => {
			setups.push(setup);
			if (setups.length === 2) throw new Error('token service 503');
			// Only the first connection expires during the test.
			const lifetimeMs = setups.length === 1 ? 250 : 30 * 60_000;
			return { apiKey: `auth_tokens/t${setups.length}`, expiresAtMs: Date.now() + lifetimeMs };
		};
		const transport = new GeminiLiveTransport(
			{ credentialProvider: provider, connectTimeoutMs: 100, minCredentialLifetimeMs: 0 },
			{},
		);
		const lifecycle: ConnectionLifecycleEvent[] = [];
		session = new VoiceSession({
			sessionId: 'sess_expiry_retry',
			userId: 'u',
			apiKey: 'unused-with-an-injected-transport',
			transport,
			agents: agents(),
			initialAgent: 'main',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			model: mockModel,
			onConnectionLifecycle: (e) => lifecycle.push(e),
		});
		await session.start();
		await settle();
		sendHandle('handle-1');

		await settle(300);
		// The expiry's reconnect failed at its provider: the session waits out the
		// backoff instead of closing (upstreamLossPolicy defaults to 'close').
		expect(setups).toHaveLength(2);
		expect(session.sessionManager.state).toBe('RECONNECTING');
		expect(lifecycle.at(-1)).toMatchObject({
			kind: 'setup-failed',
			failure: { source: 'provider' },
		});

		await settle(1_000);
		expect(setups).toHaveLength(3);
		expect(setups.map((s) => s.config.sessionResumption)).toEqual([
			{},
			{ handle: 'handle-1' },
			{ handle: 'handle-1' },
		]);
		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(dials().map((d) => d.clientOptions.apiKey)).toEqual([
			'auth_tokens/t1',
			'auth_tokens/t3',
		]);
	});

	it('rotates an expiring credential without a resumption handle as a planned reconnect, not a loss', async () => {
		const setups: GeminiLiveSetup[] = [];
		const provider: GeminiCredentialProvider = async (setup) => {
			setups.push(setup);
			const lifetimeMs = setups.length === 1 ? 250 : 30 * 60_000;
			return { apiKey: `auth_tokens/t${setups.length}`, expiresAtMs: Date.now() + lifetimeMs };
		};
		const transport = new GeminiLiveTransport(
			{ credentialProvider: provider, connectTimeoutMs: 100, minCredentialLifetimeMs: 0 },
			{},
		);
		const reconnect = vi.spyOn(transport, 'reconnect');
		const lifecycle: ConnectionLifecycleEvent[] = [];
		const states: string[] = [];
		session = new VoiceSession({
			sessionId: 'sess_expiry_fresh',
			userId: 'u',
			apiKey: 'unused-with-an-injected-transport',
			transport,
			agents: agents(),
			initialAgent: 'main',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			model: mockModel,
			upstreamLossPolicy: 'hold',
			onConnectionLifecycle: (e) => lifecycle.push(e),
		});
		session.eventBus.subscribe('session.stateChange', (e) => states.push(e.toState));
		await session.start();
		await settle();
		// No resumption update arrives: the expiry finds no handle.

		await settle(300);

		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(states).not.toContain('UPSTREAM_LOST');
		expect(setups.map((s) => s.config.sessionResumption)).toEqual([{}, {}]);
		expect(reconnect).toHaveBeenCalledWith(
			expect.not.objectContaining({ resumptionHandle: expect.anything() }),
		);
		expect(reconnect.mock.calls[0]?.[0]).toHaveProperty('conversationHistory');
		// Closed as a local disconnect, which upstream recovery does not count as a loss.
		expect(lifecycle.filter((e) => e.kind === 'generation-close')).toEqual([
			expect.objectContaining({ code: 1000, reason: 'local disconnect' }),
		]);
	});

	it('rotates to a fresh session that replays the conversation even when the transport was built with a handle the session never saw', async () => {
		const setups: GeminiLiveSetup[] = [];
		const provider: GeminiCredentialProvider = async (setup) => {
			setups.push(setup);
			const lifetimeMs = setups.length === 1 ? 250 : 30 * 60_000;
			return { apiKey: `auth_tokens/t${setups.length}`, expiresAtMs: Date.now() + lifetimeMs };
		};
		const transport = new GeminiLiveTransport(
			{
				credentialProvider: provider,
				connectTimeoutMs: 100,
				minCredentialLifetimeMs: 0,
				sessionResumption: { handle: 'seeded-handle' },
			},
			{},
		);
		session = new VoiceSession({
			sessionId: 'sess_expiry_seeded',
			userId: 'u',
			apiKey: 'unused-with-an-injected-transport',
			transport,
			agents: agents(),
			initialAgent: 'main',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			model: mockModel,
			upstreamLossPolicy: 'hold',
		});
		await session.start();
		await settle();
		// The first connect resumed from the seeded handle; no resumption update
		// arrives, so the session itself holds none when the credential expires.
		expect(session.sessionManager.resumptionHandle).toBeNull();
		session.conversationContext.addUserMessage('Book the table for eight.');

		await settle(300);

		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(setups.map((s) => s.config.sessionResumption)).toEqual([
			{ handle: 'seeded-handle' },
			{},
		]);
		expect(dials()).toHaveLength(2);
		expect(lastDial().session.sendClientContent).toHaveBeenCalledWith(
			expect.objectContaining({
				turns: expect.arrayContaining([
					{ role: 'user', parts: [{ text: 'Book the table for eight.' }] },
				]),
			}),
		);
	});

	describe('a turn and a tool call in flight when the credential expires', () => {
		/** A session on an injected provider transport whose first credential
		 *  expires after 250 ms, with a tool that completes when the test says. */
		async function startMidTurn(opts: { handle?: string } = {}) {
			const turnEvents: string[] = [];
			const eventsAtRedial: string[][] = [];
			let calls = 0;
			const provider: GeminiCredentialProvider = async () => {
				calls++;
				if (calls === 2) eventsAtRedial.push([...turnEvents]);
				const lifetimeMs = calls === 1 ? 250 : 30 * 60_000;
				return { apiKey: `auth_tokens/t${calls}`, expiresAtMs: Date.now() + lifetimeMs };
			};
			const transport = new GeminiLiveTransport(
				{ credentialProvider: provider, connectTimeoutMs: 100, minCredentialLifetimeMs: 0 },
				{},
			);
			const pending = new Map<string, (value: unknown) => void>();
			session = new VoiceSession({
				sessionId: 'sess_expiry_mid_turn',
				userId: 'u',
				apiKey: 'unused-with-an-injected-transport',
				transport,
				agents: [
					{
						name: 'main',
						instructions: 'You are the main agent.',
						tools: [
							{
								name: 'slow_lookup',
								description: 'A lookup that completes when the test says so.',
								parameters: z.object({}),
								execution: 'inline',
								execute: (_args, ctx) =>
									new Promise((resolve) => pending.set(ctx.toolCallId, resolve)),
							},
						],
					},
				],
				initialAgent: 'main',
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				model: mockModel,
				upstreamLossPolicy: 'hold',
			});
			session.eventBus.subscribe('turn.interrupted', (e) =>
				turnEvents.push(`interrupted:${e.turnId}`),
			);
			session.eventBus.subscribe('turn.end', (e) => turnEvents.push(`end:${e.turnId}`));
			await session.start();
			await settle();
			if (opts.handle) sendHandle(opts.handle);
			const first = lastDial();
			const callTool = (dial: Dial, id: string) =>
				dial.params.callbacks.onmessage?.({
					toolCall: { functionCalls: [{ id, name: 'slow_lookup', args: {} }] },
				});
			first.params.callbacks.onmessage?.({
				serverContent: { modelTurn: { parts: [{ text: 'Let me look that up.' }] } },
			});
			callTool(first, 'call_old');
			await vi.waitFor(() => expect(pending.has('call_old')).toBe(true));
			await settle(300); // the first credential expires and the session rotates
			const finish = async (id: string) => {
				await vi.waitFor(() => expect(pending.has(id)).toBe(true));
				pending.get(id)?.({ ok: id });
				await settle(10);
			};
			const sentIds = (dial: Dial) =>
				(
					dial.session as unknown as { sendToolResponse: ReturnType<typeof vi.fn> }
				).sendToolResponse.mock.calls.map(
					(c) => (c[0] as { functionResponses: Array<{ id: string }> }).functionResponses[0]?.id,
				);
			return { first, turnEvents, eventsAtRedial, callTool, finish, sentIds };
		}

		it('a fresh rotation ends the turn as interrupted before it redials, and drops the result of a call the new session never issued', async () => {
			const { turnEvents, eventsAtRedial, callTool, finish, sentIds } = await startMidTurn();
			expect(session?.sessionManager.state).toBe('ACTIVE');
			expect(dials()).toHaveLength(2);
			expect(eventsAtRedial).toEqual([['interrupted:turn_1', 'end:turn_1']]);

			const fresh = lastDial();
			await finish('call_old');
			callTool(fresh, 'call_new');
			await finish('call_new');

			expect(sentIds(fresh)).toEqual(['call_new']);
			expect(turnEvents).toEqual(['interrupted:turn_1', 'end:turn_1']);
		});

		it('a rotation that resumes on a handle keeps the turn, and the resumed session gets the result', async () => {
			const { turnEvents, finish, sentIds } = await startMidTurn({ handle: 'handle-1' });
			expect(dials()).toHaveLength(2);
			expect(lastDial().params.config.sessionResumption).toEqual({ handle: 'handle-1' });

			await finish('call_old');

			expect(sentIds(lastDial())).toEqual(['call_old']);
			expect(turnEvents).toEqual([]);
		});
	});

	describe('with upstreamRecovery under hold (the voice lane)', () => {
		async function startLane(failSecond: Error) {
			const setups: GeminiLiveSetup[] = [];
			const provider: GeminiCredentialProvider = async (setup) => {
				setups.push(setup);
				if (setups.length === 2) throw failSecond;
				const lifetimeMs = setups.length === 1 ? 250 : 30 * 60_000;
				return { apiKey: `auth_tokens/t${setups.length}`, expiresAtMs: Date.now() + lifetimeMs };
			};
			const transport = new GeminiLiveTransport(
				{ credentialProvider: provider, connectTimeoutMs: 100, minCredentialLifetimeMs: 0 },
				{},
			);
			const onFatal = vi.fn();
			const states: string[] = [];
			session = new VoiceSession({
				sessionId: 'sess_lane',
				userId: 'u',
				apiKey: 'unused-with-an-injected-transport',
				transport,
				agents: agents(),
				initialAgent: 'main',
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				model: mockModel,
				upstreamLossPolicy: 'hold',
				upstreamRecovery: {
					isLive: () => true,
					parkRedialDelayMs: 10,
					healthTickMs: 0,
					idleParkMs: 0,
					onFatal,
				},
			});
			session.eventBus.subscribe('session.stateChange', (e) => states.push(e.toState));
			await session.start();
			await settle();
			sendHandle('handle-1');
			await settle(300); // the first credential expires
			return { setups, onFatal, states, s: session };
		}

		it('a transient token-service error at expiry is retried on the handle, never parked', async () => {
			const { setups, states, s } = await startLane(new Error('token service 503'));
			await settle(1_200);
			expect(setups.map((x) => x.config.sessionResumption)).toEqual([
				{},
				{ handle: 'handle-1' },
				{ handle: 'handle-1' },
			]);
			expect(s.sessionManager.state).toBe('ACTIVE');
			expect(states).not.toContain('UPSTREAM_LOST');
		});

		it('a permanent one parks the session and starts the fatal backoff: nothing redials', async () => {
			const permanent = Object.assign(new Error('owner has no voice key'), { retryable: false });
			const { setups, onFatal, s } = await startLane(permanent);
			await settle(1_500);
			expect(s.sessionManager.state).toBe('UPSTREAM_LOST');
			expect(setups).toHaveLength(2);
			expect(onFatal).toHaveBeenCalledWith(
				expect.objectContaining({ category: 'credential_permanent' }),
			);
		});
	});

	it('closing during the first credential fetch aborts it, and nothing dials', async () => {
		let signal: AbortSignal | undefined;
		const provider: GeminiCredentialProvider = (_setup, s) => {
			signal = s;
			return new Promise(() => {});
		};
		session = new VoiceSession({
			sessionId: 'sess_close',
			userId: 'u',
			credentialProvider: provider,
			agents: agents(),
			initialAgent: 'main',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			model: mockModel,
		});
		const starting = session.start();
		starting.catch(() => {});
		await settle(5);
		await session.close();
		session = null;

		expect(signal?.aborted).toBe(true);
		await expect(starting).rejects.toThrow('Gemini transport disconnected');
		await settle();
		expect(dials()).toEqual([]);
	});

	it('closing after the first credential, before its socket opens, leaves no connection open', async () => {
		let open: () => void = () => {};
		sdk.opening = new Promise<void>((r) => {
			open = r;
		});
		const { provider } = tokenProvider();
		session = new VoiceSession({
			sessionId: 'sess_close_dial',
			userId: 'u',
			credentialProvider: provider,
			agents: agents(),
			initialAgent: 'main',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			model: mockModel,
		});
		const transport = (session as unknown as { transport: GeminiLiveTransport }).transport;
		const starting = session.start();
		starting.catch(() => {});
		await vi.waitFor(() => expect(dials()).toHaveLength(1));
		await session.close();
		session = null;
		await expect(starting).rejects.toThrow('Gemini transport disconnected before setupComplete');

		open();
		await settle();
		expect(lastDial().session.close).toHaveBeenCalledTimes(1);
		expect(transport.isConnected).toBe(false);
	});

	it('keeps the static-key config as it was, and takes exactly one credential', () => {
		const { provider } = tokenProvider();
		const options: VoiceSessionOptions = {
			sessionId: 's',
			userId: 'u',
			agents: agents(),
			initialAgent: 'main',
			model: mockModel,
		};
		// Static-key configs extend, omit and spread as before.
		interface AppConfig extends VoiceSessionConfig {
			region: string;
		}
		const app: AppConfig = { ...options, apiKey: 'k', region: 'eu' };
		const overrides: Partial<VoiceSessionConfig> = { userId: 'v' };
		const merged: VoiceSessionConfig = { ...app, ...overrides };
		const omitted: Omit<VoiceSessionConfig, 'sessionId'> = merged;
		const withProvider: VoiceSessionProviderConfig = { ...options, credentialProvider: provider };
		expect([omitted.apiKey, withProvider.credentialProvider]).toEqual(['k', provider]);
		// @ts-expect-error apiKey and credentialProvider are mutually exclusive
		const both: VoiceSessionConfig | VoiceSessionProviderConfig = {
			...options,
			apiKey: 'k',
			credentialProvider: provider,
		};
		expect(() => new VoiceSession(both)).toThrow(ValidationError);
	});

	it('refuses a credentialProvider beside an injected transport', () => {
		const { provider } = tokenProvider();
		expect(
			() =>
				new VoiceSession({
					sessionId: 's',
					userId: 'u',
					credentialProvider: provider,
					transport: new GeminiLiveTransport({ apiKey: 'k' }, {}),
					agents: agents(),
					initialAgent: 'main',
					clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
					model: mockModel,
				}),
		).toThrow(ValidationError);
	});
});
