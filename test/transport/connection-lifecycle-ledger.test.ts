import { describe, expect, it, vi } from 'vitest';
import { ConnectionLifecycleLedger } from '../../src/transport/connection-lifecycle-ledger.js';
import type { ConnectionLifecycleEvent } from '../../src/types/transport.js';

function record() {
	const events: ConnectionLifecycleEvent[] = [];
	const ledger = new ConnectionLifecycleLedger((e) => events.push(e));
	return { events, ledger };
}

describe('ConnectionLifecycleLedger', () => {
	it('attempt then setup-ok share connectAttemptId and mint generation 1', () => {
		const { events, ledger } = record();
		expect(ledger.beginAttempt(1, false)).toBe('att_1');
		expect(ledger.setupOk()).toBe(1);

		expect(events).toEqual([
			{ kind: 'attempt', connectAttemptId: 'att_1', handleSupplied: false },
			{ kind: 'setup-ok', connectAttemptId: 'att_1', transportGeneration: 1 },
		]);
	});

	it('generations count setups, not attempts', () => {
		const { events, ledger } = record();
		ledger.beginAttempt(1, false);
		ledger.setupFailed('timed out');
		ledger.beginAttempt(3, true);
		expect(ledger.setupOk()).toBe(1);

		expect(events.at(-1)).toEqual({
			kind: 'setup-ok',
			connectAttemptId: 'att_3',
			transportGeneration: 1,
		});
		expect(events[1]).toEqual({
			kind: 'setup-failed',
			connectAttemptId: 'att_1',
			reason: 'timed out',
		});
	});

	it('a close before setupOk is attempt-close without a generation', () => {
		const { events, ledger } = record();
		ledger.beginAttempt(1, false);
		ledger.socketClosed(1006, 'died during setup');

		const close = events.at(-1) as ConnectionLifecycleEvent;
		expect(close).toMatchObject({
			kind: 'attempt-close',
			connectAttemptId: 'att_1',
			code: 1006,
			reason: 'died during setup',
		});
		expect(Object.hasOwn(close, 'transportGeneration')).toBe(false);
	});

	it('a close after setupOk is generation-close with the generation', () => {
		const { events, ledger } = record();
		ledger.beginAttempt(1, false);
		ledger.setupOk();
		ledger.socketClosed(1011, 'internal error');

		expect(events.at(-1)).toEqual({
			kind: 'generation-close',
			connectAttemptId: 'att_1',
			transportGeneration: 1,
			code: 1011,
			reason: 'internal error',
		});
	});

	it('a second close for the same attempt is dropped', () => {
		const { events, ledger } = record();
		ledger.beginAttempt(1, false);
		ledger.setupOk();
		ledger.socketClosed(1011);
		ledger.socketClosed(1000);
		ledger.localDisconnect();
		expect(events.filter((e) => e.kind === 'generation-close')).toHaveLength(1);

		// The next attempt closes afresh.
		ledger.beginAttempt(2, true);
		ledger.socketClosed(1006);
		expect(events.at(-1)).toMatchObject({ kind: 'attempt-close', connectAttemptId: 'att_2' });
	});

	it('localDisconnect emits one generation-close 1000 "local disconnect", and the late socket close is dropped', () => {
		const { events, ledger } = record();
		ledger.beginAttempt(1, false);
		ledger.setupOk();
		ledger.localDisconnect();
		ledger.localDisconnect();
		ledger.socketClosed(1000, 'late');

		const closes = events.filter((e) => e.kind === 'generation-close');
		expect(closes).toEqual([
			{
				kind: 'generation-close',
				connectAttemptId: 'att_1',
				transportGeneration: 1,
				code: 1000,
				reason: 'local disconnect',
			},
		]);
	});

	it('localDisconnect is a no-op before setup', () => {
		const { events, ledger } = record();
		ledger.localDisconnect(); // no attempt at all
		ledger.beginAttempt(1, false);
		ledger.localDisconnect(); // attempt, but no setup
		expect(events.map((e) => e.kind)).toEqual(['attempt']);

		// The pre-setup socket close is still reported.
		ledger.socketClosed(1006);
		expect(events.map((e) => e.kind)).toEqual(['attempt', 'attempt-close']);
	});

	it('a throwing observer never escapes and every later event still fires', () => {
		const seen: string[] = [];
		const warn = vi.fn();
		const ledger = new ConnectionLifecycleLedger((e) => {
			seen.push(e.kind);
			throw new Error(`observer failed on ${e.kind}`);
		}, warn);

		expect(() => {
			ledger.beginAttempt(1, false);
			expect(ledger.setupOk()).toBe(1);
			ledger.socketClosed(1011);
			ledger.beginAttempt(2, false);
			ledger.setupFailed('closed');
			ledger.localDisconnect();
		}).not.toThrow();

		expect(seen).toEqual(['attempt', 'setup-ok', 'generation-close', 'attempt', 'setup-failed']);
		expect(warn).toHaveBeenCalledTimes(5);
		expect(warn.mock.calls[0][1]).toBeInstanceOf(Error);
	});
});
