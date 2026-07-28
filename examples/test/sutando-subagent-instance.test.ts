import { afterEach, describe, expect, it } from 'vitest';
import { SutandoRelayServer, type SutandoTaskFields } from '../lib/sutando-relay-server.js';
import { SutandoSubagentInstance } from '../lib/sutando-subagent-instance.js';

const TOKEN = 'test-token';

let servers: SutandoRelayServer[] = [];

async function startRelay(
	overrides: Partial<ConstructorParameters<typeof SutandoRelayServer>[0]> = {},
): Promise<SutandoRelayServer> {
	const relay = new SutandoRelayServer({
		token: TOKEN,
		port: 0,
		leaseTimeoutMs: 500,
		sweepIntervalMs: 25,
		longPollCapMs: 2_000,
		...overrides,
	});
	await relay.start();
	servers.push(relay);
	return relay;
}

afterEach(async () => {
	for (const server of servers) await server.stop();
	servers = [];
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal Mac stand-in: poll → ack → respond via the HTTP contract.
 *  Resolves only after the first heartbeat landed, so presence is
 *  deterministically fresh before the test invokes. */
async function macSim(
	relay: SutandoRelayServer,
	respond: (task: SutandoTaskFields) => string | null,
) {
	const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
	let running = true;
	await fetch(`${relay.url}/v1/heartbeat`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ client: 'mac-sim', inflight: 0 }),
	});
	const loop = (async () => {
		while (running) {
			try {
				const res = await fetch(`${relay.url}/v1/tasks?wait=1`, { headers });
				const { tasks } = (await res.json()) as { tasks: SutandoTaskFields[] };
				for (const task of tasks) {
					await fetch(`${relay.url}/v1/tasks/${task.id}/ack`, {
						method: 'POST',
						headers,
						body: JSON.stringify({ id: task.id }),
					});
					const body = respond(task);
					if (body !== null) {
						await fetch(`${relay.url}/v1/results`, {
							method: 'POST',
							headers,
							body: JSON.stringify({ id: task.id, body }),
						});
					}
				}
			} catch {
				// Relay stopping mid-poll during teardown — exit quietly.
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

function makeInstance(
	relay: SutandoRelayServer,
	overrides: Partial<ConstructorParameters<typeof SutandoSubagentInstance>[1]> = {},
): SutandoSubagentInstance {
	return new SutandoSubagentInstance('ask_sutando', {
		relay,
		sessionId: 'session-1',
		nonce: 'abcd1234',
		watchdogMs: 60_000,
		...overrides,
	});
}

// ---------------------------------------------------------------------------

describe('SutandoSubagentInstance', () => {
	it('round-trips a delegation and returns a brief', async () => {
		const relay = await startRelay();
		const mac = await macSim(relay, () => 'Found 3 invoices. The latest is $847.23.');
		const instance = makeInstance(relay);

		const brief = await instance.invoke('check email', { task: 'find AWS invoices' });
		expect(brief).toContain('invoices');
		await mac.stop();
	});

	it('serializes invokes FIFO and includes the digest in later envelopes', async () => {
		const relay = await startRelay();
		const seen: string[] = [];
		const mac = await macSim(relay, (task) => {
			seen.push(task.task);
			return `done: ${task.id}`;
		});
		const instance = makeInstance(relay);

		const [a, b] = await Promise.all([
			instance.invoke('t', { task: 'first job' }),
			instance.invoke('t', { task: 'second job' }),
		]);
		expect(a).toContain('done');
		expect(b).toContain('done');
		expect(seen).toHaveLength(2);
		// FIFO: first job's envelope was submitted first.
		expect(seen[0]).toContain('first job');
		// Continuity: the second envelope carries the digest of the first.
		expect(seen[1]).toContain('Earlier in this conversation');
		expect(seen[1]).toContain('first job');
		// Session marker on every envelope.
		expect(seen[0]).toContain('[bodhi session abcd1234]');
		await mac.stop();
	});

	it('watchdog failure unblocks the FIFO queue', async () => {
		const relay = await startRelay();
		// Mac acks but never responds to the first task; responds to the second.
		let first = true;
		const mac = await macSim(relay, (task) => {
			if (first) {
				first = false;
				return null; // never respond
			}
			return `done: ${task.id}`;
		});
		const instance = makeInstance(relay, { watchdogMs: 300 });

		const p1 = instance.invoke('t', { task: 'will hang' });
		const p2 = instance.invoke('t', { task: 'will succeed' });
		await expect(p1).rejects.toThrow(/did not return a result/);
		await expect(p2).resolves.toContain('done');
		expect(instance.orphanedTaskIds).toHaveLength(1);
		await mac.stop();
	});

	it('abort before submission never submits', async () => {
		const relay = await startRelay();
		const controller = new AbortController();
		controller.abort();
		const instance = makeInstance(relay);
		await expect(instance.invoke('t', { task: 'x' }, controller.signal)).rejects.toThrow(
			/aborted before submission/,
		);
		expect(relay.taskState('task-bodhi-abcd1234-1')).toBeUndefined();
	});

	it('abort of an undelivered task removes it from the relay queue', async () => {
		const relay = await startRelay();
		const controller = new AbortController();
		const instance = makeInstance(relay);
		const p = instance.invoke('t', { task: 'cancel me' }, controller.signal);
		await sleep(30);
		expect(relay.taskState('task-bodhi-abcd1234-1')).toBe('queued');
		controller.abort();
		await expect(p).rejects.toThrow(/cancelled before delivery/);
		expect(relay.taskState('task-bodhi-abcd1234-1')).toBe('cancelled');
	});

	it('caps the brief and hands raw output to recordRaw only', async () => {
		const relay = await startRelay();
		const long = 'x'.repeat(5_000);
		const mac = await macSim(relay, () => long);
		const raws: Array<{ id: string; raw: string }> = [];
		const instance = makeInstance(relay, {
			briefMaxChars: 200,
			hooks: { recordRaw: (id, raw) => raws.push({ id, raw }) },
		});

		const brief = await instance.invoke('t', { task: 'long output' });
		expect(brief.length).toBeLessThan(300);
		expect(brief).toContain('full output archived');
		expect(raws).toHaveLength(1);
		expect(raws[0].raw).toBe(long);
		await mac.stop();
	});

	it('preserves the [needs-input] marker at the front of the brief', async () => {
		const relay = await startRelay();
		const mac = await macSim(relay, () => '[needs-input] Which of the three drafts should I send?');
		const instance = makeInstance(relay);

		const brief = await instance.invoke('t', { task: 'send the draft' });
		expect(brief.startsWith('[needs-input]')).toBe(true);
		expect(brief).toContain('Which of the three drafts');
		await mac.stop();
	});

	it('emits the offline notice through notifySystem when the Mac is stale', async () => {
		const relay = await startRelay({ freshnessMs: 50 });
		const notices: string[] = [];
		const instance = makeInstance(relay, {
			watchdogMs: 500,
			taskTtlMs: 400,
			hooks: { notifySystem: (text) => notices.push(text) },
		});

		// No heartbeat has ever arrived → Mac is stale → notice fires, task queues,
		// then expires (nothing ever picks it up) with the stale-failure brief.
		const p = instance.invoke('t', { task: 'while offline' });
		await sleep(30);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('offline');
		await expect(p).rejects.toThrow(/expired before the user's Mac came back online/);
	});

	it('throws on invoke after dispose', async () => {
		const relay = await startRelay();
		const instance = makeInstance(relay);
		await instance.dispose();
		await expect(instance.invoke('t', { task: 'x' })).rejects.toThrow(/disposed/);
	});

	it('dispose cancels outstanding undelivered tasks', async () => {
		const relay = await startRelay();
		const instance = makeInstance(relay);
		const p = instance.invoke('t', { task: 'never picked up' });
		await sleep(30);
		await instance.dispose();
		await expect(p).rejects.toThrow(/cancelled before delivery/);
		expect(relay.taskState('task-bodhi-abcd1234-1')).toBe('cancelled');
	});
});
