import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SutandoRelayServer,
	type SutandoTaskFields,
} from '../../app/lib/integrations/sutando/sutando-relay-server.js';
import { SutandoTaskLedger } from '../../app/lib/integrations/sutando/sutando-task-ledger.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

const TOKEN = 'lease-token';

function fields(id: string): SutandoTaskFields {
	return { id, timestamp: new Date().toISOString(), task: 'do a thing', source: 'bodhi' };
}

/**
 * Produce a relay with one pending recovery notice: submit a task under one
 * relay instance, "crash" it, and let a second instance on the same ledger
 * reap the dropped-before-delivery notice.
 */
async function relayWithNotice(
	dir: string,
	now: () => number,
): Promise<{ relay: SutandoRelayServer; noticeId: string }> {
	const relay1 = new SutandoRelayServer({
		token: TOKEN,
		port: 0,
		log: () => {},
		ledger: new SutandoTaskLedger({ dir, log: () => {} }),
	});
	await relay1.start();
	relay1
		.submit(fields('task-bodhi-lease-1'), { nonce: 'aaaa', desc: 'dropped task' })
		.catch(() => {});
	await relay1.stop();

	const relay = new SutandoRelayServer({
		token: TOKEN,
		port: 0,
		log: () => {},
		ledger: new SutandoTaskLedger({ dir, log: () => {} }),
		now,
	});
	await relay.start();
	relay.reapNow();
	return { relay, noticeId: 'task-bodhi-lease-1' };
}

describe('recovery-notice lease/ack protocol', () => {
	const dirs: string[] = [];
	const relays: SutandoRelayServer[] = [];

	afterEach(async () => {
		for (const r of relays.splice(0)) await r.stop();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function dir(): string {
		const d = mkdtempSync(join(tmpdir(), 'sutando-lease-'));
		dirs.push(d);
		return d;
	}

	it('claims are disjoint across concurrent sessions', async () => {
		const { relay } = await relayWithNotice(dir(), Date.now);
		relays.push(relay);
		const a = relay.claimRecoveryNotices('session-a');
		const b = relay.claimRecoveryNotices('session-b');
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(0);
	});

	it('failure between claim and ack: release returns the notice for the next session', async () => {
		const { relay, noticeId } = await relayWithNotice(dir(), Date.now);
		relays.push(relay);
		const a = relay.claimRecoveryNotices('session-a');
		expect(a).toHaveLength(1);
		// Session A dies before publishing — its teardown releases the lease.
		relay.releaseRecoveryNotices('session-a');
		const b = relay.claimRecoveryNotices('session-b');
		expect(b.map((n) => n.id)).toEqual([noticeId]);
		expect(relay.ackRecoveryNotice(noticeId, 'session-b')).toBe(true);
		// Consumed: no further claims, ever.
		relay.reapNow();
		expect(relay.claimRecoveryNotices('session-c')).toHaveLength(0);
	});

	it('lease expiry frees a wedged session claim without an explicit release', async () => {
		let t = 1_000_000;
		const { relay, noticeId } = await relayWithNotice(dir(), () => t);
		relays.push(relay);
		expect(relay.claimRecoveryNotices('session-wedged')).toHaveLength(1);
		expect(relay.claimRecoveryNotices('session-b')).toHaveLength(0);
		t += 61_000; // past the 60s notice lease timeout
		const b = relay.claimRecoveryNotices('session-b');
		expect(b.map((n) => n.id)).toEqual([noticeId]);
		// The wedged session's late ack no longer matches.
		expect(relay.ackRecoveryNotice(noticeId, 'session-wedged')).toBe(false);
		expect(relay.ackRecoveryNotice(noticeId, 'session-b')).toBe(true);
	});

	it('ack by a non-claiming session is rejected and keeps the notice', async () => {
		const { relay, noticeId } = await relayWithNotice(dir(), Date.now);
		relays.push(relay);
		relay.claimRecoveryNotices('session-a');
		expect(relay.ackRecoveryNotice(noticeId, 'session-intruder')).toBe(false);
		relay.releaseRecoveryNotices('session-a');
		expect(relay.claimRecoveryNotices('session-b')).toHaveLength(1);
	});

	it('crash after ack: the ledger record remains and nothing is redelivered', async () => {
		const d = dir();
		const { relay, noticeId } = await relayWithNotice(d, Date.now);
		relays.push(relay);
		relay.claimRecoveryNotices('session-a');
		expect(relay.ackRecoveryNotice(noticeId, 'session-a')).toBe(true);
		await relay.stop();

		// "Crash" after ack: a fresh relay on the same ledger must not resurface it.
		const relay2 = new SutandoRelayServer({
			token: TOKEN,
			port: 0,
			log: () => {},
			ledger: new SutandoTaskLedger({ dir: d, log: () => {} }),
		});
		await relay2.start();
		relays.push(relay2);
		relay2.reapNow();
		expect(relay2.claimRecoveryNotices('session-next')).toHaveLength(0);
		expect(relay2.drainRecoveryNotices()).toHaveLength(0);
		// The record itself survives for operator inspection.
		const ledger = new SutandoTaskLedger({ dir: d, log: () => {} });
		expect(ledger.loadTaskViews().has(noticeId)).toBe(true);
	});

	it('drainRecoveryNotices skips live leases (claiming session owns delivery)', async () => {
		const { relay, noticeId } = await relayWithNotice(dir(), Date.now);
		relays.push(relay);
		relay.claimRecoveryNotices('session-a');
		expect(relay.drainRecoveryNotices()).toHaveLength(0);
		expect(relay.ackRecoveryNotice(noticeId, 'session-a')).toBe(true);
	});
});

// --- tryPublishSystemNotification --------------------------------------------

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

function createMockTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: true,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: true,
			sessionResumption: false,
			contextCompression: false,
			groundingMetadata: false,
			textResponseModality: true,
		} satisfies TransportCapabilities,
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		} satisfies AudioFormatSpec,
		isConnected: true,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

describe('VoiceSession.tryPublishSystemNotification', () => {
	it('returns true while the session can accept, false after close', async () => {
		const session = new VoiceSession({
			sessionId: 'sess_try_publish',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport: createMockTransport(),
			orchestrationMode: 'actor',
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		});
		expect(session.tryPublishSystemNotification('hello')).toBe(true);
		await session.close('normal');
		expect(session.tryPublishSystemNotification('too late')).toBe(false);
	});
});
