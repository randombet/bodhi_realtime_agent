import { type Server, createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { handleSutandoApiRequest } from '../../app/server/sutando/sutando-endpoints.js';
import type { SutandoOwnerAuthenticator } from '../../app/server/sutando/sutando-owner-auth.js';
import type { SutandoService } from '../../app/server/sutando/sutando-service.js';
import { SutandoTicketStore } from '../../app/server/sutando/sutando-ticket-store.js';

const ORIGIN = 'https://demo.example.com';

const OWNER_AUTH: SutandoOwnerAuthenticator = async (token) => {
	if (token === 'owner-token') return { ok: true, ownerUserId: 'owner-1', email: 'o@example.com' };
	if (token === 'other-token') return { ok: false, reason: 'not_owner' };
	if (!token) return { ok: false, reason: 'no_token' };
	return { ok: false, reason: 'invalid_token' };
};

function readyService(heartbeat: unknown = { inflight: 2 }): SutandoService {
	return {
		state: 'ready',
		config: {
			relayToken: 't',
			ownerEmail: 'o@example.com',
			allowedOrigins: [ORIGIN],
			googleSearch: true,
			relayPort: 7930,
			rawDir: '/tmp/raw',
			ledgerDir: '/tmp/ledger',
		},
		gate: {
			ownerEmail: 'o@example.com',
			supabaseUrl: 'https://p.supabase.co',
			supabaseAnonKey: 'anon',
		},
		relay: {
			presence: () => ({ fresh: true, lastHeartbeatAt: 123, heartbeat }),
		},
		ledger: {},
		stop: async () => {},
	} as unknown as SutandoService;
}

function disabledService(reason: string, withGate = true): SutandoService {
	return {
		state: 'disabled',
		reason,
		...(withGate
			? {
					gate: {
						ownerEmail: 'o@example.com',
						supabaseUrl: 'https://p.supabase.co',
						supabaseAnonKey: 'anon',
					},
				}
			: {}),
		stop: async () => {},
	} as unknown as SutandoService;
}

describe('Sutando REST endpoints', () => {
	let server: Server | null = null;
	let base = '';

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = null;
		}
	});

	async function serve(
		service: SutandoService | null,
		authenticate: SutandoOwnerAuthenticator | null = OWNER_AUTH,
		ticketStore = new SutandoTicketStore(),
	): Promise<SutandoTicketStore> {
		server = createServer((req, res) => {
			res.setHeader('Content-Type', 'application/json');
			const pathname = (req.url ?? '').split('?')[0];
			void handleSutandoApiRequest(req, res, pathname, req.method ?? 'GET', {
				service,
				authenticate,
				ticketStore,
				log: () => {},
			}).then((handled) => {
				if (!handled) {
					res.writeHead(404);
					res.end('{}');
				}
			});
		});
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server?.address();
		base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
		return ticketStore;
	}

	function get(path: string, headers: Record<string, string> = {}) {
		return fetch(`${base}${path}`, { headers });
	}

	function post(path: string, headers: Record<string, string> = {}) {
		return fetch(`${base}${path}`, { method: 'POST', headers });
	}

	// --- /access contract ------------------------------------------------------

	it('access: 401 unauthorized with no token, no configuration state leaked', async () => {
		await serve(readyService());
		const res = await get('/api/sutando/access');
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'unauthorized' });
	});

	it('access: 401 for an invalid token', async () => {
		await serve(readyService());
		const res = await get('/api/sutando/access', { Authorization: 'Bearer bogus' });
		expect(res.status).toBe(401);
	});

	it('access: 403 forbidden for an authenticated non-owner, nothing else in the body', async () => {
		await serve(readyService());
		const res = await get('/api/sutando/access', { Authorization: 'Bearer other-token' });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'forbidden' });
	});

	it('access: 200 { configured: true } for the owner on a ready service', async () => {
		await serve(readyService());
		const res = await get('/api/sutando/access', { Authorization: 'Bearer owner-token' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ configured: true });
	});

	it('access: 200 { configured: false } for the owner on a disabled-but-declared service', async () => {
		await serve(disabledService('raw_dir_missing'));
		const res = await get('/api/sutando/access', { Authorization: 'Bearer owner-token' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ configured: false });
	});

	it('access: 404 when the feature is not declared at all', async () => {
		await serve(disabledService('not_declared', false));
		const res = await get('/api/sutando/access', { Authorization: 'Bearer owner-token' });
		expect(res.status).toBe(404);
	});

	// --- /auth-config ------------------------------------------------------------

	it('auth-config: public Supabase config when declared, even while disabled', async () => {
		await serve(disabledService('raw_dir_missing'));
		const res = await get('/api/sutando/auth-config');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			supabase: { url: 'https://p.supabase.co', anonKey: 'anon' },
		});
	});

	it('auth-config: auth_unavailable when declared without a usable gate', async () => {
		await serve(disabledService('supabase_not_configured', false), null);
		const res = await get('/api/sutando/auth-config');
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: 'auth_unavailable' });
	});

	// --- /presence ---------------------------------------------------------------

	it('presence: projection only — validated inflight, never the raw heartbeat', async () => {
		await serve(readyService({ inflight: 3, secrets: 'never-this' }));
		const res = await get('/api/sutando/presence', { Authorization: 'Bearer owner-token' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ fresh: true, lastHeartbeatAt: 123, inflight: 3 });
	});

	it.each([
		['malformed (string)', 'garbage'],
		['malformed (negative)', { inflight: -1 }],
		['malformed (float)', { inflight: 1.5 }],
		['oversized', { inflight: 1_000_000 }],
		['missing', {}],
		['null heartbeat (stale)', null],
	])('presence: %s heartbeat omits inflight but stays honest', async (_name, heartbeat) => {
		await serve(readyService(heartbeat));
		const res = await get('/api/sutando/presence', { Authorization: 'Bearer owner-token' });
		const body = await res.json();
		expect(body.inflight).toBeUndefined();
		expect(body.fresh).toBe(true);
	});

	it('presence: 503 not_configured when disabled; 401/403 gates still apply first', async () => {
		await serve(disabledService('raw_dir_missing'));
		expect((await get('/api/sutando/presence')).status).toBe(401);
		expect(
			(await get('/api/sutando/presence', { Authorization: 'Bearer other-token' })).status,
		).toBe(403);
		expect(
			(await get('/api/sutando/presence', { Authorization: 'Bearer owner-token' })).status,
		).toBe(503);
	});

	// --- /ws-ticket ----------------------------------------------------------------

	it('ws-ticket: issues an origin-bound ticket for the owner from an allowlisted origin', async () => {
		const store = await serve(readyService());
		const res = await post('/api/sutando/ws-ticket', {
			Authorization: 'Bearer owner-token',
			Origin: ORIGIN,
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(typeof body.ticket).toBe('string');
		expect(store.consume(body.ticket, 'sutando')).toEqual({
			ownerUserId: 'owner-1',
			origin: ORIGIN,
		});
	});

	it.each([
		['missing origin', {}],
		['foreign origin', { Origin: 'https://evil.example.com' }],
		['malformed origin', { Origin: 'not-a-url' }],
	])('ws-ticket: %s → 403 origin_not_allowed', async (_name, extra) => {
		await serve(readyService());
		const res = await post('/api/sutando/ws-ticket', {
			Authorization: 'Bearer owner-token',
			...(extra as Record<string, string>),
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
	});

	it('ws-ticket: 503 when the service is disabled', async () => {
		await serve(disabledService('raw_dir_missing'));
		const res = await post('/api/sutando/ws-ticket', {
			Authorization: 'Bearer owner-token',
			Origin: ORIGIN,
		});
		expect(res.status).toBe(503);
	});
});

describe('SutandoTicketStore', () => {
	it('consume is single-use: a concurrent replay observes a miss', () => {
		const store = new SutandoTicketStore();
		const { ticket } = store.issue({ ownerUserId: 'owner-1', origin: ORIGIN });
		const first = store.consume(ticket, 'sutando');
		const second = store.consume(ticket, 'sutando');
		expect(first).toEqual({ ownerUserId: 'owner-1', origin: ORIGIN });
		expect(second).toBeNull();
	});

	it('expired tickets do not consume, and issuing prunes them', () => {
		let t = 1_000_000;
		const store = new SutandoTicketStore({ ttlMs: 60_000, now: () => t });
		const { ticket } = store.issue({ ownerUserId: 'owner-1', origin: ORIGIN });
		t += 61_000;
		expect(store.consume(ticket, 'sutando')).toBeNull();
		store.issue({ ownerUserId: 'owner-1', origin: ORIGIN }); // triggers prune
		expect(store.size).toBe(1);
	});

	it('profile mismatch never consumes successfully', () => {
		const store = new SutandoTicketStore();
		const { ticket } = store.issue({ ownerUserId: 'owner-1', origin: ORIGIN });
		expect(store.consume(ticket, 'some_other_profile')).toBeNull();
		// And it burned the ticket rather than leaving it replayable.
		expect(store.consume(ticket, 'sutando')).toBeNull();
	});

	it('clamps out-of-range constructor options back into the design bounds', () => {
		let t = 1_000_000;
		const store = new SutandoTicketStore({ ttlMs: 3_600_000, now: () => t }); // way past 60s
		const { ticket, expiresInMs } = store.issue({ ownerUserId: 'owner-1', origin: ORIGIN });
		expect(expiresInMs).toBe(60_000); // clamped
		t += 61_000;
		expect(store.consume(ticket, 'sutando')).toBeNull();
		store.stop();
	});

	it('the periodic sweep prunes an idle store', async () => {
		let t = 1_000_000;
		const store = new SutandoTicketStore({ ttlMs: 20, now: () => t });
		store.issue({ ownerUserId: 'owner-1', origin: ORIGIN });
		t += 30_000;
		await new Promise((r) => setTimeout(r, 60)); // let the interval fire
		expect(store.size).toBe(0);
		store.stop();
	});

	it('per-owner cap evicts oldest on overflow', () => {
		let t = 1_000_000;
		const store = new SutandoTicketStore({ perOwnerCap: 3, now: () => t });
		const tickets: string[] = [];
		for (let i = 0; i < 4; i++) {
			t += 1;
			tickets.push(store.issue({ ownerUserId: 'owner-1', origin: ORIGIN }).ticket);
		}
		expect(store.size).toBe(3);
		expect(store.consume(tickets[0], 'sutando')).toBeNull(); // oldest evicted
		expect(store.consume(tickets[3], 'sutando')).not.toBeNull();
	});
});
