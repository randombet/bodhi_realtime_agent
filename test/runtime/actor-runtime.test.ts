// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../../src/runtime/actor-runtime.js';
import { ActorRuntime } from '../../src/runtime/actor-runtime.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import type { Envelope } from '../../src/runtime/envelope.js';
import { assertNever } from '../../src/runtime/messages.js';
import type { RuntimeMessage } from '../../src/runtime/messages.js';
import { DEFAULT_POLICIES, Supervisor } from '../../src/runtime/supervisor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActor(
	id: string,
	handler?: (env: Envelope) => Promise<void>,
): Actor & { messages: Envelope[]; started: boolean; stopped: boolean; stopReason?: string } {
	const messages: Envelope[] = [];
	let started = false;
	let stopped = false;
	let stopReason: string | undefined;

	return {
		id,
		get messages() {
			return messages;
		},
		get started() {
			return started;
		},
		get stopped() {
			return stopped;
		},
		get stopReason() {
			return stopReason;
		},
		onStart: async () => {
			started = true;
		},
		onMessage: handler ?? (async (env) => messages.push(env)),
		onStop: async (reason) => {
			stopped = true;
			stopReason = reason;
		},
	};
}

function msg(type: string, to: string, from?: string): Envelope {
	return createEnvelope(type, {}, to, { from });
}

/** Wait for all pending microtasks/promises to resolve. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActorRuntime', () => {
	let runtime: ActorRuntime;

	beforeEach(() => {
		runtime = new ActorRuntime();
	});

	afterEach(async () => {
		await runtime.stopAll();
	});

	// -- Actor lifecycle -----------------------------------------------------

	describe('actor lifecycle', () => {
		it('calls onStart when starting an actor', async () => {
			const actor = makeActor('a1');
			await runtime.startActor(actor);
			expect(actor.started).toBe(true);
		});

		it('calls onStop when stopping an actor', async () => {
			const actor = makeActor('a1');
			await runtime.startActor(actor);
			await runtime.stopActor('a1', 'test-stop');
			expect(actor.stopped).toBe(true);
			expect(actor.stopReason).toBe('test-stop');
		});

		it('throws on duplicate actor registration', async () => {
			const actor = makeActor('a1');
			await runtime.startActor(actor);
			await expect(runtime.startActor(makeActor('a1'))).rejects.toThrow(
				'Actor "a1" is already registered',
			);
		});

		it('hasActor returns true for running actors', async () => {
			await runtime.startActor(makeActor('a1'));
			expect(runtime.hasActor('a1')).toBe(true);
			expect(runtime.hasActor('nonexistent')).toBe(false);
		});

		it('hasActor returns false after stop', async () => {
			await runtime.startActor(makeActor('a1'));
			await runtime.stopActor('a1');
			expect(runtime.hasActor('a1')).toBe(false);
		});

		it('stopAll stops all actors', async () => {
			const a1 = makeActor('a1');
			const a2 = makeActor('a2');
			await runtime.startActor(a1);
			await runtime.startActor(a2);
			await runtime.stopAll('shutdown');
			expect(a1.stopped).toBe(true);
			expect(a2.stopped).toBe(true);
		});
	});

	// -- Message delivery ----------------------------------------------------

	describe('message delivery', () => {
		it('delivers messages to the correct actor', async () => {
			const actor = makeActor('a1');
			await runtime.startActor(actor);

			runtime.send(msg('test.msg', 'a1'));
			await flush();

			expect(actor.messages).toHaveLength(1);
			expect(actor.messages[0].type).toBe('test.msg');
		});

		it('tell convenience creates and sends an envelope', async () => {
			const actor = makeActor('a1');
			await runtime.startActor(actor);

			runtime.tell('test.tell', { value: 42 }, 'a1', { from: 'sender' });
			await flush();

			expect(actor.messages).toHaveLength(1);
			expect(actor.messages[0].type).toBe('test.tell');
			expect(actor.messages[0].payload).toEqual({ value: 42 });
			expect(actor.messages[0].from).toBe('sender');
		});

		it('messages to non-existent actors are dead-lettered', async () => {
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			runtime.send(msg('test.msg', 'nonexistent'));
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('Dead letter'),
				// Could also check for actor name but pattern is sufficient
			);
			warnSpy.mockRestore();
		});
	});

	// -- Message ordering (serial) -------------------------------------------

	describe('per-actor message ordering', () => {
		it('messages are processed strictly in FIFO order', async () => {
			const order: number[] = [];
			const actor = makeActor('a1', async (env) => {
				order.push(env.payload as number);
				// Small async delay to test ordering
				await new Promise((r) => setTimeout(r, 1));
			});

			await runtime.startActor(actor);

			runtime.send(createEnvelope('test', 1, 'a1'));
			runtime.send(createEnvelope('test', 2, 'a1'));
			runtime.send(createEnvelope('test', 3, 'a1'));

			await flush();
			// Wait a bit more for all to process
			await new Promise((r) => setTimeout(r, 50));

			expect(order).toEqual([1, 2, 3]);
		});

		it('messages are serialized — no concurrent processing', async () => {
			let concurrent = 0;
			let maxConcurrent = 0;

			const actor = makeActor('a1', async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 5));
				concurrent--;
			});

			await runtime.startActor(actor);

			runtime.send(msg('a', 'a1'));
			runtime.send(msg('b', 'a1'));
			runtime.send(msg('c', 'a1'));

			await new Promise((r) => setTimeout(r, 100));

			expect(maxConcurrent).toBe(1);
		});
	});

	// -- Mailbox depth -------------------------------------------------------

	describe('mailbox depth', () => {
		it('reports queue depth for an actor', async () => {
			// Use a slow handler to accumulate messages
			let resolveFirst: (() => void) | undefined;
			const blocker = new Promise<void>((r) => {
				resolveFirst = r;
			});
			let messageCount = 0;

			const actor = makeActor('a1', async () => {
				messageCount++;
				if (messageCount === 1) await blocker;
			});

			await runtime.startActor(actor);

			runtime.send(msg('first', 'a1'));
			await flush(); // first message starts processing

			runtime.send(msg('second', 'a1'));
			runtime.send(msg('third', 'a1'));

			// Two messages queued while first is processing
			expect(runtime.getMailboxDepth('a1')).toBe(2);

			resolveFirst?.();
			await new Promise((r) => setTimeout(r, 50));

			expect(runtime.getMailboxDepth('a1')).toBe(0);
		});

		it('returns 0 for non-existent actors', () => {
			expect(runtime.getMailboxDepth('nonexistent')).toBe(0);
		});
	});
});

// ---------------------------------------------------------------------------
// Supervisor tests
// ---------------------------------------------------------------------------

describe('Supervisor', () => {
	let supervisor: Supervisor;

	beforeEach(() => {
		supervisor = new Supervisor();
	});

	describe('policy-based decisions', () => {
		it('resume policy returns resume action', () => {
			supervisor.registerPolicy('tool-router', { defaultAction: 'resume' });
			const decision = supervisor.handleFailure(
				'tool-router',
				new Error('bad msg'),
				msg('test', 'tool-router'),
			);
			expect(decision.action).toBe('resume');
		});

		it('escalate policy returns escalate action with target', () => {
			supervisor.registerPolicy('session', {
				defaultAction: 'escalate',
				escalateTo: 'system',
			});
			const decision = supervisor.handleFailure(
				'session',
				new Error('fatal'),
				msg('test', 'session'),
			);
			expect(decision.action).toBe('escalate');
			expect(decision.escalateTo).toBe('system');
		});

		it('stop policy returns stop action', () => {
			supervisor.registerPolicy('doomed', { defaultAction: 'stop' });
			const decision = supervisor.handleFailure('doomed', new Error('bye'), msg('test', 'doomed'));
			expect(decision.action).toBe('stop');
		});

		it('restart policy returns restart on first failure', () => {
			supervisor.registerPolicy('transport', {
				defaultAction: 'restart',
				maxRestarts: 3,
				restartWindow: 60_000,
			});
			const decision = supervisor.handleFailure(
				'transport',
				new Error('disconnect'),
				msg('test', 'transport'),
			);
			expect(decision.action).toBe('restart');
		});

		it('unknown actor defaults to resume', () => {
			const decision = supervisor.handleFailure(
				'unknown',
				new Error('oops'),
				msg('test', 'unknown'),
			);
			expect(decision.action).toBe('resume');
		});
	});

	describe('restart limit escalation', () => {
		it('escalates after exceeding max restarts within window', () => {
			supervisor.registerPolicy('transport', {
				defaultAction: 'restart',
				maxRestarts: 2,
				restartWindow: 60_000,
				escalateTo: 'session',
			});

			const env = msg('test', 'transport');

			// First and second restarts succeed
			expect(supervisor.handleFailure('transport', new Error(), env).action).toBe('restart');
			expect(supervisor.handleFailure('transport', new Error(), env).action).toBe('restart');

			// Third exceeds limit → escalate
			const decision = supervisor.handleFailure('transport', new Error(), env);
			expect(decision.action).toBe('escalate');
			expect(decision.escalateTo).toBe('session');
		});
	});

	describe('default policy presets', () => {
		it('defines expected policies for all actor types', () => {
			expect(DEFAULT_POLICIES.session.defaultAction).toBe('escalate');
			expect(DEFAULT_POLICIES.transport.defaultAction).toBe('restart');
			expect(DEFAULT_POLICIES['tool-router'].defaultAction).toBe('resume');
			expect(DEFAULT_POLICIES['subagent-supervisor'].defaultAction).toBe('resume');
			expect(DEFAULT_POLICIES.subagent.defaultAction).toBe('resume');
			expect(DEFAULT_POLICIES['main-agent'].defaultAction).toBe('resume');
			expect(DEFAULT_POLICIES['client-gateway'].defaultAction).toBe('resume');
		});
	});
});

// ---------------------------------------------------------------------------
// Supervisor integration with runtime
// ---------------------------------------------------------------------------

describe('ActorRuntime + Supervisor integration', () => {
	it('restart policy reinitializes actor on failure', async () => {
		const runtime = new ActorRuntime();
		const supervisor = new Supervisor();
		runtime.setSupervisor(supervisor);

		let startCount = 0;
		let messageIdx = 0;

		const actor = makeActor('transport', async () => {
			messageIdx++;
			if (messageIdx === 1) throw new Error('transient failure');
		});
		// Override onStart to track restart
		actor.onStart = async () => {
			startCount++;
		};

		supervisor.registerPolicy('transport', {
			defaultAction: 'restart',
			maxRestarts: 3,
			restartWindow: 60_000,
		});

		await runtime.startActor(actor);
		expect(startCount).toBe(1);

		// Send a message that will fail
		runtime.send(msg('trigger', 'transport'));
		await new Promise((r) => setTimeout(r, 50));

		// Actor should have been restarted
		expect(startCount).toBe(2);

		await runtime.stopAll();
	});

	it('resume policy continues processing after failure', async () => {
		const runtime = new ActorRuntime();
		const supervisor = new Supervisor();
		runtime.setSupervisor(supervisor);

		const processed: string[] = [];
		let callIdx = 0;

		const actor = makeActor('tool-router', async (env) => {
			callIdx++;
			if (callIdx === 1) throw new Error('bad message');
			processed.push(env.type);
		});

		supervisor.registerPolicy('tool-router', { defaultAction: 'resume' });

		await runtime.startActor(actor);

		// First message fails, second should succeed
		runtime.send(msg('bad', 'tool-router'));
		runtime.send(msg('good', 'tool-router'));

		await new Promise((r) => setTimeout(r, 50));

		expect(processed).toEqual(['good']);

		await runtime.stopAll();
	});
});

// ---------------------------------------------------------------------------
// Messages: exhaustiveness helper
// ---------------------------------------------------------------------------

describe('RuntimeMessage exhaustiveness', () => {
	it('assertNever throws for unhandled message types', () => {
		const fakeMsg = { type: 'unknown.message' } as RuntimeMessage;
		expect(() => assertNever(fakeMsg as never)).toThrow('Unhandled message type');
	});
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

describe('createEnvelope', () => {
	it('creates an envelope with all fields', () => {
		const env = createEnvelope('test.msg', { data: 1 }, 'actor-1', {
			from: 'actor-0',
			correlationId: 'corr-1',
			causationId: 'cause-1',
		});

		expect(env.type).toBe('test.msg');
		expect(env.payload).toEqual({ data: 1 });
		expect(env.to).toBe('actor-1');
		expect(env.from).toBe('actor-0');
		expect(env.correlationId).toBe('corr-1');
		expect(env.causationId).toBe('cause-1');
		expect(typeof env.at).toBe('number');
	});

	it('creates an envelope with minimal fields', () => {
		const env = createEnvelope('test.minimal', null, 'actor-1');

		expect(env.type).toBe('test.minimal');
		expect(env.to).toBe('actor-1');
		expect(env.from).toBeUndefined();
		expect(env.correlationId).toBeUndefined();
	});
});
