import { afterEach, describe, expect, it } from 'vitest';
import {
	StaleTaskError,
	SutandoRelayServer,
	type SutandoTaskFields,
} from '../lib/sutando-relay-server.js';

// ---------------------------------------------------------------------------
// Scripted fake bridge — drives the relay exactly like remote-gateway-bridge.py
// ---------------------------------------------------------------------------

const TOKEN = 'test-token';

function fields(id: string, task = 'do something'): SutandoTaskFields {
	return {
		id,
		timestamp: new Date().toISOString(),
		task,
		source: 'bodhi',
		channel_id: 'bodhi-test',
		user_id: 'tester',
		priority: 'normal',
		interaction_type: 'message',
	};
}

class FakeBridge {
	constructor(
		private readonly baseUrl: string,
		private readonly token: string = TOKEN,
	) {}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
	}

	async poll(waitSec = 0): Promise<{ status: number; tasks: SutandoTaskFields[] }> {
		const res = await fetch(`${this.baseUrl}/v1/tasks?wait=${waitSec}`, {
			headers: this.headers(),
		});
		const body = (await res.json()) as { tasks?: SutandoTaskFields[] };
		return { status: res.status, tasks: body.tasks ?? [] };
	}

	async ack(id: string): Promise<number> {
		const res = await fetch(`${this.baseUrl}/v1/tasks/${encodeURIComponent(id)}/ack`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ id }),
		});
		return res.status;
	}

	async result(id: string, body: string): Promise<number> {
		const res = await fetch(`${this.baseUrl}/v1/results`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ id, body }),
		});
		return res.status;
	}

	async heartbeat(payload: Record<string, unknown> = {}): Promise<number> {
		const res = await fetch(`${this.baseUrl}/v1/heartbeat`, {
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ client: 'fake-bridge', ...payload }),
		});
		return res.status;
	}
}

// ---------------------------------------------------------------------------

let servers: SutandoRelayServer[] = [];

async function startRelay(
	overrides: Partial<ConstructorParameters<typeof SutandoRelayServer>[0]> = {},
): Promise<{ relay: SutandoRelayServer; bridge: FakeBridge }> {
	const relay = new SutandoRelayServer({
		token: TOKEN,
		port: 0,
		leaseTimeoutMs: 150,
		sweepIntervalMs: 25,
		longPollCapMs: 2_000,
		...overrides,
	});
	await relay.start();
	servers.push(relay);
	return { relay, bridge: new FakeBridge(relay.url) };
}

afterEach(async () => {
	for (const server of servers) await server.stop();
	servers = [];
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests — the contract list from design doc M1 step 3
// ---------------------------------------------------------------------------

describe('SutandoRelayServer contract', () => {
	it('rejects unauthenticated calls', async () => {
		const { relay } = await startRelay();
		const res = await fetch(`${relay.url}/v1/tasks?wait=0`);
		expect(res.status).toBe(401);
	});

	it('long-poll delivers a submitted task and ack + result complete the round trip', async () => {
		const { relay, bridge } = await startRelay();
		const resultPromise = relay.submit(fields('task-bodhi-a-1'));

		const { tasks } = await bridge.poll(1);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].id).toBe('task-bodhi-a-1');
		expect(relay.taskState('task-bodhi-a-1')).toBe('leased');

		expect(await bridge.ack('task-bodhi-a-1')).toBe(200);
		expect(relay.taskState('task-bodhi-a-1')).toBe('acked');

		expect(await bridge.result('task-bodhi-a-1', 'all done')).toBe(200);
		await expect(resultPromise).resolves.toBe('all done');
		expect(relay.taskState('task-bodhi-a-1')).toBe('completed');
	});

	it('parked long-poll wakes when a task is submitted', async () => {
		const { relay, bridge } = await startRelay();
		const pollPromise = bridge.poll(2);
		await sleep(50);
		void relay.submit(fields('task-bodhi-a-2')).catch(() => {});
		const { tasks } = await pollPromise;
		expect(tasks.map((t) => t.id)).toEqual(['task-bodhi-a-2']);
	});

	it('delivery without ack redelivers the same task ID after the lease timeout', async () => {
		const { relay, bridge } = await startRelay();
		void relay.submit(fields('task-bodhi-a-3')).catch(() => {});

		const first = await bridge.poll(0);
		expect(first.tasks.map((t) => t.id)).toEqual(['task-bodhi-a-3']);
		// No ack — lease must expire and the task requeue.
		await sleep(300);
		expect(relay.taskState('task-bodhi-a-3')).toBe('queued');
		const second = await bridge.poll(0);
		expect(second.tasks.map((t) => t.id)).toEqual(['task-bodhi-a-3']);
	});

	it('acked tasks are never redelivered', async () => {
		const { relay, bridge } = await startRelay();
		void relay.submit(fields('task-bodhi-a-4')).catch(() => {});
		await bridge.poll(0);
		await bridge.ack('task-bodhi-a-4');
		await sleep(300);
		const again = await bridge.poll(0);
		expect(again.tasks).toHaveLength(0);
	});

	it('cancel after delivery before ack revokes the lease and never redelivers', async () => {
		const { relay, bridge } = await startRelay();
		const resultPromise = relay.submit(fields('task-bodhi-a-5'));
		await bridge.poll(0);
		expect(relay.taskState('task-bodhi-a-5')).toBe('leased');

		expect(relay.cancel('task-bodhi-a-5')).toBe('lease_revoked');
		await expect(resultPromise).rejects.toThrow(/cancelled while leased/);

		expect(await bridge.ack('task-bodhi-a-5')).toBe(410);
		expect(await bridge.result('task-bodhi-a-5', 'late')).toBe(410);
		await sleep(300);
		const again = await bridge.poll(0);
		expect(again.tasks).toHaveLength(0);
	});

	it('restart-while-leased equivalent: unknown or duplicate acks are rejected and logged', async () => {
		const { bridge } = await startRelay();
		expect(await bridge.ack('task-bodhi-never-submitted')).toBe(404);

		const { relay, bridge: bridge2 } = await startRelay();
		void relay.submit(fields('task-bodhi-a-6')).catch(() => {});
		await bridge2.poll(0);
		expect(await bridge2.ack('task-bodhi-a-6')).toBe(200);
		expect(await bridge2.ack('task-bodhi-a-6')).toBe(409);
	});

	it('result before ack is rejected', async () => {
		const { relay, bridge } = await startRelay();
		void relay.submit(fields('task-bodhi-a-7')).catch(() => {});
		await bridge.poll(0);
		expect(await bridge.result('task-bodhi-a-7', 'too early')).toBe(409);
	});

	it('unknown-ID result is rejected and logged', async () => {
		const logs: string[] = [];
		const { bridge } = await startRelay({ log: (line) => logs.push(line) });
		expect(await bridge.result('task-bodhi-forged', 'forged')).toBe(404);
		expect(logs.some((l) => l.includes('unknown id task-bodhi-forged'))).toBe(true);
	});

	it('expired undelivered task is dropped with a stale-task error', async () => {
		const { relay, bridge } = await startRelay();
		const resultPromise = relay.submit(fields('task-bodhi-a-8'), { ttlMs: 60 });
		await expect(resultPromise).rejects.toBeInstanceOf(StaleTaskError);
		expect(relay.taskState('task-bodhi-a-8')).toBe('expired');
		const { tasks } = await bridge.poll(0);
		expect(tasks).toHaveLength(0);
	});

	it('duplicate submission is a no-op rejection', async () => {
		const { relay } = await startRelay();
		void relay.submit(fields('task-bodhi-a-9')).catch(() => {});
		await expect(relay.submit(fields('task-bodhi-a-9'))).rejects.toThrow(/duplicate task id/);
	});

	it('late result after the waiter is released goes to the orphan log, not a conversation', async () => {
		const { relay, bridge } = await startRelay();
		const resultPromise = relay.submit(fields('task-bodhi-a-10'));
		await bridge.poll(0);
		await bridge.ack('task-bodhi-a-10');

		expect(relay.cancel('task-bodhi-a-10')).toBe('orphaned');
		await expect(resultPromise).rejects.toThrow(/abandoned/);

		expect(await bridge.result('task-bodhi-a-10', 'finished anyway')).toBe(200);
		expect(relay.orphanLog.map((o) => o.id)).toContain('task-bodhi-a-10');
	});

	it('heartbeat drives presence freshness', async () => {
		const { relay, bridge } = await startRelay({ freshnessMs: 120 });
		expect(relay.presence().fresh).toBe(false);
		expect(await bridge.heartbeat({ inflight: 0 })).toBe(200);
		expect(relay.presence().fresh).toBe(true);
		await sleep(200);
		expect(relay.presence().fresh).toBe(false);
	});

	it('non-loopback bind without the topology flag refuses to start', async () => {
		const relay = new SutandoRelayServer({ token: TOKEN, port: 0, host: '0.0.0.0' });
		await expect(relay.start()).rejects.toThrow(/refuses non-loopback bind/);
	});

	it('non-loopback bind starts with the explicit topology flag', async () => {
		const relay = new SutandoRelayServer({
			token: TOKEN,
			port: 0,
			host: '0.0.0.0',
			allowNonLoopbackBind: true,
		});
		await expect(relay.start()).resolves.toBeGreaterThan(0);
		await relay.stop();
	});
});
