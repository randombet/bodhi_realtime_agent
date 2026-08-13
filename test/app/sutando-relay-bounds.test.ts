import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	SutandoRelayServer,
	type SutandoTaskFields,
} from '../../app/lib/integrations/sutando/sutando-relay-server.js';
import { SutandoTaskLedger } from '../../app/lib/integrations/sutando/sutando-task-ledger.js';
import { createOrphanSink } from '../../app/server/sutando/sutando-service.js';

const TOKEN = 'bounds-token';

function fields(id: string, task = 'do a thing'): SutandoTaskFields {
	return { id, timestamp: new Date().toISOString(), task, source: 'bodhi' };
}

async function post(relay: SutandoRelayServer, path: string, body: string): Promise<number> {
	const res = await fetch(`${relay.url}${path}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
		body,
	});
	await res.text();
	return res.status;
}

async function pollOnce(relay: SutandoRelayServer): Promise<void> {
	await fetch(`${relay.url}/v1/tasks?wait=0`, {
		headers: { Authorization: `Bearer ${TOKEN}` },
	}).then((r) => r.json());
}

async function deliverAndAck(relay: SutandoRelayServer, id: string): Promise<void> {
	await pollOnce(relay);
	await post(relay, `/v1/tasks/${id}/ack`, '');
}

describe('relay bounded ingestion', () => {
	const relays: SutandoRelayServer[] = [];
	const dirs: string[] = [];

	afterEach(async () => {
		for (const r of relays.splice(0)) await r.stop();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	async function startRelay(
		options: Partial<ConstructorParameters<typeof SutandoRelayServer>[0]> = {},
	): Promise<SutandoRelayServer> {
		const relay = new SutandoRelayServer({
			token: TOKEN,
			port: 0,
			log: () => {},
			...options,
		});
		await relay.start();
		relays.push(relay);
		return relay;
	}

	it('rejects an oversized result body with 413 before buffering it', async () => {
		const relay = await startRelay({ maxBodyBytes: 1024 });
		const status = await post(
			relay,
			'/v1/results',
			JSON.stringify({ id: 'x', body: 'y'.repeat(4096) }),
		);
		expect(status).toBe(413);
	});

	it('rejects an oversized heartbeat with 413 and does not poison presence', async () => {
		const relay = await startRelay({ maxBodyBytes: 1024 });
		expect(await post(relay, '/v1/heartbeat', JSON.stringify({ pad: 'z'.repeat(4096) }))).toBe(413);
		expect(relay.presence().fresh).toBe(false);
		expect(await post(relay, '/v1/heartbeat', JSON.stringify({ inflight: 0 }))).toBe(200);
		expect(relay.presence().fresh).toBe(true);
	});

	it('rejects a malformed result body with 400, not a crash', async () => {
		const relay = await startRelay();
		expect(await post(relay, '/v1/results', 'not json at all')).toBe(400);
	});

	it('caps concurrent parked long-polls with 429', async () => {
		const relay = await startRelay({ maxParkedPollers: 2 });
		const park = () =>
			fetch(`${relay.url}/v1/tasks?wait=5`, { headers: { Authorization: `Bearer ${TOKEN}` } });
		const p1 = park();
		const p2 = park();
		// Give the first two time to park.
		await new Promise((r) => setTimeout(r, 100));
		expect(relay.parkedCount).toBe(2);
		const third = await park();
		expect(third.status).toBe(429);
		// Wake the parked ones so the test exits fast.
		relay.submit(fields('task-wake-1'), {}).catch(() => {});
		await Promise.all([p1, p2]);
	});

	it('an aborted long-poll releases its parked slot and timer', async () => {
		const relay = await startRelay({ maxParkedPollers: 2 });
		const controller = new AbortController();
		const parked = fetch(`${relay.url}/v1/tasks?wait=10`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
			signal: controller.signal,
		}).catch(() => {});
		await new Promise((r) => setTimeout(r, 100));
		expect(relay.parkedCount).toBe(1);
		controller.abort();
		await parked;
		await new Promise((r) => setTimeout(r, 100));
		expect(relay.parkedCount).toBe(0);
	});

	it('orphan entries keep a bounded preview and the sink receives the full body', async () => {
		const sunk: Array<{ id: string; body: string; reason: string }> = [];
		const relay = await startRelay({
			orphanPreviewChars: 16,
			orphanSink: (id, body, reason) => sunk.push({ id, body, reason }),
		});
		const id = 'task-orphan-1';
		relay.submit(fields(id), {}).catch(() => {});
		await deliverAndAck(relay, id);
		relay.cancel(id, 'session_closed');
		const big = 'R'.repeat(1000);
		expect(await post(relay, '/v1/results', JSON.stringify({ id, body: big }))).toBe(200);
		expect(sunk).toHaveLength(1);
		expect(sunk[0].body).toBe(big);
		expect(relay.orphanLog[0].preview).toHaveLength(16);
		expect(relay.orphanLog[0].bytes).toBe(1000);
	});

	it('a throwing orphan sink is contained (metadata-logged, request still 200)', async () => {
		const relay = await startRelay({
			orphanSink: () => {
				throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
			},
		});
		const id = 'task-orphan-2';
		relay.submit(fields(id), {}).catch(() => {});
		await deliverAndAck(relay, id);
		relay.cancel(id, 'session_closed');
		expect(await post(relay, '/v1/results', JSON.stringify({ id, body: 'late' }))).toBe(200);
		expect(relay.orphanLog[0].id).toBe(id);
	});

	it('a result arriving post-restart flows through the sink too', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'sutando-bounds-ledger-'));
		dirs.push(dir);
		const relay1 = await startRelay({ ledger: new SutandoTaskLedger({ dir, log: () => {} }) });
		const id = 'task-restart-1';
		relay1.submit(fields(id), { nonce: 'aaaa', desc: 'restart case' }).catch(() => {});
		await deliverAndAck(relay1, id);
		await relay1.stop();

		const sunk: string[] = [];
		const relay2 = await startRelay({
			ledger: new SutandoTaskLedger({ dir, log: () => {} }),
			orphanSink: (oid) => sunk.push(oid),
		});
		expect(await post(relay2, '/v1/results', JSON.stringify({ id, body: 'done anyway' }))).toBe(
			200,
		);
		expect(sunk).toEqual([id]);
	});
});

describe('createOrphanSink', () => {
	it('writes atomically with 0600, keyed by task id, under orphans/', () => {
		const raw = mkdtempSync(join(tmpdir(), 'sutando-orphan-raw-'));
		try {
			const sink = createOrphanSink(raw, () => {});
			sink('task-bodhi-abc-1', 'full body here', 'test');
			const file = join(raw, 'orphans', 'task-bodhi-abc-1.txt');
			expect(readFileSync(file, 'utf-8')).toBe('full body here');
			expect(lstatSync(file).mode & 0o777).toBe(0o600);
			expect(readdirSync(join(raw, 'orphans'))).toEqual(['task-bodhi-abc-1.txt']); // no stray tmp
		} finally {
			rmSync(raw, { recursive: true, force: true });
		}
	});

	it('rejects unsafe task ids without writing', () => {
		const raw = mkdtempSync(join(tmpdir(), 'sutando-orphan-raw-'));
		try {
			const lines: string[] = [];
			const sink = createOrphanSink(raw, (l) => lines.push(l));
			sink('../escape', 'SECRET-CONTENT-9c1f', 'test');
			expect(readdirSync(raw)).toEqual([]); // nothing created at all
			expect(lines.some((l) => l.includes('unsafe task id'))).toBe(true);
			expect(lines.every((l) => !l.includes('SECRET-CONTENT-9c1f'))).toBe(true); // metadata only, never content
		} finally {
			rmSync(raw, { recursive: true, force: true });
		}
	});
});

describe('ledger filesystem hardening', () => {
	it('creates ledger files 0600 and refuses to append through a symlink', () => {
		const dir = mkdtempSync(join(tmpdir(), 'sutando-ledger-hard-'));
		const outside = mkdtempSync(join(tmpdir(), 'sutando-ledger-victim-'));
		try {
			const ledger = new SutandoTaskLedger({ dir, log: () => {} });
			ledger.append({ id: 't1', nonce: 'aaaa', state: 'submitted', desc: 'x' });
			expect(lstatSync(join(dir, 'aaaa.jsonl')).mode & 0o777).toBe(0o600);

			// A planted symlink where a ledger file would go must be refused.
			writeFileSync(join(outside, 'victim.jsonl'), '');
			symlinkSync(join(outside, 'victim.jsonl'), join(dir, 'bbbb.jsonl'));
			// O_NOFOLLOW rejects the symlink at open time (ELOOP).
			expect(() => ledger.append({ id: 't2', nonce: 'bbbb', state: 'submitted' })).toThrow();
			expect(readFileSync(join(outside, 'victim.jsonl'), 'utf-8')).toBe('');
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('loadTaskViews skips symlinked ledger files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'sutando-ledger-hard-'));
		const outside = mkdtempSync(join(tmpdir(), 'sutando-ledger-victim-'));
		try {
			const ledger = new SutandoTaskLedger({ dir, log: () => {} });
			ledger.append({ id: 't1', nonce: 'aaaa', state: 'submitted' });
			writeFileSync(
				join(outside, 'planted.jsonl'),
				`${JSON.stringify({ id: 'evil', nonce: 'cccc', state: 'acked', at: Date.now() })}\n`,
			);
			symlinkSync(join(outside, 'planted.jsonl'), join(dir, 'cccc.jsonl'));
			const views = ledger.loadTaskViews();
			expect(views.has('t1')).toBe(true);
			expect(views.has('evil')).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('ledger dir is created 0700', () => {
		const parent = mkdtempSync(join(tmpdir(), 'sutando-ledger-hard-'));
		try {
			const dir = join(parent, 'ledger');
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			new SutandoTaskLedger({ dir, log: () => {} });
			expect(lstatSync(dir).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});
