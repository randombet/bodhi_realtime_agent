// SPDX-License-Identifier: MIT

/**
 * Tests for `BackgroundAgentSupervisorActor`
 * (`src/runtime/actors/background-agent-supervisor-actor.ts`).
 *
 * Covers the lifecycle table from the design doc:
 *   - Deferred first onStart on session.connected.
 *   - onReconnect on session.reconnected.
 *   - onAgentTransfer always invoked; onStop('transfer') only when
 *     cancelOnTransfer === true.
 *   - onStop on session.close_requested / transport.closed.
 *   - cache.phase / cache.activeAgent reflected in BackgroundAgentContext.session.
 *   - ctx.publish correlationId precedence: caller-supplied wins, else
 *     synthesized as `${sessionId}-${agent.name}-${randomId}`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BackgroundAgent, BackgroundAgentContext } from '../../src/agent/background-agent.js';
import type { ActorSendOptions } from '../../src/runtime/actor-send-fn.js';
import { BackgroundAgentSupervisorActor } from '../../src/runtime/actors/background-agent-supervisor-actor.js';
import type { ActorId } from '../../src/runtime/envelope.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import type { RuntimeMessage } from '../../src/runtime/messages.js';

interface RecordedSend {
	type: RuntimeMessage['type'];
	payload: unknown;
	to: ActorId;
	options?: ActorSendOptions;
}

function makeSupervisor(
	agents: BackgroundAgent[],
	overrides: { sessionId?: string; userId?: string; initialAgent?: string } = {},
) {
	const sends: RecordedSend[] = [];
	const sendMessage = vi.fn(
		(type: RuntimeMessage['type'], payload: unknown, to: ActorId, options?: ActorSendOptions) => {
			sends.push({ type, payload, to, options });
		},
	);
	const supervisor = new BackgroundAgentSupervisorActor(
		'background-agents',
		sendMessage,
		'notification',
		agents,
		{
			sessionId: overrides.sessionId ?? 'sess-1',
			userId: overrides.userId ?? 'user-1',
			initialAgent: overrides.initialAgent ?? 'main',
		},
	);
	return { supervisor, sends };
}

async function tell(
	supervisor: BackgroundAgentSupervisorActor,
	type: RuntimeMessage['type'],
	payload: unknown,
) {
	await supervisor.onMessage(createEnvelope(type, payload, 'background-agents'));
}

// ---------------------------------------------------------------------------
// Lifecycle: deferred first onStart
// ---------------------------------------------------------------------------

describe('BackgroundAgentSupervisorActor — deferred first onStart', () => {
	it('does NOT call agent.onStart at construction time', () => {
		const onStart = vi.fn();
		const agent: BackgroundAgent = { name: 'a', onStart };
		makeSupervisor([agent]);
		expect(onStart).not.toHaveBeenCalled();
	});

	it('calls agent.onStart exactly once on the first session.connected envelope', async () => {
		const onStart = vi.fn();
		const agent: BackgroundAgent = { name: 'a', onStart };
		const { supervisor } = makeSupervisor([agent]);

		await tell(supervisor, 'session.connected', {});
		expect(onStart).toHaveBeenCalledTimes(1);

		// Subsequent session.connected (which the strict gating in step 1.4
		// fix prevents from being emitted, but we test defensively here)
		// must NOT re-fire onStart.
		await tell(supervisor, 'session.connected', {});
		expect(onStart).toHaveBeenCalledTimes(1);
	});

	it('starts every registered agent on session.connected', async () => {
		const startA = vi.fn();
		const startB = vi.fn();
		const a: BackgroundAgent = { name: 'a', onStart: startA };
		const b: BackgroundAgent = { name: 'b', onStart: startB };
		const { supervisor } = makeSupervisor([a, b]);

		await tell(supervisor, 'session.connected', {});
		expect(startA).toHaveBeenCalledTimes(1);
		expect(startB).toHaveBeenCalledTimes(1);
	});

	it('isolates onStart throws — other agents still start', async () => {
		const startA = vi.fn(() => {
			throw new Error('boom');
		});
		const startB = vi.fn();
		const a: BackgroundAgent = { name: 'a', onStart: startA };
		const b: BackgroundAgent = { name: 'b', onStart: startB };
		const { supervisor } = makeSupervisor([a, b]);

		await tell(supervisor, 'session.connected', {});
		expect(startA).toHaveBeenCalledTimes(1);
		expect(startB).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Lifecycle: reconnect, transfer, close
// ---------------------------------------------------------------------------

describe('BackgroundAgentSupervisorActor — reconnect', () => {
	it('does NOT call onReconnect before onStart has fired (deferred lifecycle)', async () => {
		const onReconnect = vi.fn();
		const agent: BackgroundAgent = { name: 'a', onStart: vi.fn(), onReconnect };
		const { supervisor } = makeSupervisor([agent]);

		// session.reconnected without prior session.connected — agent isn't running.
		await tell(supervisor, 'session.reconnected', {});
		expect(onReconnect).not.toHaveBeenCalled();
	});

	it('calls onReconnect on running agents only', async () => {
		const onReconnect = vi.fn();
		const agent: BackgroundAgent = { name: 'a', onStart: vi.fn(), onReconnect };
		const { supervisor } = makeSupervisor([agent]);

		await tell(supervisor, 'session.connected', {});
		await tell(supervisor, 'session.reconnected', {});
		expect(onReconnect).toHaveBeenCalledTimes(1);
	});

	it('skips agents whose onReconnect is undefined', async () => {
		const startedAgent: BackgroundAgent = { name: 'no-reconnect', onStart: vi.fn() };
		const { supervisor } = makeSupervisor([startedAgent]);
		await tell(supervisor, 'session.connected', {});
		// Should not throw even though onReconnect is undefined.
		await tell(supervisor, 'session.reconnected', {});
	});
});

describe('BackgroundAgentSupervisorActor — agent transfer', () => {
	it('invokes onAgentTransfer on every running agent regardless of cancelOnTransfer', async () => {
		const transferA = vi.fn();
		const transferB = vi.fn();
		const a: BackgroundAgent = { name: 'a', onStart: vi.fn(), onAgentTransfer: transferA };
		const b: BackgroundAgent = {
			name: 'b',
			cancelOnTransfer: true,
			onStart: vi.fn(),
			onStop: vi.fn(),
			onAgentTransfer: transferB,
		};
		const { supervisor } = makeSupervisor([a, b]);
		await tell(supervisor, 'session.connected', {});

		await tell(supervisor, 'agent.transfer_completed', {
			fromAgent: 'main',
			toAgent: 'specialist',
			transferCorrelationId: 't-1',
		});

		expect(transferA).toHaveBeenCalledWith({ fromAgent: 'main', toAgent: 'specialist' });
		expect(transferB).toHaveBeenCalledWith({ fromAgent: 'main', toAgent: 'specialist' });
	});

	it('aborts signal + calls onStop("transfer") only when cancelOnTransfer === true', async () => {
		const stopA = vi.fn();
		const stopB = vi.fn();
		let signalA: AbortSignal | null = null;
		let signalB: AbortSignal | null = null;
		const a: BackgroundAgent = {
			name: 'a',
			onStart: (ctx) => {
				signalA = ctx.signal;
			},
			onStop: stopA,
		};
		const b: BackgroundAgent = {
			name: 'b',
			cancelOnTransfer: true,
			onStart: (ctx) => {
				signalB = ctx.signal;
			},
			onStop: stopB,
		};
		const { supervisor } = makeSupervisor([a, b]);
		await tell(supervisor, 'session.connected', {});

		await tell(supervisor, 'agent.transfer_completed', {
			fromAgent: 'main',
			toAgent: 'specialist',
			transferCorrelationId: 't-1',
		});

		// a: cancelOnTransfer=false → not stopped, signal not aborted.
		expect(stopA).not.toHaveBeenCalled();
		expect(signalA?.aborted).toBe(false);

		// b: cancelOnTransfer=true → stopped with reason='transfer', signal aborted.
		expect(stopB).toHaveBeenCalledWith('transfer');
		expect(signalB?.aborted).toBe(true);
	});

	it('updates cache.activeAgent so subsequent ctx.session reads see the new value', async () => {
		let observedActiveBefore = '';
		let observedActiveAfter = '';
		const agent: BackgroundAgent = {
			name: 'observer',
			onStart: (ctx) => {
				observedActiveBefore = ctx.session.activeAgent;
				// Capture a closure that reads later.
				const later = () => {
					observedActiveAfter = ctx.session.activeAgent;
				};
				(agent as { _readLater?: () => void })._readLater = later;
			},
		};
		const { supervisor } = makeSupervisor([agent], { initialAgent: 'main' });
		await tell(supervisor, 'session.connected', {});
		expect(observedActiveBefore).toBe('main');

		await tell(supervisor, 'agent.transfer_completed', {
			fromAgent: 'main',
			toAgent: 'specialist',
			transferCorrelationId: 't-1',
		});

		(agent as { _readLater?: () => void })._readLater?.();
		expect(observedActiveAfter).toBe('specialist');
	});
});

describe('BackgroundAgentSupervisorActor — onStop', () => {
	it('aborts signal + calls onStop on session.close_requested with the reason', async () => {
		const stop = vi.fn();
		let signal: AbortSignal | null = null;
		const agent: BackgroundAgent = {
			name: 'a',
			onStart: (ctx) => {
				signal = ctx.signal;
			},
			onStop: stop,
		};
		const { supervisor } = makeSupervisor([agent]);
		await tell(supervisor, 'session.connected', {});

		await tell(supervisor, 'session.close_requested', { reason: 'user-initiated' });

		expect(stop).toHaveBeenCalledWith('user-initiated');
		expect(signal?.aborted).toBe(true);
	});

	it('aborts signal + calls onStop on transport.closed with the reason', async () => {
		const stop = vi.fn();
		const agent: BackgroundAgent = { name: 'a', onStart: vi.fn(), onStop: stop };
		const { supervisor } = makeSupervisor([agent]);
		await tell(supervisor, 'session.connected', {});

		await tell(supervisor, 'transport.closed', { reason: 'remote-hangup' });

		expect(stop).toHaveBeenCalledWith('remote-hangup');
	});

	it('falls back to a generic reason when none is supplied', async () => {
		const stop = vi.fn();
		const agent: BackgroundAgent = { name: 'a', onStart: vi.fn(), onStop: stop };
		const { supervisor } = makeSupervisor([agent]);
		await tell(supervisor, 'session.connected', {});

		await tell(supervisor, 'session.close_requested', {});

		expect(stop).toHaveBeenCalledWith('session_close_requested');
	});

	it('cache.phase becomes closed after close_requested', async () => {
		let observedPhase = 'unknown';
		const agent: BackgroundAgent = {
			name: 'a',
			onStart: (ctx) => {
				observedPhase = ctx.session.phase;
				const later = () => {
					observedPhase = ctx.session.phase;
				};
				(agent as { _readLater?: () => void })._readLater = later;
			},
		};
		const { supervisor } = makeSupervisor([agent]);
		await tell(supervisor, 'session.connected', {});
		expect(observedPhase).toBe('active');

		await tell(supervisor, 'session.close_requested', { reason: 'done' });
		(agent as { _readLater?: () => void })._readLater?.();
		expect(observedPhase).toBe('closed');
	});

	it('skips agents that are already stopped', async () => {
		const stop = vi.fn();
		const agent: BackgroundAgent = {
			name: 'a',
			cancelOnTransfer: true,
			onStart: vi.fn(),
			onStop: stop,
		};
		const { supervisor } = makeSupervisor([agent]);
		await tell(supervisor, 'session.connected', {});
		await tell(supervisor, 'agent.transfer_completed', {
			fromAgent: 'main',
			toAgent: 'specialist',
			transferCorrelationId: 't-1',
		});
		expect(stop).toHaveBeenCalledTimes(1); // 'transfer'

		await tell(supervisor, 'session.close_requested', { reason: 'done' });
		// Should NOT invoke onStop again — already stopped.
		expect(stop).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// ctx.publish correlationId precedence
// ---------------------------------------------------------------------------

describe('BackgroundAgentSupervisorActor — ctx.publish', () => {
	it('forwards a publish with the supplied label/text/priority/dedupKey to NotificationActor', async () => {
		let published = false;
		const agent: BackgroundAgent = {
			name: 'reminder',
			onStart: (ctx) => {
				ctx.publish({
					label: 'TIME REMINDER',
					text: '5 min left',
					priority: 'high',
					dedupKey: 'time',
				});
				published = true;
			},
		};
		const { supervisor, sends } = makeSupervisor([agent]);
		await tell(supervisor, 'session.connected', {});
		expect(published).toBe(true);

		const publish = sends.find((s) => s.type === 'notification.publish');
		expect(publish).toBeDefined();
		expect(publish?.to).toBe('notification');
		expect(publish?.payload).toEqual({
			label: 'TIME REMINDER',
			text: '5 min left',
			priority: 'high',
			dedupKey: 'time',
		});
	});

	it('synthesizes correlationId when caller does not supply one', async () => {
		const agent: BackgroundAgent = {
			name: 'reminder',
			onStart: (ctx) => {
				ctx.publish({ label: 'SYSTEM', text: 't' });
			},
		};
		const { supervisor, sends } = makeSupervisor([agent], { sessionId: 'sess-42' });
		await tell(supervisor, 'session.connected', {});

		const publish = sends.find((s) => s.type === 'notification.publish');
		expect(publish?.options?.correlationId).toMatch(/^sess-42-reminder-[a-z0-9]+$/);
	});

	it('caller-supplied correlationId wins over the synthesized one', async () => {
		const agent: BackgroundAgent = {
			name: 'reminder',
			onStart: (ctx) => {
				ctx.publish({
					label: 'SYSTEM',
					text: 't',
					correlationId: 'caller-trace-xyz',
				});
			},
		};
		const { supervisor, sends } = makeSupervisor([agent]);
		await tell(supervisor, 'session.connected', {});

		const publish = sends.find((s) => s.type === 'notification.publish');
		expect(publish?.options?.correlationId).toBe('caller-trace-xyz');
		// And correlationId is NOT in the payload (envelope-only).
		expect(publish?.payload).not.toHaveProperty('correlationId');
	});
});
