import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type UpstreamRecoveryOptions,
	UpstreamRecoveryPolicy,
	classifyGeminiClose,
} from '../../src/core/upstream-recovery-policy.js';
import { ConnectionLifecycleLedger } from '../../src/transport/connection-lifecycle-ledger.js';
import type { SessionState } from '../../src/types/session.js';

function makePolicy(options: UpstreamRecoveryOptions = {}) {
	const world = { state: 'ACTIVE' as SessionState, client: true };
	const recoverUpstream = vi.fn(() => ({
		attemptEpoch: 1,
		activated: Promise.resolve(),
		incumbentClosed: Promise.resolve('closed' as const),
	}));
	const parkUpstream = vi.fn(async () => {});
	const sendJsonToClient = vi.fn();
	const policy = new UpstreamRecoveryPolicy(
		{
			sessionId: 'sess_1',
			getState: () => world.state,
			isClientConnected: () => world.client,
			recoverUpstream,
			parkUpstream,
			sendJsonToClient,
			log: () => {},
			now: () => Date.now(),
			random: () => 0.5, // no jitter
		},
		{ healthTickMs: 0, idleParkMs: 0, ...options },
	);
	return { policy, world, recoverUpstream, parkUpstream, sendJsonToClient };
}

const remoteClose = (code = 1011, reason = 'internal error') =>
	({
		kind: 'generation-close',
		connectAttemptId: 'att_1',
		transportGeneration: 1,
		code,
		reason,
	}) as const;

describe('UpstreamRecoveryPolicy', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe('redial ladder', () => {
		it('a remote close redials a parked session after 1 s, then 2 s, 4 s on further failures', () => {
			const { policy, world, recoverUpstream } = makePolicy();
			world.state = 'UPSTREAM_LOST';

			policy.onLifecycle(remoteClose());
			vi.advanceTimersByTime(999);
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
			expect(recoverUpstream).toHaveBeenCalledWith({
				reason: 'human-retry',
				skipContextInjection: false,
				holdSyntheticUntilFreshSpeech: false,
			});

			policy.onLifecycle({ kind: 'attempt', connectAttemptId: 'att_2', handleSupplied: false });
			policy.onLifecycle({ kind: 'setup-failed', connectAttemptId: 'att_2', reason: 'refused' });
			vi.advanceTimersByTime(1_999);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			expect(recoverUpstream).toHaveBeenCalledTimes(2);

			policy.onLifecycle({ kind: 'setup-failed', connectAttemptId: 'att_3' });
			vi.advanceTimersByTime(4_000);
			expect(recoverUpstream).toHaveBeenCalledTimes(3);
		});

		it('the ladder caps at redialCapMs', () => {
			const { policy, world, recoverUpstream } = makePolicy({ redialCapMs: 8_000 });
			world.state = 'UPSTREAM_LOST';
			for (let i = 0; i < 6; i++)
				policy.onLifecycle({ kind: 'setup-failed', connectAttemptId: `a${i}` });
			vi.advanceTimersByTime(7_999);
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});

		it('a connection that lived redialStableMs resets the ladder; one that died sooner does not', () => {
			const { policy, world, recoverUpstream } = makePolicy();
			world.state = 'UPSTREAM_LOST';
			policy.onLifecycle({ kind: 'setup-failed', connectAttemptId: 'a1' });
			policy.onLifecycle({ kind: 'setup-failed', connectAttemptId: 'a2' }); // failures = 2

			// Short-lived connection: the ladder keeps climbing (4 s).
			policy.onLifecycle({ kind: 'setup-ok', connectAttemptId: 'a3', transportGeneration: 1 });
			vi.advanceTimersByTime(5_000);
			policy.onLifecycle(remoteClose());
			vi.advanceTimersByTime(3_999);
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);

			// Stable connection: back to 1 s.
			policy.onLifecycle({ kind: 'setup-ok', connectAttemptId: 'a4', transportGeneration: 2 });
			vi.advanceTimersByTime(30_000);
			policy.onLifecycle(remoteClose());
			vi.advanceTimersByTime(1_000);
			expect(recoverUpstream).toHaveBeenCalledTimes(2);
		});

		it('a dial in flight cancels the pending ladder dial', () => {
			const { policy, world, recoverUpstream } = makePolicy();
			world.state = 'UPSTREAM_LOST';
			policy.onLifecycle(remoteClose());
			policy.onLifecycle({ kind: 'attempt', connectAttemptId: 'att_2', handleSupplied: true });
			vi.advanceTimersByTime(10_000);
			expect(recoverUpstream).not.toHaveBeenCalled();
		});

		it("bodhi's own local disconnect schedules nothing", () => {
			const { policy, world, recoverUpstream } = makePolicy();
			world.state = 'UPSTREAM_LOST';
			policy.onLifecycle(remoteClose(1000, 'local disconnect'));
			vi.advanceTimersByTime(60_000);
			expect(recoverUpstream).not.toHaveBeenCalled();
		});

		it('fires only for a parked session with a client attached', () => {
			const { policy, world, recoverUpstream } = makePolicy();
			world.state = 'RECONNECTING'; // the reconnector is still on it
			policy.onLifecycle(remoteClose());
			vi.advanceTimersByTime(1_000);
			expect(recoverUpstream).not.toHaveBeenCalled();

			world.state = 'UPSTREAM_LOST';
			world.client = false;
			policy.onLifecycle(remoteClose());
			vi.advanceTimersByTime(2_000);
			expect(recoverUpstream).not.toHaveBeenCalled();
		});
	});

	describe('fatal backoff', () => {
		it('a fatal close blocks dialing for fatalBackoffMs, reports it, and ACTIVE clears it and reports recovery', () => {
			const onFatal = vi.fn();
			const onRecovered = vi.fn();
			const { policy, world, recoverUpstream } = makePolicy({
				fatalBackoffMs: 300_000,
				onFatal,
				onRecovered,
			});
			world.state = 'UPSTREAM_LOST';

			policy.onLifecycle(remoteClose(1011, 'You exceeded your current quota'));
			expect(onFatal).toHaveBeenCalledWith(
				expect.objectContaining({ category: 'quota_exceeded', until: 1_000_000 + 300_000 }),
			);
			expect(policy.inFatalBackoff()).toBe(true);
			vi.advanceTimersByTime(299_999);
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);

			policy.onStateChange('ACTIVE');
			expect(policy.inFatalBackoff()).toBe(false);
			expect(onRecovered).toHaveBeenCalledTimes(1);
			policy.onStateChange('ACTIVE');
			expect(onRecovered).toHaveBeenCalledTimes(1);
		});

		it('suppresses the attach redial only while the reconnector redials inside a fatal backoff', () => {
			const { policy, world } = makePolicy();
			policy.onLifecycle(remoteClose(1011, 'API key not valid'));
			world.state = 'RECONNECTING';
			expect(policy.suppressAttachRedial()).toBe(true);
			world.state = 'UPSTREAM_LOST';
			expect(policy.suppressAttachRedial()).toBe(false);
		});

		it('classifies the Gemini non-retryable closes and nothing else', () => {
			expect(classifyGeminiClose(1011, 'Your prepayment credits are depleted')?.category).toBe(
				'credits_depleted',
			);
			expect(classifyGeminiClose(1011, 'quota exceeded for this project')?.category).toBe(
				'quota_exceeded',
			);
			expect(
				classifyGeminiClose(1007, 'API key not valid. Please pass a valid API key.')?.category,
			).toBe('auth_invalid');
			expect(
				classifyGeminiClose(1008, 'models/gemini-x is not found for API version v1beta')?.category,
			).toBe('model_not_found');
			expect(classifyGeminiClose(1011, 'Too many requests (429)')).toBeNull();
			expect(classifyGeminiClose(1006, '')).toBeNull();
		});
	});

	describe('health tick', () => {
		it('redials a parked session with a client the ladder missed, then waits more than a minute before the next', () => {
			const { policy, world, recoverUpstream } = makePolicy({ healthTickMs: 30_000 });
			policy.start();
			world.state = 'UPSTREAM_LOST';
			vi.advanceTimersByTime(30_000);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(60_000); // exactly a minute later: not yet
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(30_000);
			expect(recoverUpstream).toHaveBeenCalledTimes(2);
			policy.dispose();
		});

		it('replaces a dial stuck in CONNECTING past stuckConnectingMs with a client attached', () => {
			const { policy, world, recoverUpstream } = makePolicy({ stuckConnectingMs: 120_000 });
			world.state = 'CONNECTING';
			policy.onStateChange('CONNECTING');
			vi.advanceTimersByTime(120_000);
			policy.tick();
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			policy.tick();
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});

		it('raises a stuckConnectingMs below the floor to 60 s and treats 0 as off', () => {
			const low = makePolicy({ stuckConnectingMs: 5_000 });
			low.world.state = 'CONNECTING';
			low.policy.onStateChange('CONNECTING');
			vi.advanceTimersByTime(30_000);
			low.policy.tick();
			expect(low.recoverUpstream).not.toHaveBeenCalled();

			const off = makePolicy({ stuckConnectingMs: 0 });
			off.world.state = 'CONNECTING';
			off.policy.onStateChange('CONNECTING');
			vi.advanceTimersByTime(600_000);
			off.policy.tick();
			expect(off.recoverUpstream).not.toHaveBeenCalled();
		});
	});

	describe('idle park', () => {
		it('parks after idleParkMs with no client; an attach before then cancels it', async () => {
			const { policy, world, parkUpstream } = makePolicy({ idleParkMs: 60_000 });
			world.client = false;
			policy.onClientDisconnected();
			vi.advanceTimersByTime(30_000);
			world.client = true;
			policy.onClientConnected();
			vi.advanceTimersByTime(60_000);
			expect(parkUpstream).not.toHaveBeenCalled();

			world.client = false;
			policy.onClientDisconnected();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(parkUpstream).toHaveBeenCalledWith('idle');
		});

		it('does not park a session that is not ACTIVE or RECONNECTING', async () => {
			const { policy, world, parkUpstream } = makePolicy({ idleParkMs: 60_000 });
			world.client = false;
			world.state = 'UPSTREAM_LOST';
			policy.onClientDisconnected();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(parkUpstream).not.toHaveBeenCalled();
		});
	});

	describe('redial after a park', () => {
		it('a reconnector park redials after parkRedialDelayMs; a host park does not', () => {
			const { policy, world, recoverUpstream } = makePolicy({ parkRedialDelayMs: 1_500 });
			world.state = 'UPSTREAM_LOST';
			policy.onUpstreamLost('reconnect-exhausted');
			vi.advanceTimersByTime(1_499);
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);

			policy.onUpstreamLost('host-parked');
			vi.advanceTimersByTime(120_000);
			policy.tick();
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});

		it('a park inside a fatal backoff waits for it to end', () => {
			const { policy, world, recoverUpstream } = makePolicy({ fatalBackoffMs: 300_000 });
			policy.onLifecycle(remoteClose(1011, 'quota exceeded'));
			world.state = 'UPSTREAM_LOST';
			policy.onUpstreamLost('reconnect-exhausted');
			vi.advanceTimersByTime(299_000);
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1_200);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});
	});

	describe('isLive', () => {
		it('replaces the client check, so a session without a client (a call) redials while live', () => {
			let live = true;
			const { policy, world, recoverUpstream } = makePolicy({
				isLive: () => live,
				holdSyntheticUntilFreshSpeech: true,
			});
			world.client = false;
			world.state = 'UPSTREAM_LOST';
			policy.onUpstreamLost('reconnect-exhausted');
			vi.advanceTimersByTime(1_500);
			expect(recoverUpstream).toHaveBeenCalledWith(
				expect.objectContaining({ holdSyntheticUntilFreshSpeech: true }),
			);

			live = false;
			policy.onUpstreamLost('recover-upstream-failed');
			vi.advanceTimersByTime(60_000);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});

		it('a throwing isLive reads as not live', () => {
			const { policy, world, recoverUpstream } = makePolicy({
				isLive: () => {
					throw new Error('boom');
				},
			});
			world.state = 'UPSTREAM_LOST';
			policy.onUpstreamLost('reconnect-exhausted');
			vi.advanceTimersByTime(10_000);
			expect(recoverUpstream).not.toHaveBeenCalled();
		});
	});

	describe('active silence', () => {
		function silentTicks(policy: UpstreamRecoveryPolicy, n: number) {
			for (let i = 0; i < n; i++) {
				vi.advanceTimersByTime(30_000);
				policy.noteMicFrame();
				policy.tick();
			}
		}

		it('is off unless configured, and handles voice.retryUpstream only when on', () => {
			const off = makePolicy();
			off.policy.onClientConnected();
			off.policy.onLifecycle({
				kind: 'setup-ok',
				connectAttemptId: 'att_1',
				transportGeneration: 1,
			});
			off.policy.noteUserSpeech();
			silentTicks(off.policy, 6);
			expect(off.recoverUpstream).not.toHaveBeenCalled();
			expect(off.policy.handleClientCommand({ type: 'voice.retryUpstream' })).toBe(false);

			const on = makePolicy({ activeSilence: {} });
			expect(on.policy.handleClientCommand({ type: 'voice.retryUpstream' })).toBe(true);
		});

		it('redials a silent session and, while it owns the recovery, the ladder and health tick stand down', () => {
			const { policy, world, recoverUpstream } = makePolicy({
				activeSilence: { requiredTicks: 3 },
			});
			policy.onClientConnected();
			policy.onLifecycle({ kind: 'setup-ok', connectAttemptId: 'att_1', transportGeneration: 1 });
			vi.advanceTimersByTime(1_000);
			policy.noteUserSpeech();
			silentTicks(policy, 3);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
			expect(recoverUpstream).toHaveBeenLastCalledWith(
				expect.objectContaining({ reason: 'active-silence' }),
			);

			// Its dial fails and parks: the ladder and the tick leave it to active silence.
			world.state = 'UPSTREAM_LOST';
			policy.onLifecycle({ kind: 'setup-failed', connectAttemptId: 'att_2' });
			policy.onUpstreamLost('recover-upstream-failed');
			vi.advanceTimersByTime(30_000);
			policy.tick();
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});
	});

	describe('review fixes', () => {
		it('a fatal close before setupComplete starts the backoff: the reason is only on attempt-close', () => {
			const onFatal = vi.fn();
			const { policy, world, recoverUpstream } = makePolicy({ fatalBackoffMs: 300_000, onFatal });
			world.state = 'UPSTREAM_LOST';
			// The transport's order for a close before setup: attempt-close, then setup-failed.
			const ledger = new ConnectionLifecycleLedger((ev) => policy.onLifecycle(ev));
			ledger.beginAttempt(1, false);
			ledger.socketClosed(1007, 'API key not valid. Please pass a valid API key.');
			ledger.setupFailed('Gemini socket closed before setupComplete (code=1007)');
			expect(onFatal).toHaveBeenCalledTimes(1);
			expect(onFatal).toHaveBeenCalledWith(
				expect.objectContaining({ category: 'auth_invalid', code: 1007 }),
			);
			expect(policy.inFatalBackoff()).toBe(true);
			vi.advanceTimersByTime(299_000);
			expect(recoverUpstream).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1_200);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});

		it('a retryable close before setup still redials on the ladder', () => {
			const { policy, world, recoverUpstream } = makePolicy();
			world.state = 'UPSTREAM_LOST';
			const ledger = new ConnectionLifecycleLedger((ev) => policy.onLifecycle(ev));
			ledger.beginAttempt(1, false);
			ledger.socketClosed(1006, 'abnormal');
			ledger.setupFailed('Gemini socket closed before setupComplete (code=1006): abnormal');
			expect(policy.inFatalBackoff()).toBe(false);
			vi.advanceTimersByTime(1_000);
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
		});

		it('while active silence owns a recovery, a client attach and the reconnector stand down', () => {
			const { policy } = makePolicy({ activeSilence: { requiredTicks: 3 } });
			expect(policy.suppressAttachRedial()).toBe(false);
			policy.onClientConnected();
			policy.onLifecycle({ kind: 'setup-ok', connectAttemptId: 'att_1', transportGeneration: 1 });
			vi.advanceTimersByTime(1_000);
			policy.noteUserSpeech();
			for (let i = 0; i < 3; i++) {
				vi.advanceTimersByTime(30_000);
				policy.noteMicFrame();
				policy.tick();
			}
			expect(policy.suppressAttachRedial()).toBe(true);
		});

		it('a refused stuck-dial replacement keeps its clock, so the next tick tries again', () => {
			const { policy, world, recoverUpstream } = makePolicy({ stuckConnectingMs: 120_000 });
			recoverUpstream.mockImplementationOnce(() => {
				throw new Error('refused');
			});
			world.state = 'CONNECTING';
			policy.onStateChange('CONNECTING');
			vi.advanceTimersByTime(120_001);
			policy.tick();
			expect(recoverUpstream).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(60_001);
			policy.tick();
			expect(recoverUpstream).toHaveBeenCalledTimes(2);
		});
	});

	it('dispose stops every timer', () => {
		const { policy, world, recoverUpstream, parkUpstream } = makePolicy({
			healthTickMs: 30_000,
			idleParkMs: 60_000,
		});
		world.state = 'UPSTREAM_LOST';
		world.client = false;
		policy.start();
		policy.onLifecycle(remoteClose());
		policy.dispose();
		world.client = true;
		vi.advanceTimersByTime(600_000);
		expect(recoverUpstream).not.toHaveBeenCalled();
		expect(parkUpstream).not.toHaveBeenCalled();
	});
});
