/**
 * M3.3 concurrent-session hardening: two voice sessions sharing one relay
 * preserve FIFO-within-session (including through lease/redeliver), keep
 * distinct task-ID namespaces and channel keys, and carry the priority
 * headers Sutando's core uses for cross-channel ordering.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SutandoRelayServer, type SutandoTaskFields } from '../lib/sutando-relay-server.js';
import { SutandoSubagentInstance } from '../lib/sutando-subagent-instance.js';

const TOKEN = 'test-token';
const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

let servers: SutandoRelayServer[] = [];

afterEach(async () => {
	for (const server of servers) await server.stop();
	servers = [];
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startRelay(
	overrides: Partial<ConstructorParameters<typeof SutandoRelayServer>[0]> = {},
): Promise<SutandoRelayServer> {
	const relay = new SutandoRelayServer({
		token: TOKEN,
		port: 0,
		leaseTimeoutMs: 200,
		sweepIntervalMs: 25,
		longPollCapMs: 2_000,
		...overrides,
	});
	await relay.start();
	servers.push(relay);
	return relay;
}

async function macSim(relay: SutandoRelayServer, seen: SutandoTaskFields[], ackEvery = true) {
	let running = true;
	await fetch(`${relay.url}/v1/heartbeat`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ client: 'mac-sim' }),
	});
	const loop = (async () => {
		while (running) {
			try {
				const res = await fetch(`${relay.url}/v1/tasks?wait=1`, { headers });
				const { tasks } = (await res.json()) as { tasks: SutandoTaskFields[] };
				for (const task of tasks) {
					seen.push(task);
					if (!ackEvery) continue;
					await fetch(`${relay.url}/v1/tasks/${task.id}/ack`, {
						method: 'POST',
						headers,
						body: JSON.stringify({ id: task.id }),
					});
					await fetch(`${relay.url}/v1/results`, {
						method: 'POST',
						headers,
						body: JSON.stringify({ id: task.id, body: `done ${task.id}` }),
					});
				}
			} catch {
				return;
			}
		}
	})();
	return {
		stop: async () => {
			running = false;
			await loop.catch(() => {});
		},
	};
}

describe('concurrent sessions (M3.3)', () => {
	it('two sessions: per-session FIFO holds, namespaces and channel keys stay distinct, priority headers present', async () => {
		// Generous lease: under full-suite load a poll→ack round-trip can exceed
		// a short lease, and the relay's (correct) at-least-once redelivery would
		// make the sim record a duplicate first delivery. Redelivery ordering has
		// its own dedicated test below.
		const relay = await startRelay({ leaseTimeoutMs: 10_000 });
		const seen: SutandoTaskFields[] = [];
		const mac = await macSim(relay, seen);

		const sessionA = new SutandoSubagentInstance('ask_sutando', {
			relay,
			sessionId: 's-a',
			nonce: 'aaaa1111',
		});
		const sessionB = new SutandoSubagentInstance('ask_sutando', {
			relay,
			sessionId: 's-b',
			nonce: 'bbbb2222',
			priority: 'normal',
		});

		const results = await Promise.all([
			sessionA.invoke('t', { task: 'A first' }),
			sessionA.invoke('t', { task: 'A second' }),
			sessionB.invoke('t', { task: 'B first' }),
			sessionB.invoke('t', { task: 'B second' }),
		]);
		expect(results.every((r) => r.startsWith('done'))).toBe(true);

		const aOrder = seen.filter((t) => t.id.startsWith('task-bodhi-aaaa1111')).map((t) => t.id);
		const bOrder = seen.filter((t) => t.id.startsWith('task-bodhi-bbbb2222')).map((t) => t.id);
		expect(aOrder).toEqual(['task-bodhi-aaaa1111-1', 'task-bodhi-aaaa1111-2']);
		expect(bOrder).toEqual(['task-bodhi-bbbb2222-1', 'task-bodhi-bbbb2222-2']);

		// Distinct channel keys; priority header on every envelope (Sutando's
		// core orders cross-channel work by it — bodhi tasks slot as 'normal').
		for (const task of seen) {
			expect(task.priority).toBe('normal');
			expect(task.channel_id).toMatch(/^bodhi-(aaaa1111|bbbb2222)$/);
		}
		const aChannels = new Set(seen.filter((t) => t.id.includes('aaaa')).map((t) => t.channel_id));
		const bChannels = new Set(seen.filter((t) => t.id.includes('bbbb')).map((t) => t.channel_id));
		expect(aChannels).toEqual(new Set(['bodhi-aaaa1111']));
		expect(bChannels).toEqual(new Set(['bodhi-bbbb2222']));
		await mac.stop();
	});

	it('per-session order survives a lease/redeliver cycle', async () => {
		const relay = await startRelay();
		const instance = new SutandoSubagentInstance('ask_sutando', {
			relay,
			sessionId: 's-a',
			nonce: 'cccc3333',
			watchdogMs: 60_000,
		});
		// FIFO means the instance submits one at a time; queue two.
		const p1 = instance.invoke('t', { task: 'first' });
		const p2 = instance.invoke('t', { task: 'second' });

		// First poll leases task 1 but never acks → lease expires → requeue.
		await sleep(30);
		const first = await fetch(`${relay.url}/v1/tasks?wait=0`, { headers }).then(
			(r) => r.json() as Promise<{ tasks: SutandoTaskFields[] }>,
		);
		expect(first.tasks.map((t) => t.id)).toEqual(['task-bodhi-cccc3333-1']);
		await sleep(350); // lease (200ms) expires

		// A well-behaved bridge now gets task 1 again — order preserved.
		const seen: SutandoTaskFields[] = [];
		const mac = await macSim(relay, seen);
		await expect(p1).resolves.toContain('done');
		await expect(p2).resolves.toContain('done');
		expect(seen.map((t) => t.id)).toEqual(['task-bodhi-cccc3333-1', 'task-bodhi-cccc3333-2']);
		await mac.stop();
	});
});
