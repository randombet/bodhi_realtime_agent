// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ReconnectSessionManager,
	TransportReconnectorDeps,
} from '../../src/core/transport-reconnector.js';
import { TransportReconnector } from '../../src/core/transport-reconnector.js';
import type { IClientChannel } from '../../src/types/session-client.js';
import type { LLMTransport, ReplayItem } from '../../src/types/transport.js';

type SessionState = ReconnectSessionManager['state'];

/** A mutable in-memory session-manager stub (the real one enforces transition
 *  validity, which is out of scope for the reconnector's own contract). */
function fakeSessionManager(initial: SessionState = 'ACTIVE', handle: string | null = 'handle-1') {
	let state: SessionState = initial;
	let resumptionHandle = handle;
	return {
		get state() {
			return state;
		},
		get resumptionHandle() {
			return resumptionHandle;
		},
		transitionTo: vi.fn((s: SessionState) => {
			state = s;
		}),
		updateResumptionHandle: vi.fn((h: string) => {
			resumptionHandle = h;
		}),
		clearResumptionHandle: vi.fn(() => {
			resumptionHandle = null;
		}),
		/** Test helper: force state without transition validation. */
		_setState(s: SessionState) {
			state = s;
		},
	};
}

function fakeClientTransport(buffered: Buffer[] = []): IClientChannel & {
	startBuffering: ReturnType<typeof vi.fn>;
	stopBuffering: ReturnType<typeof vi.fn>;
} {
	return {
		sendAudioToClient: vi.fn(),
		sendJsonToClient: vi.fn(),
		startBuffering: vi.fn(),
		stopBuffering: vi.fn(() => buffered),
	} as unknown as IClientChannel & {
		startBuffering: ReturnType<typeof vi.fn>;
		stopBuffering: ReturnType<typeof vi.fn>;
	};
}

function fakeTransport(overrides: Partial<LLMTransport> = {}): LLMTransport {
	return {
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		elicitResponse: vi.fn(),
		triggerGeneration: vi.fn(),
		...overrides,
	} as unknown as LLMTransport;
}

interface Harness {
	reconnector: TransportReconnector;
	sm: ReturnType<typeof fakeSessionManager>;
	clientTransport: ReturnType<typeof fakeClientTransport>;
	transport: LLMTransport;
	eventBus: { publish: ReturnType<typeof vi.fn> };
	log: ReturnType<typeof vi.fn>;
	reportError: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
	watchdogMs?: number;
	agentMode?: boolean;
	initial?: SessionState;
	handle?: string | null;
	transport?: LLMTransport;
	clientTransport?: ReturnType<typeof fakeClientTransport>;
	replay?: ReplayItem[];
}): Harness {
	const sm = fakeSessionManager(
		opts.initial ?? 'ACTIVE',
		opts.handle === undefined ? 'handle-1' : opts.handle,
	);
	const clientTransport = opts.clientTransport ?? fakeClientTransport();
	const transport = opts.transport ?? fakeTransport();
	const eventBus = { publish: vi.fn() };
	const log = vi.fn();
	const reportError = vi.fn();
	const deps: TransportReconnectorDeps = {
		sessionManager: sm,
		clientTransport,
		transport,
		toReplayContent: () => opts.replay ?? [],
		eventBus: eventBus as unknown as TransportReconnectorDeps['eventBus'],
		getSessionId: () => 'sess_1',
		isAgentMode: () => opts.agentMode ?? true,
		reportError,
		log,
	};
	const reconnector = new TransportReconnector(deps, opts.watchdogMs ?? 8000);
	return { reconnector, sm, clientTransport, transport, eventBus, log, reportError };
}

describe('TransportReconnector', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	describe('triggerReconnect (budgeted, backed-off)', () => {
		it('reconnects with the resumption handle, replays buffered audio, and goes ACTIVE', async () => {
			const buffered = [Buffer.from('one'), Buffer.from('two')];
			const ct = fakeClientTransport(buffered);
			const replay: ReplayItem[] = [{ role: 'user', parts: [] } as unknown as ReplayItem];
			const h = makeHarness({ clientTransport: ct, replay });

			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			expect(ct.startBuffering).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(1000); // RECONNECT_BACKOFF_MS[0]
			await vi.runAllTimersAsync();

			expect(h.transport.reconnect).toHaveBeenCalledWith({
				resumptionHandle: 'handle-1',
				conversationHistory: replay,
			});
			expect((h.transport.sendAudio as ReturnType<typeof vi.fn>).mock.calls).toEqual([
				[Buffer.from('one').toString('base64')],
				[Buffer.from('two').toString('base64')],
			]);
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});

		it('follows the backoff schedule 1000/2000/4000 across attempts', async () => {
			const h = makeHarness({});
			const reconnect = h.transport.reconnect as ReturnType<typeof vi.fn>;

			// Attempt 1: 1000ms backoff.
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(999);
			expect(reconnect).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			await vi.runAllTimersAsync();
			expect(reconnect).toHaveBeenCalledTimes(1);

			// Attempt 2: 2000ms backoff (state is back to ACTIVE after success).
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(1999);
			expect(reconnect).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			await vi.runAllTimersAsync();
			expect(reconnect).toHaveBeenCalledTimes(2);

			// Attempt 3: 4000ms backoff.
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(3999);
			expect(reconnect).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(1);
			await vi.runAllTimersAsync();
			expect(reconnect).toHaveBeenCalledTimes(3);
		});

		it('CLOSEs when the reconnect budget is exhausted (4th attempt gives up)', async () => {
			const h = makeHarness({});
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);

			// 4th: budget spent → immediate CLOSED, no further reconnect.
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('CLOSED');
			vi.advanceTimersByTime(4000);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);
		});

		it('CLOSEs immediately when there is no resumption handle', () => {
			const h = makeHarness({ handle: null });
			h.reconnector.triggerReconnect('transport-close');
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).toHaveBeenCalledWith('CLOSED');
		});

		it('CLOSEs on a failed reconnect attempt', async () => {
			const transport = fakeTransport({
				reconnect: vi.fn().mockRejectedValue(new Error('boom')),
			});
			const h = makeHarness({ transport });
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.reportError).toHaveBeenCalledWith('reconnect', expect.any(Error));
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('CLOSED');
		});

		it('no-ops when the session is not ACTIVE', () => {
			const h = makeHarness({ initial: 'RECONNECTING' });
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.transitionTo).not.toHaveBeenCalled();
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('resetAttempts restores the budget after a healthy turn completion', async () => {
			const h = makeHarness({});
			// Spend the whole budget.
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			// Budget exhausted → next trigger gives up.
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('CLOSED');

			// Healthy turn → reset → reconnect works again with the 1000ms backoff.
			// (A healthy completion implies the session is ACTIVE again.)
			h.sm._setState('ACTIVE');
			h.reconnector.resetAttempts();
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(4);
		});
	});

	describe('response watchdog', () => {
		it('arms on user-turn-complete, fires, and forces a triggerReconnect', async () => {
			const h = makeHarness({ watchdogMs: 8000 });
			h.reconnector.armResponseWatchdog();
			expect(h.transport.reconnect).not.toHaveBeenCalled();

			vi.advanceTimersByTime(8000); // watchdog fires → triggerReconnect('response-watchdog', true)
			vi.advanceTimersByTime(1000); // backoff
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
		});

		it('re-elicits a response after a watchdog-driven reconnect (agent mode)', async () => {
			const h = makeHarness({ watchdogMs: 8000, agentMode: true });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(8000);
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.transport.elicitResponse).toHaveBeenCalledTimes(1);
		});

		it('does not arm when not in agent mode', () => {
			const h = makeHarness({ watchdogMs: 8000, agentMode: false });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('does not arm when watchdog is disabled (<= 0)', () => {
			const h = makeHarness({ watchdogMs: 0 });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('disarm cancels a pending watchdog (model showed activity)', () => {
			const h = makeHarness({ watchdogMs: 8000 });
			h.reconnector.armResponseWatchdog();
			h.reconnector.disarmResponseWatchdog();
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('falls back to triggerGeneration when the transport cannot elicit', async () => {
			const transport = fakeTransport({ elicitResponse: undefined });
			const h = makeHarness({ watchdogMs: 8000, transport });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(8000);
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(transport.triggerGeneration).toHaveBeenCalledTimes(1);
		});

		it('survives a throwing re-elicit nudge (best-effort) and stays reconnected', async () => {
			const transport = fakeTransport({
				elicitResponse: vi.fn(() => {
					throw new Error('half-open');
				}),
			});
			const h = makeHarness({ watchdogMs: 8000, transport });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(8000);
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(transport.reconnect).toHaveBeenCalledTimes(1);
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});
	});

	describe('handleGoAway (immediate, unbudgeted)', () => {
		it('disarms the watchdog, publishes session.goaway, and reconnects immediately', async () => {
			const buffered = [Buffer.from('x')];
			const ct = fakeClientTransport(buffered);
			const h = makeHarness({ watchdogMs: 8000, clientTransport: ct });
			h.reconnector.armResponseWatchdog();

			h.reconnector.handleGoAway('5s');
			expect(h.eventBus.publish).toHaveBeenCalledWith('session.goaway', {
				sessionId: 'sess_1',
				timeLeft: '5s',
			});
			// Immediate — no backoff timer needed before reconnect().
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			expect(ct.startBuffering).toHaveBeenCalledTimes(1);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');

			// The armed watchdog was disarmed by GoAway — it must not also fire.
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
		});

		it('GoAway is unbudgeted: it reconnects even after triggerReconnect spent the budget', async () => {
			const h = makeHarness({});
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);

			// triggerReconnect now gives up (budget spent)…
			h.reconnector.triggerReconnect('transport-close');
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);

			// …but GoAway still reconnects immediately (its own path, no budget).
			h.reconnector.handleGoAway('3s');
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(4);
		});

		it('does not reconnect when there is no resumption handle', () => {
			const h = makeHarness({ handle: null });
			h.reconnector.handleGoAway('5s');
			expect(h.eventBus.publish).toHaveBeenCalledWith(
				'session.goaway',
				expect.objectContaining({ sessionId: 'sess_1' }),
			);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});
	});

	describe('handleResumptionUpdate', () => {
		it('caches the handle on a resumable update', () => {
			const h = makeHarness({});
			h.reconnector.handleResumptionUpdate('handle-2', true);
			expect(h.sm.updateResumptionHandle).toHaveBeenCalledWith('handle-2');
			expect(h.sm.clearResumptionHandle).not.toHaveBeenCalled();
		});

		it('clears the cache on a non-resumable update', () => {
			const h = makeHarness({});
			h.reconnector.handleResumptionUpdate('handle-2', false);
			expect(h.sm.clearResumptionHandle).toHaveBeenCalledTimes(1);
			expect(h.sm.updateResumptionHandle).not.toHaveBeenCalled();
		});
	});

	describe('handleTransportClose', () => {
		it('routes through triggerReconnect (budgeted path)', async () => {
			const h = makeHarness({});
			h.reconnector.handleTransportClose(1006, 'gone');
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
		});
	});
});
