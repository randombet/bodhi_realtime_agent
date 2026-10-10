import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ActiveSilenceRecovery,
	EPISODE_ATTEMPT_LIMIT,
} from '../../src/core/active-silence-recovery.js';
import type { RecoverUpstreamArgs } from '../../src/core/host-recovery.js';

const TICK = 30_000;

function makeRecovery(requiredTicks = 3) {
	let dial = 0;
	const recoverUpstream = vi.fn((_args: RecoverUpstreamArgs) => {
		dial += 1;
		return {
			attemptEpoch: dial,
			activated: new Promise<void>(() => {}),
			incumbentClosed: Promise.resolve('closed' as const),
		};
	});
	const sent: Array<Record<string, unknown>> = [];
	const r = new ActiveSilenceRecovery(
		{
			voiceSessionId: 'sess_1',
			recoverUpstream,
			sendJsonToClient: (m) => sent.push(m),
			log: () => {},
			now: () => Date.now(),
		},
		requiredTicks,
	);
	return { r, recoverUpstream, sent, dialCount: () => dial };
}

/** Attached client, active connection (generation `gen`), the user spoke. */
function arm(r: ActiveSilenceRecovery, gen = 1) {
	r.handleClientConnected();
	r.handleLifecycle({ kind: 'setup-ok', connectAttemptId: `att_${gen}`, transportGeneration: gen });
	vi.advanceTimersByTime(1_000);
	r.noteSpeech();
}

/** Run `n` health ticks with microphone audio arriving in each window. */
function silentTicks(r: ActiveSilenceRecovery, n: number) {
	for (let i = 0; i < n; i++) {
		vi.advanceTimersByTime(TICK);
		r.noteMicFrame();
		r.tick('ACTIVE');
	}
}

describe('ActiveSilenceRecovery', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('redials after requiredTicks silent ticks, with nothing synthetic until the user speaks', () => {
		const { r, recoverUpstream } = makeRecovery();
		arm(r);
		silentTicks(r, 2);
		expect(recoverUpstream).not.toHaveBeenCalled();
		silentTicks(r, 1);
		expect(recoverUpstream).toHaveBeenCalledWith({
			reason: 'active-silence',
			skipContextInjection: true,
			holdSyntheticUntilFreshSpeech: true,
		});
		expect(r.ownsRecovery).toBe(true);
	});

	it('does not fire without user speech, without microphone audio, or with a foreground tool running', () => {
		const noSpeech = makeRecovery();
		noSpeech.r.handleClientConnected();
		noSpeech.r.handleLifecycle({
			kind: 'setup-ok',
			connectAttemptId: 'att_1',
			transportGeneration: 1,
		});
		silentTicks(noSpeech.r, 6);
		expect(noSpeech.recoverUpstream).not.toHaveBeenCalled();

		const noMic = makeRecovery();
		arm(noMic.r);
		for (let i = 0; i < 6; i++) {
			vi.advanceTimersByTime(TICK);
			noMic.r.tick('ACTIVE');
		}
		expect(noMic.recoverUpstream).not.toHaveBeenCalled();

		const tool = makeRecovery();
		arm(tool.r);
		tool.r.noteToolCall('call_1');
		silentTicks(tool.r, 6);
		expect(tool.recoverUpstream).not.toHaveBeenCalled();
	});

	it('a model response ends the episode; model progress restarts the count', () => {
		const { r, recoverUpstream } = makeRecovery();
		arm(r);
		silentTicks(r, 2);
		r.noteModelEvent(1);
		silentTicks(r, 2);
		expect(recoverUpstream).not.toHaveBeenCalled();
		r.noteResponse();
		silentTicks(r, 6);
		expect(recoverUpstream).not.toHaveBeenCalled(); // no new speech since the answer
	});

	it('is suspended while the session dictates', () => {
		const { r, recoverUpstream } = makeRecovery();
		arm(r);
		r.noteMeetingMode(true);
		r.noteSpeech();
		silentTicks(r, 6);
		expect(recoverUpstream).not.toHaveBeenCalled();
	});

	it(`after ${EPISODE_ATTEMPT_LIMIT} attempts it sends voice-stalled; a retry command redials once and acks`, () => {
		const { r, recoverUpstream, sent } = makeRecovery();
		arm(r);
		for (let attempt = 1; attempt <= EPISODE_ATTEMPT_LIMIT; attempt++) {
			silentTicks(r, 3);
			expect(recoverUpstream).toHaveBeenCalledTimes(attempt);
			// The replacement comes up and stays silent; the user speaks again.
			r.handleLifecycle({
				kind: 'setup-ok',
				connectAttemptId: `att_${attempt}`,
				transportGeneration: attempt + 1,
			});
			vi.advanceTimersByTime(1_000);
			r.noteSpeech();
		}
		silentTicks(r, 3);
		expect(recoverUpstream).toHaveBeenCalledTimes(EPISODE_ATTEMPT_LIMIT);
		expect(r.phase).toBe('terminal');
		const stalled = sent.find((m) => m.type === 'voice-stalled');
		expect(stalled).toMatchObject({
			version: 1,
			voiceSessionId: 'sess_1',
			clientEpoch: 1,
			reason: 'active-silence-attempts-exhausted',
		});

		const retry = {
			type: 'voice.retryUpstream',
			version: 1,
			voiceSessionId: 'sess_1',
			clientEpoch: 1,
			stalledAttemptEpoch: stalled?.stalledAttemptEpoch as number,
			requestId: 'req-1',
		};
		expect(r.handleClientCommand(retry)).toBe(true);
		expect(recoverUpstream).toHaveBeenCalledTimes(EPISODE_ATTEMPT_LIMIT + 1);
		expect(recoverUpstream).toHaveBeenLastCalledWith(
			expect.objectContaining({ reason: 'human-retry' }),
		);
		const ack = sent.filter((m) => m.type === 'voice.retryUpstream.ack');
		expect(ack).toHaveLength(1);
		expect(ack[0]).toMatchObject({ requestId: 'req-1', disposition: 'accepted' });

		// A duplicate gets the same ack and no second dial.
		r.handleClientCommand(retry);
		expect(recoverUpstream).toHaveBeenCalledTimes(EPISODE_ATTEMPT_LIMIT + 1);
		expect(sent.filter((m) => m.type === 'voice.retryUpstream.ack')).toHaveLength(2);
	});

	it('answers a retry outside terminal as not-terminal, a wrong session as stale, and ignores other commands', () => {
		const { r, recoverUpstream, sent } = makeRecovery();
		arm(r);
		const cmd = {
			type: 'voice.retryUpstream',
			version: 1,
			voiceSessionId: 'sess_1',
			clientEpoch: 1,
			stalledAttemptEpoch: 1,
			requestId: 'a',
		};
		r.handleClientCommand(cmd);
		r.handleClientCommand({ ...cmd, voiceSessionId: 'other', requestId: 'b' });
		expect(sent.map((m) => m.disposition)).toEqual(['not-terminal', 'stale']);
		expect(r.handleClientCommand({ type: 'something.else' })).toBe(false);
		expect(r.handleClientCommand({ type: 'voice.retryUpstream', version: 1 })).toBe(true); // schema reject
		expect(recoverUpstream).not.toHaveBeenCalled();
	});

	it('a fatal backoff holds the redial until it ends', () => {
		const { r, recoverUpstream } = makeRecovery();
		arm(r);
		r.handleFatalBackoff(Date.now() + 10 * 60_000);
		silentTicks(r, 6);
		expect(recoverUpstream).not.toHaveBeenCalled();
		r.handleFatalBackoffCleared();
		silentTicks(r, 1);
		expect(recoverUpstream).toHaveBeenCalledTimes(1);
	});
});
