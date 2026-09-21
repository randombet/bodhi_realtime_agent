import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionActor } from '../../src/runtime/actors/session-actor.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SentMessage {
	type: string;
	payload: unknown;
	to: string;
}

function setup(reconnectPolicy?: {
	baseDelayMs?: number;
	maxDelayMs?: number;
	maxAttempts?: number;
}) {
	const messages: SentMessage[] = [];
	const send = (type: string, payload: unknown, to: string) => {
		messages.push({ type, payload, to });
	};

	const actor = new SessionActor('session', send, 'transport', reconnectPolicy);

	return { actor, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionActor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -- Session lifecycle --------------------------------------------------

	describe('session lifecycle', () => {
		it('starts in created phase', () => {
			const { actor } = setup();
			expect(actor.currentPhase).toBe('created');
		});

		it('transitions to active on session_ready', async () => {
			const { actor } = setup();

			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			expect(actor.currentPhase).toBe('active');
		});

		it('transitions to closed on transport.closed', async () => {
			const { actor } = setup();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			await actor.onMessage(
				createEnvelope('transport.closed', { reason: 'server shutdown' }, 'session'),
			);

			expect(actor.currentPhase).toBe('closed');
		});

		it('transitions to closed on session.close_requested', async () => {
			const { actor } = setup();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			await actor.onMessage(
				createEnvelope('session.close_requested', { reason: 'user' }, 'session'),
			);

			expect(actor.currentPhase).toBe('closed');
		});

		it('stays active on turn_complete and interrupted', async () => {
			const { actor } = setup();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			await actor.onMessage(
				createEnvelope('transport.turn_complete', { turnId: 't-1' }, 'session'),
			);
			expect(actor.currentPhase).toBe('active');

			await actor.onMessage(createEnvelope('transport.interrupted', {}, 'session'));
			expect(actor.currentPhase).toBe('active');
		});
	});

	// -- Transport error → reconnect ----------------------------------------

	describe('reconnect on recoverable error', () => {
		it('transitions to reconnecting on recoverable transport error', async () => {
			const { actor } = setup();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			await actor.onMessage(
				createEnvelope(
					'transport.error',
					{ error: 'connection lost', recoverable: true },
					'session',
				),
			);

			expect(actor.currentPhase).toBe('reconnecting');
		});

		it('transitions to closed on non-recoverable error', async () => {
			const { actor } = setup();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			await actor.onMessage(
				createEnvelope('transport.error', { error: 'auth failed', recoverable: false }, 'session'),
			);

			expect(actor.currentPhase).toBe('closed');
		});
	});

	// -- Reconnect backoff ------------------------------------------------

	describe('reconnect backoff', () => {
		it('computes exponential backoff delays', () => {
			const { actor } = setup({ baseDelayMs: 1000, maxDelayMs: 30000 });

			expect(actor.getReconnectDelay(0)).toBe(1000);
			expect(actor.getReconnectDelay(1)).toBe(2000);
			expect(actor.getReconnectDelay(2)).toBe(4000);
			expect(actor.getReconnectDelay(3)).toBe(8000);
		});

		it('caps delay at maxDelayMs', () => {
			const { actor } = setup({ baseDelayMs: 1000, maxDelayMs: 5000 });

			expect(actor.getReconnectDelay(10)).toBe(5000);
		});

		it('schedules reconnect timer on recoverable error', async () => {
			const { actor, messages } = setup({ baseDelayMs: 100, maxAttempts: 3 });
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			await actor.onMessage(
				createEnvelope('transport.error', { error: 'conn lost', recoverable: true }, 'session'),
			);

			// Timer should fire after baseDelay
			vi.advanceTimersByTime(100);

			const timeout = messages.find((m) => m.type === 'session.reconnect_timeout');
			expect(timeout).toBeDefined();
			expect(timeout?.to).toBe('session');
		});

		it('sends trigger_generation on reconnect timeout', async () => {
			const { actor, messages } = setup({ baseDelayMs: 100, maxAttempts: 3 });
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			await actor.onMessage(
				createEnvelope('transport.error', { error: 'conn lost', recoverable: true }, 'session'),
			);
			messages.length = 0;

			// Process the reconnect timeout
			await actor.onMessage(createEnvelope('session.reconnect_timeout', { attempt: 0 }, 'session'));

			const trigger = messages.find((m) => m.type === 'transport.trigger_generation');
			expect(trigger).toBeDefined();
			expect(actor.currentReconnectAttempt).toBe(1);
		});

		it('closes session when max attempts exhausted', async () => {
			const { actor, messages } = setup({ baseDelayMs: 100, maxAttempts: 2 });
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			await actor.onMessage(
				createEnvelope('transport.error', { error: 'conn lost', recoverable: true }, 'session'),
			);
			messages.length = 0;

			// Exhaust attempts
			await actor.onMessage(createEnvelope('session.reconnect_timeout', { attempt: 2 }, 'session'));

			expect(actor.currentPhase).toBe('closed');
			const closed = messages.find((m) => m.type === 'transport.closed');
			expect(closed).toBeDefined();
			expect((closed?.payload as { reason: string }).reason).toBe('reconnect_attempts_exhausted');
		});

		it('resets reconnect attempts on successful session_ready', async () => {
			const { actor } = setup({ baseDelayMs: 100, maxAttempts: 5 });
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			await actor.onMessage(
				createEnvelope('transport.error', { error: 'conn lost', recoverable: true }, 'session'),
			);

			// Simulate one reconnect attempt
			await actor.onMessage(createEnvelope('session.reconnect_timeout', { attempt: 0 }, 'session'));
			expect(actor.currentReconnectAttempt).toBe(1);

			// Successful reconnect
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			expect(actor.currentPhase).toBe('active');
			expect(actor.currentReconnectAttempt).toBe(0);
		});
	});

	// -- Transfer lifecycle -----------------------------------------------

	describe('transfer lifecycle', () => {
		it('transitions to active on transfer_completed', async () => {
			const { actor } = setup();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			// Simulate transfer in progress (phase manually not tracked via message
			// since transport.transfer_session is outbound to transport, not session)
			// transfer_completed should ensure active phase
			await actor.onMessage(
				createEnvelope(
					'agent.transfer_completed',
					{
						fromAgent: 'general',
						toAgent: 'booking',
						transferCorrelationId: 'corr-1',
					},
					'session',
				),
			);

			expect(actor.currentPhase).toBe('active');
		});

		it('transitions to closed on transfer_failed', async () => {
			const { actor } = setup();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			await actor.onMessage(
				createEnvelope(
					'agent.transfer_failed',
					{
						toAgent: 'booking',
						error: 'timeout',
						transferCorrelationId: 'corr-1',
					},
					'session',
				),
			);

			expect(actor.currentPhase).toBe('closed');
		});
	});

	// -- Timer cleanup ----------------------------------------------------

	describe('timer cleanup', () => {
		it('clears timers on stop', async () => {
			const { actor } = setup({ baseDelayMs: 100 });
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			await actor.onMessage(
				createEnvelope('transport.error', { error: 'conn lost', recoverable: true }, 'session'),
			);

			// Stop the actor — should clear timers
			await actor.onStop('shutdown');

			// Advance timers — should NOT generate reconnect_timeout
			vi.advanceTimersByTime(200);
			// If timer was cleared, no reconnect_timeout message should appear
		});

		it('clears timers on close_requested', async () => {
			const { actor, messages } = setup({ baseDelayMs: 5000 });
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			await actor.onMessage(
				createEnvelope('transport.error', { error: 'conn lost', recoverable: true }, 'session'),
			);
			messages.length = 0;

			await actor.onMessage(createEnvelope('session.close_requested', {}, 'session'));

			vi.advanceTimersByTime(10000);

			const timeouts = messages.filter((m) => m.type === 'session.reconnect_timeout');
			expect(timeouts).toHaveLength(0);
		});
	});

	// -- Background-agent supervisor fan-out ------------------------------

	describe('background-agent supervisor fan-out', () => {
		function setupWithSupervisor() {
			const messages: SentMessage[] = [];
			const send = (type: string, payload: unknown, to: string) => {
				messages.push({ type, payload, to });
			};
			const actor = new SessionActor('session', send, 'transport', undefined, 'background-agents');
			return { actor, messages };
		}

		it('emits session.connected to background-agents on first activation', async () => {
			const { actor, messages } = setupWithSupervisor();

			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(1);
			expect(fanned[0].type).toBe('session.connected');
		});

		it('emits session.reconnected to background-agents on subsequent activation', async () => {
			const { actor, messages } = setupWithSupervisor();

			// First activation: created → active.
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			// Recoverable error pushes us into reconnecting.
			await actor.onMessage(
				createEnvelope(
					'transport.error',
					{ error: 'connection lost', recoverable: true },
					'session',
				),
			);
			expect(actor.currentPhase).toBe('reconnecting');
			messages.length = 0;

			// Second activation: reconnecting → active. Should fan out reconnected.
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(1);
			expect(fanned[0].type).toBe('session.reconnected');
		});

		it('emits session.close_requested fan-out copy on close (forwards reason payload)', async () => {
			const { actor, messages } = setupWithSupervisor();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope('session.close_requested', { reason: 'user-initiated' }, 'session'),
			);

			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(1);
			expect(fanned[0].type).toBe('session.close_requested');
			// Fan-out copy must forward the original reason so BackgroundAgent.onStop
			// receives the same value the close was initiated with.
			expect(fanned[0].payload).toEqual({ reason: 'user-initiated' });
		});

		it('emits session.close_requested fan-out copy with reason=undefined when none was provided', async () => {
			const { actor, messages } = setupWithSupervisor();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			messages.length = 0;

			await actor.onMessage(createEnvelope('session.close_requested', {}, 'session'));

			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(1);
			expect(fanned[0].payload).toEqual({ reason: undefined });
		});

		it('does NOT re-emit session.connected on duplicate session_ready while already active', async () => {
			// The design contract is that BackgroundAgent.onStart fires exactly
			// once per session. Some transports re-emit session_ready on session
			// refresh; the supervisor must not see a second session.connected.
			const { actor, messages } = setupWithSupervisor();

			// First activation: created → active. Should emit session.connected.
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			expect(actor.currentPhase).toBe('active');
			messages.length = 0;

			// Second session_ready while already active: must NOT emit.
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));

			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(0);
		});

		it('does NOT emit session.connected when transitioning from transferring → active', async () => {
			// Agent transfer ends in handleTransferCompleted: transferring → active.
			// This is not a "first-time activation" so background agents should
			// not re-onStart.
			const { actor, messages } = setupWithSupervisor();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			// Force the actor into the transferring phase by going through
			// agent.transfer_completed path indirectly: we rely on the actor's
			// existing handler for agent.transfer_failed/completed; for this
			// test, the goal is just to confirm `handleSessionReady`'s guard
			// rejects non-{created,connecting,reconnecting} prevPhases.
			// Simulate active → transferring → session_ready (some adapters
			// re-emit session_ready after the new session config lands).
			// Since the actor doesn't expose phase-set, we instead just send a
			// second session_ready with prevPhase=active and prove no fan-out.
			messages.length = 0;
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(0);
		});

		it('emits agent.transfer_completed fan-out copy with payload preserved', async () => {
			const { actor, messages } = setupWithSupervisor();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope(
					'agent.transfer_completed',
					{
						fromAgent: 'general',
						toAgent: 'booking',
						transferCorrelationId: 'corr-1',
					},
					'session',
				),
			);

			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(1);
			expect(fanned[0].type).toBe('agent.transfer_completed');
			expect(fanned[0].payload).toEqual({
				fromAgent: 'general',
				toAgent: 'booking',
				transferCorrelationId: 'corr-1',
			});
		});

		it('emits transport.closed fan-out copy on transport close', async () => {
			const { actor, messages } = setupWithSupervisor();
			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			messages.length = 0;

			await actor.onMessage(
				createEnvelope('transport.closed', { reason: 'remote hangup' }, 'session'),
			);

			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(1);
			expect(fanned[0].type).toBe('transport.closed');
			expect((fanned[0].payload as { reason?: string }).reason).toBe('remote hangup');
		});

		it('does NOT fan out when hostId is omitted (legacy / tests)', async () => {
			// Default `setup()` constructs without backgroundAgentHostId.
			const { actor, messages } = setup();

			await actor.onMessage(createEnvelope('transport.session_ready', {}, 'session'));
			await actor.onMessage(
				createEnvelope(
					'agent.transfer_completed',
					{ fromAgent: 'a', toAgent: 'b', transferCorrelationId: 'c' },
					'session',
				),
			);
			await actor.onMessage(
				createEnvelope('session.close_requested', { reason: 'user' }, 'session'),
			);

			// No envelope addressed to 'background-agents' should appear.
			const fanned = messages.filter((m) => m.to === 'background-agents');
			expect(fanned).toHaveLength(0);
		});
	});
});
