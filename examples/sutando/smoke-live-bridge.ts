/**
 * Live-bridge smoke test (design doc M1 step 4).
 *
 * Runs the REAL Sutando bridge client (ag2_sparrow.remote_gateway_bridge from
 * the sutando checkout) against SutandoRelayServer, with the bridge's task /
 * result / state dirs pointed at a temp workspace so the live Sutando install
 * is never touched. A tiny "core sim" plays the Claude Code core: it watches
 * the temp tasks/ dir and writes a result file for each task.
 *
 * Verifies: heartbeats arrive (presence goes fresh); a hand-enqueued task is
 * delivered + acked by the bridge, "executes", and its result POST resolves
 * the relay's pending map.
 *
 * Usage:
 *   SUTANDO_REPO=/path/to/sutando pnpm tsx examples/sutando/smoke-live-bridge.ts
 * (SUTANDO_REPO defaults to ../sutando relative to this repo.)
 */

import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SutandoRelayServer } from '../lib/sutando-relay-server.js';

const TOKEN = 'smoke-test-token';

function log(msg: string): void {
	console.log(`[smoke] ${msg}`);
}

function fail(msg: string): never {
	console.error(`[smoke] FAIL: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const repoRoot = resolve(import.meta.dirname ?? '.', '../..');
	const sutandoRepo = process.env.SUTANDO_REPO ?? resolve(repoRoot, '../sutando');
	const pkgRoot = join(sutandoRepo, 'packages', 'ag2-sparrow');
	if (!existsSync(join(pkgRoot, 'ag2_sparrow', 'remote_gateway_bridge.py'))) {
		fail(`cannot find ag2_sparrow under ${pkgRoot} — set SUTANDO_REPO`);
	}

	const workspace = mkdtempSync(join(tmpdir(), 'sutando-smoke-'));
	const tasksDir = join(workspace, 'tasks');
	const resultsDir = join(workspace, 'results');
	const stateDir = join(workspace, 'state');
	for (const dir of [tasksDir, resultsDir, stateDir]) mkdirSync(dir, { recursive: true });
	log(`temp workspace: ${workspace}`);

	const relay = new SutandoRelayServer({
		token: TOKEN,
		port: 0,
		freshnessMs: 90_000,
		log: (line) => log(`relay: ${line}`),
	});
	await relay.start();

	// Real bridge client, temp dirs, fresh env.
	const loader = [
		'import sys',
		`sys.path.insert(0, ${JSON.stringify(pkgRoot)})`,
		'from pathlib import Path',
		'from ag2_sparrow._dirs import set_dirs',
		`set_dirs(task_dir=Path(${JSON.stringify(tasksDir)}), result_dir=Path(${JSON.stringify(resultsDir)}), state_dir=Path(${JSON.stringify(stateDir)}))`,
		'import ag2_sparrow.remote_gateway_bridge as bridge',
		'bridge.main()',
	].join('\n');

	const bridge = spawn('python3', ['-c', loader], {
		env: {
			...process.env,
			REMOTE_TASK_URL: relay.url,
			REMOTE_TASK_TOKEN: TOKEN,
			REMOTE_TASK_PROVIDER: 'bodhi-smoke',
			REMOTE_TASK_POLL_WAIT: '3',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	bridge.stdout.on('data', (d: Buffer) => log(`bridge: ${d.toString().trim()}`));
	bridge.stderr.on('data', (d: Buffer) => log(`bridge: ${d.toString().trim()}`));

	const cleanup = () => {
		bridge.kill('SIGTERM');
		rmSync(workspace, { recursive: true, force: true });
	};
	process.on('exit', cleanup);

	// Core sim: watch temp tasks/, "execute", write the result file.
	const coreSim = setInterval(() => {
		let entries: string[] = [];
		try {
			entries = readdirSync(tasksDir).filter((f) => f.endsWith('.txt'));
		} catch {
			return;
		}
		for (const file of entries) {
			const taskPath = join(tasksDir, file);
			const body = readFileSync(taskPath, 'utf-8');
			const id = file.replace(/\.txt$/, '');
			log(`core-sim: picked up ${id}`);
			if (!body.includes('access_tier:')) {
				fail('task file is missing the bridge-stamped access_tier line');
			}
			if (!body.includes('source: bodhi-smoke') && !body.includes('source: bodhi')) {
				fail(`task file missing expected source header:\n${body}`);
			}
			writeFileSync(join(resultsDir, `${id}.txt`), 'smoke result: 3 invoices found');
			rmSync(taskPath);
		}
	}, 200);

	// 1. Heartbeat → presence goes fresh.
	const deadline = Date.now() + 15_000;
	while (!relay.presence().fresh) {
		if (Date.now() > deadline) fail('no heartbeat from the bridge within 15s');
		await new Promise((r) => setTimeout(r, 200));
	}
	log('presence: fresh (heartbeat received) ✓');

	// 2. Hand-enqueued task round-trips through the real bridge.
	let delivered = false;
	const result = await Promise.race([
		relay.submit(
			{
				id: 'task-bodhi-smoke01-1',
				timestamp: new Date().toISOString(),
				task: '[bodhi session smoke01]\n\nFind the AWS invoices (smoke test).',
				source: 'bodhi',
				channel_id: 'bodhi-smoke01',
				user_id: 'smoke-tester',
				priority: 'normal',
				interaction_type: 'message',
			},
			{
				onDelivered: () => {
					delivered = true;
				},
			},
		),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('round-trip timed out after 30s')), 30_000),
		),
	]).catch((err) => fail(err instanceof Error ? err.message : String(err)));

	clearInterval(coreSim);
	if (!delivered) fail('result arrived without an ack — delivery bookkeeping broken');
	if (result !== 'smoke result: 3 invoices found') fail(`unexpected result body: ${result}`);
	log(`round-trip result: "${result}" ✓`);
	log(`relay task state: ${relay.taskState('task-bodhi-smoke01-1')} ✓`);

	await relay.stop();
	cleanup();
	log('PASS — real bridge client + relay + core sim round-trip verified');
	process.exit(0);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
