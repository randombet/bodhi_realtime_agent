// SPDX-License-Identifier: MIT
//
// GeminiLiveTransport with a `credentialProvider`: a credential fetched for
// every connect, one frozen final setup handed to the provider and dialed, one
// deadline over the fetch and the dial, and a hard close at the credential's
// expiry. Without a provider the transport keeps its static-key behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../src/core/errors.js';
import {
	DEFAULT_GEMINI_LIVE_MODEL,
	type GeminiCredential,
	type GeminiCredentialProvider,
	type GeminiLiveSetup,
	GeminiLiveTransport,
	type GeminiTransportConfig,
	type GeminiTransportOptions,
} from '../../src/transport/gemini-live-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { ConnectionLifecycleEvent } from '../../src/types/transport.js';

type Callbacks = {
	onopen?: () => void;
	onmessage?: (msg: unknown) => void;
	onerror?: (e: { message?: string }) => void;
	onclose?: (e: { code?: number; reason?: string }) => void;
};

interface MockSession {
	sendRealtimeInput: ReturnType<typeof vi.fn>;
	sendClientContent: ReturnType<typeof vi.fn>;
	sendToolResponse: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
}

/** One `live.connect` call: what was dialed, with which client, and handles to
 *  drive its socket. */
interface Dial {
	clientOptions: Record<string, unknown>;
	params: { model: string; config: Record<string, unknown>; callbacks: Callbacks };
	session: MockSession;
	/** Fire `onopen` and resolve `live.connect` with the session. */
	open(): void;
	/** Deliver `setupComplete`. */
	setup(): void;
	/** Fire the socket's `onclose`. */
	close(code?: number, reason?: string): void;
	/** Fire the socket's `onerror`. */
	error(message: string): void;
}

const sdk = vi.hoisted(() => ({
	clientOptions: [] as Array<Record<string, unknown>>,
	dials: [] as unknown[],
	/** `auto`: open at once and set up on the next timer tick; `manual`: the test drives it. */
	mode: 'auto' as 'auto' | 'manual',
}));

vi.mock('@google/genai', () => ({
	GoogleGenAI: vi.fn().mockImplementation((options: Record<string, unknown>) => {
		sdk.clientOptions.push(options);
		return {
			live: {
				connect: vi.fn((params: Dial['params']) => {
					let resolve: (s: MockSession) => void = () => {};
					const pending = new Promise<MockSession>((r) => {
						resolve = r;
					});
					const session: MockSession = {
						sendRealtimeInput: vi.fn(),
						sendClientContent: vi.fn(),
						sendToolResponse: vi.fn(),
						close: vi.fn(),
					};
					const dial: Dial = {
						clientOptions: options,
						params,
						session,
						open: () => {
							params.callbacks.onopen?.();
							resolve(session);
						},
						setup: () => params.callbacks.onmessage?.({ setupComplete: { sessionId: 'sid' } }),
						close: (code, reason) => params.callbacks.onclose?.({ code, reason }),
						error: (message) => params.callbacks.onerror?.({ message }),
					};
					sdk.dials.push(dial);
					if (sdk.mode === 'auto') {
						dial.open();
						setTimeout(() => dial.setup(), 0);
					}
					return pending;
				}),
			},
		};
	}),
}));

const dials = () => sdk.dials as Dial[];
const lastDial = () => dials()[dials().length - 1] as Dial;

const searchTool = (): ToolDefinition => ({
	name: 'search',
	description: 'Search the web',
	parameters: z.object({ query: z.string() }),
	execution: 'inline',
	execute: vi.fn(async () => 'result'),
});

/** A provider minting `auth_tokens/t<n>` per call, recording what it was given. */
function tokenProvider(overrides: Partial<GeminiCredential> = {}) {
	const calls: Array<{ setup: GeminiLiveSetup; signal: AbortSignal }> = [];
	const provider = vi.fn<GeminiCredentialProvider>(async (setup, signal) => {
		calls.push({ setup, signal });
		return {
			apiKey: `auth_tokens/t${calls.length}`,
			apiVersion: 'v1alpha',
			expiresAtMs: Date.now() + 30 * 60_000,
			meta: { credentialId: `cred_${calls.length}` },
			...overrides,
		};
	});
	return { provider, calls };
}

function isDeepFrozen(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return true;
	return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function recordLifecycle(transport: GeminiLiveTransport): ConnectionLifecycleEvent[] {
	const events: ConnectionLifecycleEvent[] = [];
	transport.onConnectionLifecycle = (e) => events.push(e);
	return events;
}

function providerTransport(
	provider: GeminiCredentialProvider,
	options: GeminiTransportOptions = {},
): GeminiLiveTransport {
	return new GeminiLiveTransport({ credentialProvider: provider, ...options }, {});
}

describe('GeminiLiveTransport credentialProvider', () => {
	beforeEach(() => {
		sdk.clientOptions.length = 0;
		sdk.dials.length = 0;
		sdk.mode = 'auto';
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it('builds no client up front and dials each connect with a client built for its credential', async () => {
		const { provider, calls } = tokenProvider();
		const transport = providerTransport(provider);
		expect(sdk.clientOptions).toEqual([]);

		await transport.connect();

		expect(provider).toHaveBeenCalledTimes(1);
		expect(sdk.clientOptions).toEqual([
			{
				apiKey: 'auth_tokens/t1',
				vertexai: false,
				enterprise: false,
				httpOptions: { apiVersion: 'v1alpha' },
			},
		]);
		expect(lastDial().clientOptions).toBe(sdk.clientOptions[0]);
		expect(calls[0]?.signal.aborted).toBe(false);
		expect(transport.isConnected).toBe(true);
	});

	it('omits httpOptions when the credential names no API version', async () => {
		const { provider } = tokenProvider({ apiVersion: undefined });
		await providerTransport(provider).connect();
		expect(sdk.clientOptions[0]).toEqual({
			apiKey: 'auth_tokens/t1',
			vertexai: false,
			enterprise: false,
		});
	});

	it('hands the provider one deep-frozen final setup, and live.connect receives exactly that setup', async () => {
		const { provider, calls } = tokenProvider();
		const realtimeInputConfig = { automaticActivityDetection: { silenceDurationMs: 700 } };
		const transport = providerTransport(provider, {
			systemInstruction: 'You are Kestrel.',
			tools: [searchTool()],
			functionBehavior: 'NON_BLOCKING',
			speechConfig: { voiceName: 'Puck' },
			realtimeInputConfig,
		});
		await transport.connect();

		const setup = calls[0]?.setup as GeminiLiveSetup;
		expect(isDeepFrozen(setup)).toBe(true);
		expect(setup.model).toBe(DEFAULT_GEMINI_LIVE_MODEL);
		expect(lastDial().params.model).toBe(setup.model);
		expect(lastDial().params.config).toEqual(setup.config);
		expect(JSON.stringify(lastDial().params.config)).toBe(JSON.stringify(setup.config));
		expect(setup.config).toMatchObject({
			systemInstruction: 'You are Kestrel.',
			realtimeInputConfig,
			speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
		});
		expect(
			(setup.config.tools as Array<{ functionDeclarations?: Array<{ behavior?: string }> }>)[0]
				?.functionDeclarations?.[0]?.behavior,
		).toBe('NON_BLOCKING');
		// The SDK may write to what it is given; the frozen setup is a separate object,
		// and freezing it never froze the caller's own config.
		expect(lastDial().params.config).not.toBe(setup.config);
		expect(Object.isFrozen(realtimeInputConfig)).toBe(false);
	});

	it('calls the provider on every connect path, each with its own setup and token', async () => {
		const { provider, calls } = tokenProvider();
		const transport = providerTransport(provider, { systemInstruction: 'first' });
		await transport.connect(); // start
		await transport.reconnect(); // GoAway / watchdog reconnect
		await transport.reconnect({ resumptionHandle: 'handle-1', conversationHistory: [] }); // resume
		await transport.transferSession({ instructions: 'second' }); // agent transfer
		transport.updateTools([searchTool()]);
		await transport.reconnect(); // tool-change re-arm
		await transport.abortIncumbent(); // host recovery
		await transport.connect();

		expect(provider).toHaveBeenCalledTimes(6);
		expect(sdk.clientOptions.map((o) => o.apiKey)).toEqual([
			'auth_tokens/t1',
			'auth_tokens/t2',
			'auth_tokens/t3',
			'auth_tokens/t4',
			'auth_tokens/t5',
			'auth_tokens/t6',
		]);
		dials().forEach((dial, i) => {
			expect(dial.clientOptions.apiKey).toBe(`auth_tokens/t${i + 1}`);
			expect(dial.params.config).toEqual(calls[i]?.setup.config);
		});
		expect(calls[2]?.setup.config.sessionResumption).toEqual({ handle: 'handle-1' });
		expect(calls[3]?.setup.config.systemInstruction).toBe('second');
		expect(calls[3]?.setup.config.tools).toBeUndefined();
		expect(
			(calls[4]?.setup.config.tools as Array<{ functionDeclarations?: Array<{ name: string }> }>)[0]
				?.functionDeclarations?.[0]?.name,
		).toBe('search');
		// abortIncumbent() drops the handle: the redial does not resume.
		expect(calls[5]?.setup.config.sessionResumption).toEqual({});
	});

	it('never builds a client from a static key passed to connect(config)', async () => {
		const { provider } = tokenProvider();
		const transport = providerTransport(provider);
		await transport.connect({ auth: { type: 'api_key', apiKey: 'platform-key' }, model: 'm-live' });
		expect(sdk.clientOptions.map((o) => o.apiKey)).toEqual(['auth_tokens/t1']);
		expect(lastDial().params.model).toBe('m-live');
	});

	it('refuses apiKey together with credentialProvider, and a provider that is not a function', () => {
		const { provider } = tokenProvider();
		expect(
			() =>
				new GeminiLiveTransport(
					{ apiKey: 'k', credentialProvider: provider } as unknown as GeminiTransportConfig,
					{},
				),
		).toThrow(ValidationError);
		expect(
			() =>
				new GeminiLiveTransport(
					{ credentialProvider: 'nope' } as unknown as GeminiTransportConfig,
					{},
				),
		).toThrow(ValidationError);
	});

	it('pins the Developer API under the SDK routing environment flags', async () => {
		vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
		vi.stubEnv('GOOGLE_GENAI_USE_ENTERPRISE', 'true');
		const { provider } = tokenProvider();
		await providerTransport(provider).connect();
		const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
		const client = new actual.GoogleGenAI(sdk.clientOptions[0] as { apiKey: string });
		expect(client.vertexai).toBe(false);
		// Control: the same token without the explicit flags would route to Vertex.
		const routed = new actual.GoogleGenAI({ apiKey: 'auth_tokens/t1' });
		expect(routed.vertexai).toBe(true);
	});

	describe('lifecycle events', () => {
		it("carry the provider's meta on the connection's setup-ok and close", async () => {
			const { provider } = tokenProvider();
			const transport = providerTransport(provider);
			const events = recordLifecycle(transport);
			await transport.connect();
			await transport.disconnect();

			expect(events).toEqual([
				{ kind: 'attempt', connectAttemptId: 'att_1', handleSupplied: false },
				{
					kind: 'setup-ok',
					connectAttemptId: 'att_1',
					transportGeneration: 1,
					meta: { credentialId: 'cred_1' },
				},
				{
					kind: 'generation-close',
					connectAttemptId: 'att_1',
					transportGeneration: 1,
					code: 1000,
					reason: 'local disconnect',
					meta: { credentialId: 'cred_1' },
				},
			]);
		});

		it('report a provider failure as a pre-setup close carrying its error, and dial nothing', async () => {
			const refused = Object.assign(new Error('voice_key_missing'), { code: 'voice_key_missing' });
			const transport = providerTransport(async () => {
				throw refused;
			});
			const events = recordLifecycle(transport);

			await expect(transport.connect()).rejects.toThrow(
				'Gemini credential provider failed: voice_key_missing',
			);

			expect(sdk.clientOptions).toEqual([]);
			const failure = {
				source: 'provider',
				message: 'Gemini credential provider failed: voice_key_missing',
				error: refused,
			};
			expect(events).toEqual([
				{ kind: 'attempt', connectAttemptId: 'att_1', handleSupplied: false },
				{
					kind: 'attempt-close',
					connectAttemptId: 'att_1',
					reason: failure.message,
					failure,
				},
				{ kind: 'setup-failed', connectAttemptId: 'att_1', reason: failure.message, failure },
			]);
			expect(transport.isConnected).toBe(false);
		});

		it('report a provider that throws synchronously the same way', async () => {
			const transport = providerTransport(() => {
				throw new Error('boom');
			});
			const events = recordLifecycle(transport);
			await expect(transport.connect()).rejects.toThrow('Gemini credential provider failed: boom');
			expect(events.map((e) => e.kind)).toEqual(['attempt', 'attempt-close', 'setup-failed']);
			expect(sdk.clientOptions).toEqual([]);
		});

		it('say where a socket closed before setupComplete: a refused upgrade, or a refused setup', async () => {
			sdk.mode = 'manual';
			const { provider } = tokenProvider();
			const transport = providerTransport(provider);
			const events = recordLifecycle(transport);

			const first = transport.connect();
			await vi.waitFor(() => expect(dials()).toHaveLength(1));
			lastDial().error('Unexpected server response: 403');
			lastDial().close(1006, '');
			await expect(first).rejects.toThrow('closed before setupComplete');

			const second = transport.connect();
			await vi.waitFor(() => expect(dials()).toHaveLength(2));
			lastDial().open();
			lastDial().close(1008, 'Token has been used too many times');
			await expect(second).rejects.toThrow('closed before setupComplete');

			const closes = events.filter((e) => e.kind === 'attempt-close');
			expect(closes).toEqual([
				{
					kind: 'attempt-close',
					connectAttemptId: 'att_1',
					code: 1006,
					reason: '',
					meta: { credentialId: 'cred_1' },
					failure: {
						source: 'dial',
						message: 'Gemini socket closed before setupComplete (code=1006)',
						code: 1006,
						status: 403,
					},
				},
				{
					kind: 'attempt-close',
					connectAttemptId: 'att_3',
					code: 1008,
					reason: 'Token has been used too many times',
					meta: { credentialId: 'cred_2' },
					failure: {
						source: 'session',
						message:
							'Gemini socket closed before setupComplete (code=1008): Token has been used too many times',
						code: 1008,
						reason: 'Token has been used too many times',
					},
				},
			]);
			const failed = events.filter((e) => e.kind === 'setup-failed');
			expect(failed.map((e) => (e as { failure?: { source: string } }).failure?.source)).toEqual([
				'dial',
				'session',
			]);
		});
	});

	describe('credential checks', () => {
		it.each<[string, () => Partial<GeminiCredential>, string]>([
			['no apiKey', () => ({ apiKey: '' }), 'credentialProvider returned no apiKey'],
			[
				'a non-finite expiry',
				() => ({ expiresAtMs: Number.POSITIVE_INFINITY }),
				'credentialProvider returned a non-finite expiresAtMs',
			],
			[
				'an expiry inside the connect deadline',
				() => ({ expiresAtMs: Date.now() + 29_000 }),
				'less than the 30000ms connect deadline',
			],
		])('refuse a credential with %s before dialing', async (_label, overrides, message) => {
			const { provider } = tokenProvider(overrides());
			const transport = providerTransport(provider);
			const events = recordLifecycle(transport);
			await expect(transport.connect()).rejects.toThrow(message);
			expect(sdk.clientOptions).toEqual([]);
			const failed = events.find((e) => e.kind === 'setup-failed') as {
				failure?: { source: string; error: unknown };
			};
			expect(failed.failure?.source).toBe('provider');
			expect(failed.failure?.error).toBeInstanceOf(ValidationError);
			// The refused credential was still minted: its meta lets the owner
			// match these events to it.
			expect(events.filter((e) => e.kind !== 'attempt')).toEqual([
				expect.objectContaining({ kind: 'attempt-close', meta: { credentialId: 'cred_1' } }),
				expect.objectContaining({ kind: 'setup-failed', meta: { credentialId: 'cred_1' } }),
			]);
		});

		it('refuse a provider result that is not a credential, with no meta to report', async () => {
			const transport = providerTransport(async () => undefined as unknown as GeminiCredential);
			const events = recordLifecycle(transport);
			await expect(transport.connect()).rejects.toThrow('credentialProvider returned no apiKey');
			expect(sdk.clientOptions).toEqual([]);
			expect(events.map((e) => e.kind)).toEqual(['attempt', 'attempt-close', 'setup-failed']);
			for (const event of events) expect(event).not.toHaveProperty('meta');
		});
	});

	describe('one deadline over the fetch and the dial', () => {
		it('aborts the credential fetch at half the connect deadline', async () => {
			vi.useFakeTimers();
			let signal: AbortSignal | undefined;
			const transport = providerTransport(
				(_setup, s) => {
					signal = s;
					return new Promise<GeminiCredential>(() => {});
				},
				{ connectTimeoutMs: 1_000 },
			);
			const events = recordLifecycle(transport);
			const connecting = transport.connect();
			connecting.catch(() => {});

			await vi.advanceTimersByTimeAsync(499);
			expect(signal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(signal?.aborted).toBe(true);
			await expect(connecting).rejects.toThrow('credential fetch timed out after 500ms');

			expect(sdk.clientOptions).toEqual([]);
			expect(events.at(-1)).toMatchObject({
				kind: 'setup-failed',
				failure: { source: 'provider' },
			});
			expect(vi.getTimerCount()).toBe(0);
		});

		it('gives the dial what the fetch left of the same deadline', async () => {
			vi.useFakeTimers();
			sdk.mode = 'manual';
			const transport = providerTransport(
				async () => {
					await new Promise((r) => setTimeout(r, 400));
					return { apiKey: 'auth_tokens/t1', expiresAtMs: Date.now() + 60_000 };
				},
				{ connectTimeoutMs: 1_000 },
			);
			const connecting = transport.connect();
			connecting.catch(() => {});
			await vi.advanceTimersByTimeAsync(400);
			expect(dials()).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(599);
			expect(transport.isConnected).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(connecting).rejects.toThrow('Gemini connect timed out after 1000ms');
		});

		it('abortIncumbent() during the fetch aborts it, and a credential that arrives later is never used', async () => {
			let resolve: (c: GeminiCredential) => void = () => {};
			let signal: AbortSignal | undefined;
			const transport = providerTransport((_setup, s) => {
				signal = s;
				return new Promise<GeminiCredential>((r) => {
					resolve = r;
				});
			});
			const events = recordLifecycle(transport);
			const connecting = transport.connect();

			await transport.abortIncumbent();
			expect(signal?.aborted).toBe(true);
			await expect(connecting).rejects.toThrow('Gemini dial superseded before setupComplete');

			resolve({ apiKey: 'auth_tokens/late', expiresAtMs: Date.now() + 60_000 });
			await new Promise((r) => setTimeout(r, 5));
			expect(sdk.clientOptions).toEqual([]);
			expect(events.map((e) => e.kind)).toEqual(['attempt']);
		});

		it('a credential that resolves just as the attempt is retired is never dialed', async () => {
			const transport = providerTransport(() => {
				const credential = Promise.resolve({
					apiKey: 'auth_tokens/t1',
					expiresAtMs: Date.now() + 60_000,
				});
				// Retired once the credential has resolved, a microtask before the
				// transport's continuation runs: the fetch can no longer be aborted.
				void credential.then(() => {}).then(() => transport.abortIncumbent());
				return credential;
			});
			await expect(transport.connect()).rejects.toThrow('superseded');
			expect(sdk.clientOptions).toEqual([]);
			expect(dials()).toEqual([]);
		});

		it('disconnect() during the fetch aborts it, fails that connect, and dials nothing', async () => {
			let resolve: (c: GeminiCredential) => void = () => {};
			let signal: AbortSignal | undefined;
			const transport = providerTransport((_setup, s) => {
				signal = s;
				return new Promise<GeminiCredential>((r) => {
					resolve = r;
				});
			});
			const events = recordLifecycle(transport);
			const connecting = transport.connect();
			connecting.catch(() => {});

			await transport.disconnect();
			expect(signal?.aborted).toBe(true);
			await expect(connecting).rejects.toThrow(
				'Gemini credential provider failed: Gemini transport disconnected',
			);
			resolve({ apiKey: 'auth_tokens/late', expiresAtMs: Date.now() + 60_000 });
			await new Promise((r) => setTimeout(r, 5));
			expect(sdk.clientOptions).toEqual([]);
			expect(events.map((e) => e.kind)).toEqual(['attempt', 'attempt-close', 'setup-failed']);
			expect(transport.isConnected).toBe(false);
		});

		it('a newer connect() supersedes a fetch in flight', async () => {
			const signals: AbortSignal[] = [];
			let first = true;
			const transport = providerTransport(async (_setup, s) => {
				signals.push(s);
				if (first) {
					first = false;
					return new Promise<GeminiCredential>(() => {});
				}
				return { apiKey: 'auth_tokens/second', expiresAtMs: Date.now() + 60_000 };
			});
			const stale = transport.connect();
			stale.catch(() => {});
			await transport.connect();
			expect(signals[0]?.aborted).toBe(true);
			await expect(stale).rejects.toThrow('superseded');
			expect(sdk.clientOptions.map((o) => o.apiKey)).toEqual(['auth_tokens/second']);
			expect(transport.isConnected).toBe(true);
		});

		it('a dial that never opens holds nothing once the deadline retires it, and closes the moment it opens', async () => {
			vi.useFakeTimers();
			sdk.mode = 'manual';
			const { provider } = tokenProvider();
			const transport = providerTransport(provider, { connectTimeoutMs: 1_000 });
			const events = recordLifecycle(transport);
			const connecting = transport.connect();
			connecting.catch(() => {});

			await vi.advanceTimersByTimeAsync(1_000);
			await expect(connecting).rejects.toThrow('Gemini connect timed out after 1000ms');
			expect(events.at(-1)).toMatchObject({
				kind: 'setup-failed',
				meta: { credentialId: 'cred_1' },
				failure: { source: 'dial', message: 'Gemini connect timed out after 1000ms' },
			});
			expect(vi.getTimerCount()).toBe(0);
			expect(transport.isConnected).toBe(false);

			const dial = lastDial();
			dial.open();
			await vi.advanceTimersByTimeAsync(0);
			expect(dial.session.close).toHaveBeenCalledTimes(1);
			dial.setup();
			expect(transport.isConnected).toBe(false);
			expect(events.filter((e) => e.kind === 'setup-ok')).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('a credential expiring at the deadline cannot outlive a dial that never sets up', async () => {
			vi.useFakeTimers();
			sdk.mode = 'manual';
			const transport = providerTransport(
				async () => ({ apiKey: 'auth_tokens/t1', expiresAtMs: Date.now() + 1_000 }),
				{ connectTimeoutMs: 1_000 },
			);
			const expired = vi.fn();
			transport.onCredentialExpiry = expired;
			const connecting = transport.connect();
			connecting.catch(() => {});
			await vi.advanceTimersByTimeAsync(0);
			lastDial().open();
			await vi.advanceTimersByTimeAsync(1_000);
			await expect(connecting).rejects.toThrow('timed out');
			await vi.advanceTimersByTimeAsync(5_000);
			expect(expired).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe('hard close at expiresAtMs', () => {
		async function connectedWithExpiry(lifetimeMs: number) {
			vi.useFakeTimers();
			let n = 0;
			const transport = providerTransport(async () => {
				n++;
				return {
					apiKey: `auth_tokens/t${n}`,
					expiresAtMs: Date.now() + lifetimeMs,
					meta: { credentialId: `cred_${n}` },
				};
			});
			const events = recordLifecycle(transport);
			const connecting = transport.connect();
			await vi.advanceTimersByTimeAsync(1);
			await connecting;
			return { transport, events };
		}

		it('reconnects with a new credential when the owner reconnects at expiry', async () => {
			const { transport, events } = await connectedWithExpiry(60_000);
			const expiring = lastDial();
			const expired = vi.fn(() => {
				void transport.reconnect();
			});
			transport.onCredentialExpiry = expired;

			await vi.advanceTimersByTimeAsync(59_998);
			expect(expired).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(expired).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);

			expect(expiring.session.close).toHaveBeenCalledTimes(1);
			expect(sdk.clientOptions.map((o) => o.apiKey)).toEqual(['auth_tokens/t1', 'auth_tokens/t2']);
			expect(transport.isConnected).toBe(true);
			expect(events.filter((e) => e.kind === 'generation-close')).toEqual([
				{
					kind: 'generation-close',
					connectAttemptId: 'att_1',
					transportGeneration: 1,
					code: 1000,
					reason: 'local disconnect',
					meta: { credentialId: 'cred_1' },
				},
			]);
			expect(events.at(-1)).toMatchObject({ kind: 'setup-ok', meta: { credentialId: 'cred_2' } });
		});

		it('closes the connection itself when nobody reconnects, and reports the close once', async () => {
			const { transport, events } = await connectedWithExpiry(60_000);
			const expiring = lastDial();
			const onClose = vi.fn();
			transport.onClose = onClose;

			await vi.advanceTimersByTimeAsync(60_000);

			expect(expiring.session.close).toHaveBeenCalledTimes(1);
			expect(transport.isConnected).toBe(false);
			expect(onClose).toHaveBeenCalledWith(1000, 'credential expired');
			expect(events.at(-1)).toEqual({
				kind: 'generation-close',
				connectAttemptId: 'att_1',
				transportGeneration: 1,
				code: 1000,
				reason: 'credential expired',
				meta: { credentialId: 'cred_1' },
			});
			// The socket's own close, arriving later, is fenced off.
			expiring.close(1000, '');
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(events.filter((e) => e.kind === 'generation-close')).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);

			// The next connect fetches a new credential.
			const reconnecting = transport.connect();
			await vi.advanceTimersByTimeAsync(1);
			await reconnecting;
			expect(sdk.clientOptions.map((o) => o.apiKey)).toEqual(['auth_tokens/t1', 'auth_tokens/t2']);
		});

		it('does nothing at the expiry of a connection already retired or replaced', async () => {
			const { transport } = await connectedWithExpiry(60_000);
			const expired = vi.fn();
			transport.onCredentialExpiry = expired;
			await transport.disconnect();
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(expired).not.toHaveBeenCalled();

			// Replaced by a reconnect: only the new connection's expiry is pending.
			const reconnecting = transport.connect();
			await vi.advanceTimersByTimeAsync(1);
			await reconnecting;
			await vi.advanceTimersByTimeAsync(30_000);
			const again = transport.reconnect();
			await vi.advanceTimersByTimeAsync(1);
			await again;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(expired).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(1);
		});

		it('a connect that replaces the connection drops its expiry, even when it fails', async () => {
			vi.useFakeTimers();
			let n = 0;
			const transport = providerTransport(async () => {
				n++;
				if (n > 1) throw new Error('refused');
				return { apiKey: 'auth_tokens/t1', expiresAtMs: Date.now() + 60_000 };
			});
			const expired = vi.fn();
			transport.onCredentialExpiry = expired;
			const connecting = transport.connect();
			await vi.advanceTimersByTimeAsync(1);
			await connecting;
			expect(vi.getTimerCount()).toBe(1);
			await expect(transport.connect()).rejects.toThrow('refused');
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(expired).not.toHaveBeenCalled();
		});

		it('a server close of the connection drops its expiry', async () => {
			const { transport } = await connectedWithExpiry(60_000);
			const expired = vi.fn();
			transport.onCredentialExpiry = expired;
			lastDial().close(1011, 'internal error');
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(expired).not.toHaveBeenCalled();
		});

		it('waits out an expiry longer than one timer can hold', async () => {
			const days = (n: number) => n * 24 * 60 * 60_000;
			const { transport } = await connectedWithExpiry(days(30));
			const expired = vi.fn();
			transport.onCredentialExpiry = expired;
			await vi.advanceTimersByTimeAsync(days(25));
			expect(expired).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(days(5));
			expect(expired).toHaveBeenCalledTimes(1);
		});
	});
});

describe('GeminiLiveTransport without a credentialProvider', () => {
	beforeEach(() => {
		sdk.clientOptions.length = 0;
		sdk.dials.length = 0;
		sdk.mode = 'auto';
	});

	it('builds its one static-key client in the constructor and dials the config it built', async () => {
		const transport = new GeminiLiveTransport({ apiKey: 'static-key' }, {});
		expect(sdk.clientOptions).toEqual([{ apiKey: 'static-key' }]);
		const events = recordLifecycle(transport);
		await transport.connect();
		await transport.reconnect();
		await transport.disconnect();

		expect(sdk.clientOptions).toEqual([{ apiKey: 'static-key' }]);
		expect(Object.isFrozen(lastDial().params.config)).toBe(false);
		for (const event of events) {
			expect(Object.hasOwn(event, 'meta')).toBe(false);
			expect(Object.hasOwn(event, 'failure')).toBe(false);
		}
		expect(events.map((e) => e.kind)).toEqual([
			'attempt',
			'setup-ok',
			'generation-close',
			'attempt',
			'setup-ok',
			'generation-close',
		]);
	});

	it('rebuilds its client from a static key in connect(config), as before', async () => {
		const transport = new GeminiLiveTransport({ apiKey: 'static-key' }, {});
		await transport.connect({ auth: { type: 'api_key', apiKey: 'other-key' }, model: 'm-live' });
		expect(sdk.clientOptions).toEqual([{ apiKey: 'static-key' }, { apiKey: 'other-key' }]);
		expect(lastDial().clientOptions).toEqual({ apiKey: 'other-key' });
	});

	it('reports a close before setupComplete without a failure', async () => {
		sdk.mode = 'manual';
		const transport = new GeminiLiveTransport({ apiKey: 'static-key' }, {});
		const events = recordLifecycle(transport);
		const connecting = transport.connect();
		lastDial().close(1006, 'gone');
		await expect(connecting).rejects.toThrow('closed before setupComplete');
		expect(events).toEqual([
			{ kind: 'attempt', connectAttemptId: 'att_1', handleSupplied: false },
			{ kind: 'attempt-close', connectAttemptId: 'att_1', code: 1006, reason: 'gone' },
			{
				kind: 'setup-failed',
				connectAttemptId: 'att_1',
				reason: 'Gemini socket closed before setupComplete (code=1006): gone',
			},
		]);
		for (const event of events) expect(Object.hasOwn(event, 'failure')).toBe(false);
	});
});
