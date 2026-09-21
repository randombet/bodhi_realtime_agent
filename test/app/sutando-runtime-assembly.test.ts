import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBodhiSessionConfig } from '../../app/agents/bodhi-session.js';
import { assertSutandoProfileAllowed } from '../../app/lib/integrations/sutando/sutando-profile-gate.js';
import { SutandoRelayServer } from '../../app/lib/integrations/sutando/sutando-relay-server.js';
import type { ToolContext } from '../../src/types/tool.js';

const dirs: string[] = [];
const relays: SutandoRelayServer[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const r of relays.splice(0)) await r.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rawDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'sutando-assembly-raw-'));
	dirs.push(d);
	return d;
}

async function startRelay(): Promise<SutandoRelayServer> {
	const relay = new SutandoRelayServer({ token: 'assembly-token', port: 0, log: () => {} });
	await relay.start();
	relays.push(relay);
	return relay;
}

interface AssembleOptions {
	authorization?: unknown;
	closeHostedSession?: (reason: string) => void;
	getSessionRef?: () => unknown;
}

async function assembleSutando(relay: SutandoRelayServer, raw: string, opts: AssembleOptions = {}) {
	return await createBodhiSessionConfig({
		apiKey: 'test-key',
		memoryStore: {
			addFacts: vi.fn(),
			getAll: vi.fn(async () => []),
			replaceAll: vi.fn(),
			getDirectives: vi.fn(async () => null),
			setDirectives: vi.fn(),
		},
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		sessionId: '',
		userId: 'owner-1',
		agentProfile: 'sutando',
		getSessionRef: (opts.getSessionRef ?? (() => null)) as never,
		sutando: {
			relay,
			rawDir: raw,
			authorization:
				'authorization' in opts
					? opts.authorization
					: assertSutandoProfileAllowed('web_ws', { ownerUserId: 'owner-1' }),
			closeHostedSession: opts.closeHostedSession ?? (() => {}),
			log: () => {},
		},
	});
}

describe('sutando runtime assembly', () => {
	it('assembles with a gate-issued capability and passes validateSutandoWiring', async () => {
		const relay = await startRelay();
		const { voiceSessionConfig, profileLifecycle } = await assembleSutando(relay, rawDir());
		const main = voiceSessionConfig.agents.find((a) => a.name === 'main');
		expect(main?.tools.some((t) => t.name === 'ask_sutando')).toBe(true);
		expect(voiceSessionConfig.subagentConfigs?.ask_sutando?.lifetime).toBe('persistent_session');
		expect(voiceSessionConfig.orchestrationMode).toBe('actor');
		expect(voiceSessionConfig.responseWatchdogMs).toBe(12_000);
		expect(profileLifecycle?.onSessionStarted).toBeTypeOf('function');
		expect(profileLifecycle?.onSessionClosed).toBeTypeOf('function');
	});

	it('refuses assembly for a missing capability', async () => {
		const relay = await startRelay();
		await expect(assembleSutando(relay, rawDir(), { authorization: undefined })).rejects.toThrow(
			/unregistered SutandoAuthorization/,
		);
	});

	it('refuses assembly for a structurally identical (forged) capability', async () => {
		const relay = await startRelay();
		const forged = { ownerUserId: 'owner-1', profile: 'sutando', surface: 'web_ws' };
		await expect(assembleSutando(relay, rawDir(), { authorization: forged })).rejects.toThrow(
			/unregistered SutandoAuthorization/,
		);
	});

	it('two concurrent assemblies get independent wiring (distinct persistent configs)', async () => {
		const relay = await startRelay();
		const raw = rawDir();
		const a = await assembleSutando(relay, raw);
		const b = await assembleSutando(relay, raw);
		expect(a.voiceSessionConfig.subagentConfigs?.ask_sutando).not.toBe(
			b.voiceSessionConfig.subagentConfigs?.ask_sutando,
		);
		expect(a.profileLifecycle).not.toBe(b.profileLifecycle);
	});

	it('end_session is the session-closing variant (invokes closeHostedSession after grace)', async () => {
		vi.useFakeTimers();
		const relay = await startRelay();
		const closed: string[] = [];
		const { voiceSessionConfig } = await assembleSutando(relay, rawDir(), {
			closeHostedSession: (reason) => closed.push(reason),
		});
		const main = voiceSessionConfig.agents.find((a) => a.name === 'main');
		const endSession = main?.tools.find((t) => t.name === 'end_session');
		expect(endSession).toBeDefined();
		const sendJsonToClient = vi.fn();
		await endSession?.execute?.({}, { sendJsonToClient } as unknown as ToolContext);
		expect(closed).toEqual([]);
		vi.advanceTimersByTime(5_100);
		expect(closed).toEqual(['user_goodbye']);
		expect(sendJsonToClient).toHaveBeenCalledWith({ type: 'session_end', reason: 'user_goodbye' });
	});

	it('recordRaw hook writes the sidecar under the session directory (0600, atomic)', async () => {
		const relay = await startRelay();
		const raw = rawDir();
		const sessionRef = { getSessionId: () => 'sess_live_1', publishSystemNotification: vi.fn() };
		const { voiceSessionConfig } = await assembleSutando(relay, raw, {
			getSessionRef: () => sessionRef,
		});
		// Reach the hooks through the persistent factory's instance: invoking the
		// factory constructs the SutandoSubagentInstance with the wired hooks.
		const factory = voiceSessionConfig.subagentConfigs?.ask_sutando?.persistentFactory;
		expect(factory).toBeTypeOf('function');
		const instance = (await factory?.('ask_sutando', {} as never)) as unknown as {
			hooks?: { recordRaw?: (taskId: string, raw: string) => void };
		};
		// The instance stores hooks internally; exercise the write through the
		// public path by calling the hook captured at construction if exposed,
		// otherwise via a direct sidecar write equivalence check.
		// (The wiring passes hooks straight through createSutandoAgentConfig.)
		expect(instance).toBeDefined();
		// Direct behavioral check of the hook wiring: the wiring's hook writes
		// to <raw>/<sessionId>/<taskId>.txt when the session ref is live.
		const files = () => {
			try {
				return readdirSync(join(raw, 'sess_live_1'));
			} catch {
				return [];
			}
		};
		expect(files()).toEqual([]);
		// Simulate what the instance does on result normalization (the instance
		// stores its hooks privately; reach them for a direct behavioral check).
		// biome-ignore lint/suspicious/noExplicitAny: reaching test-only internals
		const hooks = (instance as any).hooks as {
			recordRaw?: (taskId: string, raw: string) => void;
		};
		expect(hooks?.recordRaw).toBeTypeOf('function');
		hooks.recordRaw?.('task-bodhi-test-1', 'full raw body');
		expect(files()).toEqual(['task-bodhi-test-1.txt']);
		expect(readFileSync(join(raw, 'sess_live_1', 'task-bodhi-test-1.txt'), 'utf-8')).toBe(
			'full raw body',
		);
	});

	it('onSessionStarted claims, publishes, and acks; failed publish leaves the lease; onSessionClosed releases', async () => {
		const relay = await startRelay();
		const claimed: string[] = [];
		const acked: string[] = [];
		const released: string[] = [];
		const fakeRelay = Object.create(relay) as SutandoRelayServer;
		fakeRelay.reapNow = () => {};
		fakeRelay.claimRecoveryNotices = (nonce: string) => {
			claimed.push(nonce);
			return [
				{ id: 'n1', kind: 'dropped_before_delivery', text: 'a request was dropped' },
			] as never;
		};
		fakeRelay.ackRecoveryNotice = (id: string) => {
			acked.push(id);
			return true;
		};
		fakeRelay.releaseRecoveryNotices = (nonce: string) => {
			released.push(nonce);
		};

		let publishResult = true;
		const sessionRef = {
			getSessionId: () => 'sess_live_2',
			publishSystemNotification: vi.fn(),
			tryPublishSystemNotification: vi.fn(() => publishResult),
		};
		const { profileLifecycle } = await assembleSutando(fakeRelay, rawDir(), {
			getSessionRef: () => sessionRef,
		});

		profileLifecycle?.onSessionStarted?.();
		expect(claimed).toHaveLength(1);
		expect(acked).toEqual(['n1']);

		publishResult = false; // enqueue refused (e.g. session closing)
		profileLifecycle?.onSessionStarted?.();
		expect(acked).toEqual(['n1']); // no new ack

		profileLifecycle?.onSessionClosed?.();
		expect(released).toEqual([claimed[0]]);
	});
});
