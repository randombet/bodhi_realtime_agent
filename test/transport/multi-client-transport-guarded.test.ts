import { type Server, createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
	type ConnectionContext,
	type GuardedLifecycle,
	MultiClientTransport,
	type TeardownCause,
} from '../../src/transport/multi-client-transport.js';

// C1 test matrix for the guarded lifecycle (reuse plan S3): validation gating,
// dispose/teardown exactly-once semantics, structured setup rejection,
// shutdown draining, unmatched-path policy, and the legacy exactly-once fix.

type Ctx = { claim: string };

function listen(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			resolve(typeof addr === 'object' && addr ? addr.port : 0);
		});
	});
}

function connect(port: number, path = '/voice'): WebSocket {
	return new WebSocket(`ws://127.0.0.1:${port}${path}`);
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
		ws.on('error', () => {});
	});
}

interface Harness {
	port: number;
	transport: MultiClientTransport<Ctx>;
	events: string[];
	disposals: Array<{ claim: string; reason: string }>;
	teardowns: Array<{ claim: string | undefined; cause: TeardownCause }>;
	cleanup: () => Promise<void>;
}

async function harness(overrides: Partial<GuardedLifecycle<Ctx>> = {}): Promise<Harness> {
	const events: string[] = [];
	const disposals: Array<{ claim: string; reason: string }> = [];
	const teardowns: Array<{ claim: string | undefined; cause: TeardownCause }> = [];
	const guarded: GuardedLifecycle<Ctx> = {
		validateUpgrade: async () => ({ ok: true, appContext: { claim: 'c1' } }),
		setup: async () => ({ ok: true }),
		disposeValidatedContext: (appContext, reason) => {
			disposals.push({ claim: appContext.claim, reason });
		},
		teardown: (_ws, context, cause) => {
			teardowns.push({ claim: context.appContext?.claim, cause });
		},
		...overrides,
	};
	const httpServer = createServer();
	const transport = new MultiClientTransport<Ctx>(
		0,
		{
			onConnection: (_ws, ctx: ConnectionContext<Ctx>) =>
				void events.push(`connect:${ctx.appContext?.claim}`),
			onJsonFromClient: (_ws, msg) => void events.push(`json:${String(msg.type)}`),
			onAudioFromClient: () => void events.push('audio'),
		},
		'127.0.0.1',
		{ guarded, destroyUnmatched: true, logger: () => {} },
	);
	transport.attachToHttpServer(httpServer, '/voice');
	const port = await listen(httpServer);
	return {
		port,
		transport,
		events,
		disposals,
		teardowns,
		cleanup: async () => {
			await transport.stop();
			await new Promise((r) => httpServer.close(r));
		},
	};
}

let active: Harness | null = null;
afterEach(async () => {
	await active?.cleanup();
	active = null;
});

describe('MultiClientTransport guarded lifecycle', () => {
	it('ok: validates, sets up, delivers appContext, dispatches frames', async () => {
		const h = await harness();
		active = h;
		const ws = connect(h.port);
		await vi.waitFor(() => expect(h.events).toContain('connect:c1'));
		ws.send(JSON.stringify({ type: 'text_input', text: 'hi' }));
		await vi.waitFor(() => expect(h.events).toContain('json:text_input'));
	});

	it('rejected validation: closes with the given code, zero app callbacks', async () => {
		const h = await harness({
			validateUpgrade: async () => ({ ok: false, closeCode: 4404, reason: 'not found' }),
		});
		active = h;
		const ws = connect(h.port);
		const { code, reason } = await closed(ws);
		expect(code).toBe(4404);
		expect(reason).toBe('not found');
		expect(h.events).toEqual([]);
		expect(h.disposals).toEqual([]);
		expect(h.teardowns).toEqual([]);
	});

	it('thrown validation: accept-then-close 4500, zero app callbacks', async () => {
		const h = await harness({
			validateUpgrade: async () => {
				throw new Error('boom');
			},
		});
		active = h;
		const { code } = await closed(connect(h.port));
		expect(code).toBe(4500);
		expect(h.events).toEqual([]);
		expect(h.teardowns).toEqual([]);
	});

	it('frames during pending validation/setup reach no app callback', async () => {
		let releaseSetup: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseSetup = r;
		});
		const h = await harness({
			setup: async () => {
				await gate;
				return { ok: true };
			},
		});
		active = h;
		const ws = connect(h.port);
		await new Promise<void>((r) => ws.on('open', () => r()));
		ws.send(JSON.stringify({ type: 'text_input', text: 'early' }));
		await new Promise((r) => setTimeout(r, 50));
		expect(h.events.filter((e) => e.startsWith('json:'))).toEqual([]);
		releaseSetup();
		await vi.waitFor(() => expect(h.events).toContain('connect:c1'));
		// Early frame was dropped, not queued.
		expect(h.events.filter((e) => e.startsWith('json:'))).toEqual([]);
	});

	it('client close during pending validation: disposeValidatedContext exactly once, no teardown', async () => {
		let releaseValidate: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseValidate = r;
		});
		const h = await harness({
			validateUpgrade: async () => {
				await gate;
				return { ok: true, appContext: { claim: 'c1' } };
			},
		});
		active = h;
		const ws = connect(h.port);
		await new Promise<void>((r) => ws.on('open', () => r()));
		ws.close();
		await new Promise((r) => setTimeout(r, 20));
		releaseValidate();
		await vi.waitFor(() => expect(h.disposals).toEqual([{ claim: 'c1', reason: 'client_closed' }]));
		expect(h.teardowns).toEqual([]);
		expect(h.events).toEqual([]);
	});

	it('stop() during pending validation: aborts, disposes with reason stopping, resolves after disposal', async () => {
		let sawAbort = false;
		let disposalDone = false;
		const h = await harness({
			validateUpgrade: async (_req, signal) => {
				await new Promise<void>((r) => {
					signal.addEventListener('abort', () => {
						sawAbort = true;
						r();
					});
				});
				return { ok: true, appContext: { claim: 'c1' } };
			},
			disposeValidatedContext: async (appContext, reason) => {
				await new Promise((r) => setTimeout(r, 20));
				disposalDone = true;
				h.disposals.push({ claim: appContext.claim, reason });
			},
		});
		active = h;
		const ws = connect(h.port);
		await new Promise<void>((r) => ws.on('open', () => r()));
		await new Promise((r) => setTimeout(r, 20));
		await h.transport.stop();
		expect(sawAbort).toBe(true);
		expect(disposalDone).toBe(true);
		expect(h.disposals).toEqual([{ claim: 'c1', reason: 'stopping' }]);
	});

	it('structured setup rejection: close code preserved (4409) + teardown cause setup_rejected, exactly once', async () => {
		const h = await harness({
			setup: async () => ({ ok: false, closeCode: 4409, reason: 'session limit' }),
		});
		active = h;
		const ws = connect(h.port);
		const { code, reason } = await closed(ws);
		expect(code).toBe(4409);
		expect(reason).toBe('session limit');
		await vi.waitFor(() => expect(h.teardowns).toHaveLength(1));
		expect(h.teardowns[0]).toEqual({
			claim: 'c1',
			cause: { kind: 'setup_rejected', closeCode: 4409, reason: 'session limit' },
		});
		expect(h.events).toEqual([]);
	});

	it('thrown setup maps to 4500 with teardown', async () => {
		const h = await harness({
			setup: async () => {
				throw new Error('exploded');
			},
		});
		active = h;
		const { code } = await closed(connect(h.port));
		expect(code).toBe(4500);
		await vi.waitFor(() => expect(h.teardowns).toHaveLength(1));
		expect(h.teardowns[0].cause.kind).toBe('setup_rejected');
	});

	it('client close during setup: teardown cause disconnect, exactly once', async () => {
		let releaseSetup: () => void = () => {};
		const gate = new Promise<void>((r) => {
			releaseSetup = r;
		});
		const h = await harness({
			setup: async () => {
				await gate;
				return { ok: true };
			},
		});
		active = h;
		const ws = connect(h.port);
		await new Promise<void>((r) => ws.on('open', () => r()));
		await new Promise((r) => setTimeout(r, 20));
		ws.close();
		await new Promise((r) => setTimeout(r, 20));
		releaseSetup();
		await vi.waitFor(() => expect(h.teardowns).toHaveLength(1));
		expect(h.teardowns[0].cause).toEqual({ kind: 'disconnect' });
		expect(h.events).toEqual([]);
	});

	it('live disconnect then stop(): teardown exactly once', async () => {
		const h = await harness();
		active = h;
		const ws = connect(h.port);
		await vi.waitFor(() => expect(h.events).toContain('connect:c1'));
		ws.close();
		await vi.waitFor(() => expect(h.teardowns).toHaveLength(1));
		await h.transport.stop();
		expect(h.teardowns).toHaveLength(1);
		expect(h.teardowns[0].cause).toEqual({ kind: 'disconnect' });
	});

	it('stop() awaits deferred async teardown before resolving', async () => {
		let teardownDone = false;
		const h = await harness({
			teardown: async (_ws, context, cause) => {
				await new Promise((r) => setTimeout(r, 30));
				teardownDone = true;
				h.teardowns.push({ claim: context.appContext?.claim, cause });
			},
		});
		active = h;
		connect(h.port);
		await vi.waitFor(() => expect(h.events).toContain('connect:c1'));
		await h.transport.stop();
		expect(teardownDone).toBe(true);
		expect(h.teardowns[0].cause).toEqual({ kind: 'shutdown' });
	});

	it('destroyUnmatched: sockets on foreign upgrade paths are destroyed', async () => {
		const h = await harness();
		active = h;
		const ws = connect(h.port, '/other');
		await new Promise<void>((resolve) => {
			ws.on('error', () => resolve());
			ws.on('close', () => resolve());
		});
		expect(h.events).toEqual([]);
	});

	it('upgrade arriving after stop() begins is rejected', async () => {
		const h = await harness();
		active = h;
		await h.transport.stop();
		const ws = connect(h.port);
		await new Promise<void>((resolve) => {
			ws.on('error', () => resolve());
			ws.on('close', () => resolve());
		});
		expect(h.events).toEqual([]);
	});
});

describe('MultiClientTransport legacy lifecycle', () => {
	it('onDisconnection fires exactly once when stop() races the close handler', async () => {
		const disconnections: string[] = [];
		const httpServer = createServer();
		const transport = new MultiClientTransport(
			0,
			{
				onDisconnection: (_ws, ctx) => void disconnections.push(ctx.webSocketId),
			},
			'127.0.0.1',
			{ logger: () => {} },
		);
		transport.attachToHttpServer(httpServer, '/voice');
		const port = await listen(httpServer);
		const ws = connect(port);
		await new Promise<void>((r) => ws.on('open', () => r()));
		// stop() closes the socket AND the socket's own close event follows —
		// previously that double-fired onDisconnection.
		await transport.stop();
		await new Promise((r) => setTimeout(r, 30));
		expect(disconnections).toHaveLength(1);
		await new Promise((r) => httpServer.close(r));
	});
});
