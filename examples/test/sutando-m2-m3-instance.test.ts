/**
 * M2.4 CANCEL_INSTRUCTION wiring + M3 polish (digest compression,
 * presence-transition UX) — instance-level verification.
 */

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

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/** Mac stand-in that understands CANCEL_INSTRUCTION tasks. */
async function macSim(
	relay: SutandoRelayServer,
	respond: (task: SutandoTaskFields) => string | null,
	opts: { heartbeat?: boolean } = {},
) {
	let running = true;
	if (opts.heartbeat !== false) {
		await fetch(`${relay.url}/v1/heartbeat`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ client: 'mac-sim', inflight: 0 }),
		});
	}
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
// M2.4 — CANCEL_INSTRUCTION
// ---------------------------------------------------------------------------

describe('CANCEL_INSTRUCTION wiring (M2.4)', () => {
	it('honored: watchdog abandonment of delivered work submits an urgent cancel task and records the confirmation', async () => {
		const relay = await startRelay();
		const cancelsSeen: SutandoTaskFields[] = [];
		const mac = await macSim(relay, (task) => {
			if (task.task.startsWith('CANCEL_INSTRUCTION:')) {
				cancelsSeen.push(task);
				return `Cancelled ${task.task.split(' ')[1]} (was in progress)`;
			}
			return null; // the original task hangs forever
		});
		const instance = makeInstance(relay, { watchdogMs: 300 });

		await expect(instance.invoke('t', { task: 'will hang' })).rejects.toThrow(
			/did not return a result/,
		);
		await sleep(400); // let the cancel round-trip complete

		expect(cancelsSeen).toHaveLength(1);
		expect(cancelsSeen[0].task).toContain('CANCEL_INSTRUCTION: task-bodhi-abcd1234-1');
		expect(cancelsSeen[0].priority).toBe('urgent');
		expect(instance.cancelConfirmations).toHaveLength(1);
		expect(instance.cancelConfirmations[0]).toMatchObject({ id: 'task-bodhi-abcd1234-1' });
		expect(instance.cancelConfirmations[0].confirmation).toContain('Cancelled');
		await mac.stop();
	});

	it('raced-and-lost: the original result lands in the orphan log, never the conversation', async () => {
		const relay = await startRelay();
		let releaseOriginal: (() => void) | null = null;
		const originalDone = new Promise<void>((resolve) => {
			releaseOriginal = resolve;
		});
		const mac = await macSim(relay, (task) => {
			if (task.task.startsWith('CANCEL_INSTRUCTION:')) {
				// The Mac "already finished" the original — cancel arrives too late.
				releaseOriginal?.();
				return 'task already completed, nothing to cancel';
			}
			return null;
		});
		const instance = makeInstance(relay, { watchdogMs: 250 });

		await expect(instance.invoke('t', { task: 'finishes anyway' })).rejects.toThrow(
			/did not return a result/,
		);
		await originalDone;
		// The Mac posts the original result AFTER abandonment.
		const late = await fetch(`${relay.url}/v1/results`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ id: 'task-bodhi-abcd1234-1', body: 'late original result' }),
		});
		expect(late.status).toBe(200);
		expect(relay.orphanLog.some((o) => o.id === 'task-bodhi-abcd1234-1')).toBe(true);
		await mac.stop();
	});

	it('dispose of delivered work submits session_closed cancels', async () => {
		const relay = await startRelay();
		const cancelsSeen: string[] = [];
		const mac = await macSim(relay, (task) => {
			if (task.task.startsWith('CANCEL_INSTRUCTION:')) {
				cancelsSeen.push(task.task);
				return 'Cancelled';
			}
			return null;
		});
		const instance = makeInstance(relay);
		const p = instance.invoke('t', { task: 'in flight at goodbye' });
		await sleep(150); // delivered + acked by macSim, no result yet
		await instance.dispose();
		await expect(p).rejects.toThrow(/abandoned/);
		await sleep(300);
		expect(cancelsSeen).toHaveLength(1);
		expect(cancelsSeen[0]).toContain('task-bodhi-abcd1234-1');
		await mac.stop();
	});
});

// ---------------------------------------------------------------------------
// M3.1 — digest compression
// ---------------------------------------------------------------------------

describe('digest compression (M3.1)', () => {
	it('stays bounded across a 50-delegation session', async () => {
		const relay = await startRelay();
		const digestBlocks: string[] = [];
		const mac = await macSim(relay, (task) => {
			const block = task.task
				.split('\n\n')
				.find((p) => p.startsWith('Earlier in this conversation'));
			digestBlocks.push(block ?? '');
			return `A fairly long result about ${task.id} — ${'detail '.repeat(20)}`;
		});
		const instance = makeInstance(relay, { digestCharBudget: 700 });

		for (let i = 1; i <= 50; i++) {
			await instance.invoke('t', {
				task: `delegation number ${i} with a reasonably descriptive task body`,
			});
		}

		expect(digestBlocks).toHaveLength(50);
		for (const block of digestBlocks) {
			expect(block.length).toBeLessThanOrEqual(700);
		}
		// Late envelopes carry the compressed-summary header, not unbounded history.
		expect(digestBlocks[49]).toContain('summarized away');
		expect(digestBlocks[49]).toContain('delegation number');
		await mac.stop();
	});
});

// ---------------------------------------------------------------------------
// M3.2 — presence-transition UX
// ---------------------------------------------------------------------------

describe('presence-transition UX (M3.2)', () => {
	it('offline→online with queued work produces exactly one notice', async () => {
		const relay = await startRelay({ freshnessMs: 60_000 });
		const notices: string[] = [];
		const instance = makeInstance(relay, {
			hooks: { notifySystem: (text) => notices.push(text) },
		});

		// Submit while offline: one offline notice fires immediately.
		const p = instance.invoke('t', { task: 'queued while offline' });
		await sleep(50);
		expect(notices.filter((n) => n.includes('offline'))).toHaveLength(1);

		// Mac comes online (first heartbeat) and completes the task.
		const mac = await macSim(relay, () => 'done after reconnect');
		await expect(p).resolves.toContain('done after reconnect');

		const backOnline = notices.filter((n) => n.includes('came back online'));
		expect(backOnline).toHaveLength(1);

		// Further heartbeats are NOT transitions — no more notices.
		await fetch(`${relay.url}/v1/heartbeat`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ client: 'mac-sim' }),
		});
		await sleep(50);
		expect(notices.filter((n) => n.includes('came back online'))).toHaveLength(1);
		await mac.stop();
	});

	it('a Mac that was always online never triggers the notice', async () => {
		const relay = await startRelay();
		const notices: string[] = [];
		const mac = await macSim(relay, () => 'ok');
		const instance = makeInstance(relay, {
			hooks: { notifySystem: (text) => notices.push(text) },
		});
		await instance.invoke('t', { task: 'normal delegation' });
		expect(notices).toHaveLength(0);
		await mac.stop();
	});
});
