/**
 * M2 restart recovery + ack commit point + reaper — the design doc's
 * verify cases (a), (b), (c) plus the ack-write-failure contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SutandoRelayServer, type SutandoTaskFields } from '../lib/sutando-relay-server.js';
import { SutandoTaskLedger } from '../lib/sutando-task-ledger.js';

const TOKEN = 'test-token';

let servers: SutandoRelayServer[] = [];
let dirs: string[] = [];

function ledgerDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'sutando-recovery-'));
	dirs.push(dir);
	return dir;
}

async function startRelay(
	dir: string,
	overrides: Partial<ConstructorParameters<typeof SutandoRelayServer>[0]> = {},
): Promise<SutandoRelayServer> {
	const relay = new SutandoRelayServer({
		token: TOKEN,
		port: 0,
		leaseTimeoutMs: 150,
		sweepIntervalMs: 25,
		ledger: new SutandoTaskLedger({ dir }),
		...overrides,
	});
	await relay.start();
	servers.push(relay);
	return relay;
}

afterEach(async () => {
	for (const server of servers) await server.stop();
	servers = [];
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function fields(id: string, task = 'do something'): SutandoTaskFields {
	return {
		id,
		timestamp: new Date().toISOString(),
		task,
		source: 'bodhi',
		channel_id: 'bodhi-aaaa',
		user_id: 'tester',
		priority: 'normal',
		interaction_type: 'message',
	};
}

function headers(): Record<string, string> {
	return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

async function poll(relay: SutandoRelayServer): Promise<SutandoTaskFields[]> {
	const res = await fetch(`${relay.url}/v1/tasks?wait=0`, { headers: headers() });
	return ((await res.json()) as { tasks: SutandoTaskFields[] }).tasks;
}

async function ack(relay: SutandoRelayServer, id: string): Promise<number> {
	const res = await fetch(`${relay.url}/v1/tasks/${id}/ack`, {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify({ id }),
	});
	return res.status;
}

async function postResult(relay: SutandoRelayServer, id: string, body: string): Promise<number> {
	const res = await fetch(`${relay.url}/v1/results`, {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify({ id, body }),
	});
	return res.status;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('M2 restart recovery', () => {
	it('(a) killed between delivery and result: the late result is accepted and orphan-logged as unclaimed_after_restart', async () => {
		const dir = ledgerDir();
		const relay1 = await startRelay(dir);
		relay1
			.submit(fields('task-bodhi-aaaa-1', 'send report'), { nonce: 'aaaa', desc: 'send report' })
			.catch(() => {});
		await poll(relay1);
		expect(await ack(relay1, 'task-bodhi-aaaa-1')).toBe(200);
		await relay1.stop(); // "crash" — all in-memory state gone; only the ledger survives

		const relay2 = await startRelay(dir);
		expect(await postResult(relay2, 'task-bodhi-aaaa-1', 'finished on the Mac')).toBe(200);
		expect(relay2.orphanLog).toHaveLength(1);
		expect(relay2.orphanLog[0]).toMatchObject({
			id: 'task-bodhi-aaaa-1',
			reason: 'unclaimed_after_restart',
		});
	});

	it('(b) submitted-but-undelivered: post-restart result rejected; reaper emits the dropped-before-delivery notice; no auto-resubmission', async () => {
		const dir = ledgerDir();
		const relay1 = await startRelay(dir);
		relay1
			.submit(fields('task-bodhi-aaaa-2', 'never delivered'), {
				nonce: 'aaaa',
				desc: 'never delivered',
			})
			.catch(() => {});
		await relay1.stop(); // crash before any poll

		const relay2 = await startRelay(dir);
		// Forged/late result for a never-delivered ID: rejected (§5 invariant).
		expect(await postResult(relay2, 'task-bodhi-aaaa-2', 'forged')).toBe(404);
		// Nothing was resubmitted — the relay has no such live task.
		expect(relay2.taskState('task-bodhi-aaaa-2')).toBeUndefined();
		// The reaper surfaces the bounded re-ask notice.
		relay2.reapNow();
		const notices = relay2.drainRecoveryNotices();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ id: 'task-bodhi-aaaa-2', kind: 'dropped_before_delivery' });
		// Drained = consumed: it never fires again.
		relay2.reapNow();
		expect(relay2.drainRecoveryNotices()).toHaveLength(0);
	});

	it('(c) cancelled before the restart: the late result is orphan-classified, log-only, never notice-eligible', async () => {
		const dir = ledgerDir();
		const relay1 = await startRelay(dir);
		relay1
			.submit(fields('task-bodhi-aaaa-3', 'goodbye race'), { nonce: 'aaaa', desc: 'goodbye race' })
			.catch(() => {});
		await poll(relay1);
		expect(await ack(relay1, 'task-bodhi-aaaa-3')).toBe(200);
		expect(relay1.cancel('task-bodhi-aaaa-3', 'session_closed')).toBe('orphaned');
		await relay1.stop();

		const relay2 = await startRelay(dir);
		expect(await postResult(relay2, 'task-bodhi-aaaa-3', 'finished anyway')).toBe(200);
		expect(relay2.orphanLog[0]).toMatchObject({
			id: 'task-bodhi-aaaa-3',
			reason: 'orphaned_after_session_closed',
		});
		relay2.reapNow();
		expect(relay2.drainRecoveryNotices()).toHaveLength(0); // never spoken
	});

	it('ack commit point: a failing ledger write rejects the ack and the lease expires into redelivery', async () => {
		const dir = ledgerDir();
		const ledger = new SutandoTaskLedger({ dir });
		let failAcks = true;
		const originalAppend = ledger.append.bind(ledger);
		ledger.append = (entry) => {
			if (failAcks && entry.state === 'acked') throw new Error('disk full');
			originalAppend(entry);
		};
		const relay = new SutandoRelayServer({
			token: TOKEN,
			port: 0,
			leaseTimeoutMs: 120,
			sweepIntervalMs: 25,
			ledger,
		});
		await relay.start();
		servers.push(relay);

		relay.submit(fields('task-bodhi-aaaa-4'), { nonce: 'aaaa', desc: 'x' }).catch(() => {});
		await poll(relay);
		expect(await ack(relay, 'task-bodhi-aaaa-4')).toBe(500); // rejected — not durably recorded
		expect(relay.taskState('task-bodhi-aaaa-4')).toBe('leased');

		await sleep(250); // lease expires → redelivery
		failAcks = false;
		const redelivered = await poll(relay);
		expect(redelivered.map((t) => t.id)).toEqual(['task-bodhi-aaaa-4']);
		expect(await ack(relay, 'task-bodhi-aaaa-4')).toBe(200); // durable this time
		expect(relay.taskState('task-bodhi-aaaa-4')).toBe('acked');
	});

	it('acceptance is once-only: a duplicate recovered result is rejected after the first claim', async () => {
		const dir = ledgerDir();
		const relay1 = await startRelay(dir);
		relay1.submit(fields('task-bodhi-aaaa-5'), { nonce: 'aaaa', desc: 'x' }).catch(() => {});
		await poll(relay1);
		await ack(relay1, 'task-bodhi-aaaa-5');
		await relay1.stop();

		const relay2 = await startRelay(dir);
		expect(await postResult(relay2, 'task-bodhi-aaaa-5', 'first')).toBe(200);
		expect(await postResult(relay2, 'task-bodhi-aaaa-5', 'second')).toBe(404);
		expect(relay2.orphanLog).toHaveLength(1);
	});
});
