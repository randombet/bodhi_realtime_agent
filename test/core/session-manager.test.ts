import { describe, expect, it, vi } from 'vitest';
import { SessionError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/event-bus.js';
import { HooksManager } from '../../src/core/hooks.js';
import { SessionManager, type SessionPostProcessing } from '../../src/core/session-manager.js';
import { InMemoryPostSessionPipeline } from '../../src/post-session/pipeline.js';
import {
	PostSessionProcessor,
	type PostSessionSnapshot,
	type PostSessionSnapshotBuilder,
} from '../../src/post-session/types.js';

function createManager(postSession?: SessionPostProcessing, managed?: boolean) {
	const eventBus = new EventBus();
	const hooks = new HooksManager();
	const mgr = new SessionManager(
		{ sessionId: 'sess_1', userId: 'user_1', initialAgent: 'general' },
		eventBus,
		hooks,
		postSession,
		managed,
	);
	return { mgr, eventBus, hooks };
}

const snapshotBuilder =
	(opts?: { throwOnBuild?: boolean }): PostSessionSnapshotBuilder =>
	(reason) => {
		if (opts?.throwOnBuild) throw new Error('snapshot build failed');
		const snapshot: PostSessionSnapshot = {
			sessionId: 'sess_1',
			userId: 'user_1',
			initialAgentName: 'general',
			finalAgentName: 'general',
			transferPath: ['general'],
			reason,
			startedAt: 0,
			endedAt: 1,
			durationMs: 1,
			conversation: { items: [] },
			metrics: { turnCount: 0, toolCallCount: 0, agentTransferCount: 0 },
		};
		return { snapshot, stores: {} };
	};

describe('SessionManager', () => {
	it('starts in CREATED state', () => {
		const { mgr } = createManager();
		expect(mgr.state).toBe('CREATED');
		expect(mgr.isActive).toBe(false);
		expect(mgr.isDisconnected).toBe(false);
	});

	describe('valid transitions', () => {
		it('CREATED → CONNECTING → ACTIVE', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			expect(mgr.state).toBe('CONNECTING');
			mgr.transitionTo('ACTIVE');
			expect(mgr.state).toBe('ACTIVE');
			expect(mgr.isActive).toBe(true);
		});

		it('ACTIVE → RECONNECTING → ACTIVE', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('RECONNECTING');
			expect(mgr.state).toBe('RECONNECTING');
			expect(mgr.isDisconnected).toBe(true);
			mgr.transitionTo('ACTIVE');
			expect(mgr.state).toBe('ACTIVE');
		});

		it('ACTIVE → TRANSFERRING → ACTIVE', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('TRANSFERRING');
			expect(mgr.state).toBe('TRANSFERRING');
			expect(mgr.isDisconnected).toBe(true);
			mgr.transitionTo('ACTIVE');
			expect(mgr.state).toBe('ACTIVE');
		});

		it('ACTIVE → CLOSED', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('CLOSED');
			expect(mgr.state).toBe('CLOSED');
		});

		it('CREATED → CLOSED (fatal)', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CLOSED');
			expect(mgr.state).toBe('CLOSED');
		});

		it('ACTIVE → UPSTREAM_LOST → RECONNECTING → ACTIVE is legal and fires no onSessionEnd', () => {
			const { mgr, eventBus, hooks } = createManager();
			const onSessionEnd = vi.fn();
			hooks.register({ onSessionEnd });
			const closed = vi.fn();
			eventBus.subscribe('session.close', closed);

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('UPSTREAM_LOST');
			expect(mgr.state).toBe('UPSTREAM_LOST');
			expect(mgr.isActive).toBe(false);
			expect(mgr.isDisconnected).toBe(true);
			mgr.transitionTo('RECONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(mgr.state).toBe('ACTIVE');
			expect(onSessionEnd).not.toHaveBeenCalled();
			expect(closed).not.toHaveBeenCalled();
		});

		it('CONNECTING → UPSTREAM_LOST → RECONNECTING → ACTIVE is legal', () => {
			const { mgr, eventBus } = createManager();
			const started = vi.fn();
			eventBus.subscribe('session.start', started);

			// A failed first dial parks the session before it was ever ACTIVE.
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('UPSTREAM_LOST');
			expect(mgr.startedAtMs).toBeNull();
			mgr.transitionTo('RECONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(mgr.state).toBe('ACTIVE');
			// The first activation still counts as the session start.
			expect(started).toHaveBeenCalledTimes(1);
			expect(mgr.startedAtMs).not.toBeNull();
		});

		it('CONNECTING → RECONNECTING → ACTIVE is legal and fires no onSessionEnd', () => {
			const { mgr, eventBus, hooks } = createManager();
			const onSessionEnd = vi.fn();
			hooks.register({ onSessionEnd });
			const closed = vi.fn();
			eventBus.subscribe('session.close', closed);
			const started = vi.fn();
			eventBus.subscribe('session.start', started);

			// A host recovery replaces the still-pending first dial.
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('RECONNECTING');
			expect(mgr.state).toBe('RECONNECTING');
			expect(mgr.isDisconnected).toBe(true);
			expect(mgr.startedAtMs).toBeNull();
			mgr.transitionTo('ACTIVE');

			expect(mgr.state).toBe('ACTIVE');
			expect(started).toHaveBeenCalledTimes(1);
			expect(onSessionEnd).not.toHaveBeenCalled();
			expect(closed).not.toHaveBeenCalled();
		});
	});

	describe('invalid transitions', () => {
		it('CREATED → ACTIVE throws', () => {
			const { mgr } = createManager();
			expect(() => mgr.transitionTo('ACTIVE')).toThrow(SessionError);
		});

		it('CLOSED → anything throws', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CLOSED');
			expect(() => mgr.transitionTo('CONNECTING')).toThrow(SessionError);
			expect(() => mgr.transitionTo('ACTIVE')).toThrow(SessionError);
		});

		it('CONNECTING → TRANSFERRING throws', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			expect(() => mgr.transitionTo('TRANSFERRING')).toThrow(SessionError);
		});
	});

	describe('events and hooks', () => {
		it('fires session.stateChange event on transition', () => {
			const { mgr, eventBus } = createManager();
			const handler = vi.fn();
			eventBus.subscribe('session.stateChange', handler);

			mgr.transitionTo('CONNECTING');

			expect(handler).toHaveBeenCalledWith({
				sessionId: 'sess_1',
				fromState: 'CREATED',
				toState: 'CONNECTING',
			});
		});

		it('fires onSessionStart hook on first ACTIVE', () => {
			const { mgr, hooks } = createManager();
			const onSessionStart = vi.fn();
			hooks.register({ onSessionStart });

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(onSessionStart).toHaveBeenCalledWith({
				sessionId: 'sess_1',
				userId: 'user_1',
				agentName: 'general',
			});
		});

		it('fires session.start event on first ACTIVE', () => {
			const { mgr, eventBus } = createManager();
			const handler = vi.fn();
			eventBus.subscribe('session.start', handler);

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(handler).toHaveBeenCalledOnce();
		});

		it('does not fire onSessionStart on reconnect ACTIVE', () => {
			const { mgr, hooks } = createManager();
			const onSessionStart = vi.fn();
			hooks.register({ onSessionStart });

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			onSessionStart.mockClear();

			mgr.transitionTo('RECONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(onSessionStart).not.toHaveBeenCalled();
		});

		it('fires onSessionEnd hook on CLOSED', () => {
			const { mgr, hooks } = createManager();
			const onSessionEnd = vi.fn();
			hooks.register({ onSessionEnd });

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('CLOSED');

			expect(onSessionEnd).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'sess_1',
					reason: 'normal',
				}),
			);
		});
	});

	describe('closeWithReason', () => {
		it('transitions to CLOSED and preserves the caller reason on onSessionEnd + session.close', () => {
			const { mgr, eventBus, hooks } = createManager();
			const onSessionEnd = vi.fn();
			const onClose = vi.fn();
			hooks.register({ onSessionEnd });
			eventBus.subscribe('session.close', onClose);

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.closeWithReason('reconnect_failed');

			expect(mgr.state).toBe('CLOSED');
			expect(onSessionEnd).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess_1', reason: 'reconnect_failed' }),
			);
			expect(onClose).toHaveBeenCalledWith({ sessionId: 'sess_1', reason: 'reconnect_failed' });
		});

		it('is idempotent — duplicate/re-entrant calls fire session.close exactly once', () => {
			const { mgr, eventBus } = createManager();
			const onClose = vi.fn();
			eventBus.subscribe('session.close', onClose);

			mgr.closeWithReason('user_hangup');
			mgr.closeWithReason('error'); // racing path — must be a no-op
			mgr.closeWithReason('timeout');

			expect(onClose).toHaveBeenCalledOnce();
			expect(onClose).toHaveBeenCalledWith({ sessionId: 'sess_1', reason: 'user_hangup' });
		});

		it('is a no-op when already CLOSED via direct transitionTo', () => {
			const { mgr, eventBus } = createManager();
			const onClose = vi.fn();
			eventBus.subscribe('session.close', onClose);

			mgr.transitionTo('CLOSED'); // legacy direct close → derives reason
			mgr.closeWithReason('user_hangup'); // already closed → no-op

			expect(onClose).toHaveBeenCalledOnce();
			expect(onClose).toHaveBeenCalledWith({ sessionId: 'sess_1', reason: 'CREATED' });
		});

		it('legacy transitionTo(CLOSED) still derives a reason when no caller reason set', () => {
			const { mgr, eventBus } = createManager();
			const onClose = vi.fn();
			eventBus.subscribe('session.close', onClose);

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('CLOSED');

			expect(onClose).toHaveBeenCalledWith({ sessionId: 'sess_1', reason: 'normal' });
		});
	});

	describe('pre-close finalizers + hook isolation', () => {
		it('runs registered finalizers before session.close publishes', async () => {
			const { mgr, eventBus } = createManager();
			const order: string[] = [];
			eventBus.subscribe('session.close', () => order.push('close'));
			mgr.registerPreCloseFinalizer(() => {
				order.push('finalizer-a');
			});
			mgr.registerPreCloseFinalizer(async () => {
				order.push('finalizer-b');
			});

			await mgr.closeWithReason('normal');

			expect(order).toEqual(['finalizer-a', 'finalizer-b', 'close']);
			expect(mgr.state).toBe('CLOSED');
		});

		it('a throwing finalizer is logged but session.close still fires', async () => {
			const { mgr, eventBus } = createManager();
			const onClose = vi.fn();
			eventBus.subscribe('session.close', onClose);
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mgr.registerPreCloseFinalizer(() => {
				throw new Error('finalizer boom');
			});

			await mgr.closeWithReason('normal');

			expect(onClose).toHaveBeenCalledOnce();
			expect(mgr.state).toBe('CLOSED');
			expect(spy).toHaveBeenCalled();
			spy.mockRestore();
		});

		it('a throwing onSessionEnd hook does not prevent session.close', () => {
			const { mgr, eventBus, hooks } = createManager();
			const onClose = vi.fn();
			eventBus.subscribe('session.close', onClose);
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			hooks.register({
				onSessionEnd: () => {
					throw new Error('hook boom');
				},
			});

			mgr.closeWithReason('normal');

			expect(onClose).toHaveBeenCalledOnce();
			expect(mgr.state).toBe('CLOSED');
			spy.mockRestore();
		});

		it('a throwing onSessionStart hook does not prevent session.start', () => {
			const { mgr, eventBus, hooks } = createManager();
			const onStart = vi.fn();
			eventBus.subscribe('session.start', onStart);
			const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
			hooks.register({
				onSessionStart: () => {
					throw new Error('start boom');
				},
			});

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(onStart).toHaveBeenCalledOnce();
			expect(mgr.state).toBe('ACTIVE');
			spy.mockRestore();
		});
	});

	describe('post-session dispatch (phase 4)', () => {
		it('dispatches the pipeline once on close and reports accepted', async () => {
			const pipeline = new InMemoryPostSessionPipeline();
			pipeline.freeze();
			const reports: string[] = [];
			pipeline.events.onProcessed((r) => reports.push(r.outcome));
			const { mgr } = createManager({ pipeline });
			mgr.registerSnapshotBuilder(snapshotBuilder());

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			await mgr.closeWithReason('normal');

			expect(reports).toEqual(['accepted']);
		});

		it('does not dispatch when no pipeline is configured (unchanged behavior)', async () => {
			const { mgr } = createManager();
			await mgr.closeWithReason('normal');
			expect(mgr.state).toBe('CLOSED'); // closes fine; nothing to assert beyond no throw
		});

		it('drain mode awaits the run report before resolving', async () => {
			const pipeline = new InMemoryPostSessionPipeline();
			let ran = false;
			class Slow extends PostSessionProcessor {
				readonly name = 'slow';
				async run() {
					await new Promise((r) => setTimeout(r, 15));
					ran = true;
				}
			}
			pipeline.register(new Slow());
			pipeline.freeze();
			const { mgr } = createManager({ pipeline, drain: true });
			mgr.registerSnapshotBuilder(snapshotBuilder());

			await mgr.closeWithReason('normal');
			expect(ran).toBe(true); // drain awaited the processor
		});

		it('build thunk throwing yields a failed_to_start report', async () => {
			const pipeline = new InMemoryPostSessionPipeline();
			pipeline.freeze();
			const outcomes: Array<{ outcome: string; failureReason?: string }> = [];
			pipeline.events.onProcessed((r) =>
				outcomes.push({ outcome: r.outcome, failureReason: r.failureReason }),
			);
			const { mgr } = createManager({ pipeline });
			mgr.registerSnapshotBuilder(snapshotBuilder({ throwOnBuild: true }));

			await mgr.closeWithReason('normal');

			expect(outcomes).toEqual([{ outcome: 'failed_to_start', failureReason: 'snapshot_failed' }]);
		});

		it('dispatches exactly once under duplicate close', async () => {
			const pipeline = new InMemoryPostSessionPipeline();
			pipeline.freeze();
			const reports: string[] = [];
			pipeline.events.onProcessed((r) => reports.push(r.outcome));
			const { mgr } = createManager({ pipeline });
			mgr.registerSnapshotBuilder(snapshotBuilder());

			await mgr.closeWithReason('user_hangup');
			await mgr.closeWithReason('error'); // no-op
			expect(reports).toEqual(['accepted']);
		});
	});

	describe('reset', () => {
		it('returns a closed standalone manager to CREATED, and the next cycle closes again with its own reason', async () => {
			const { mgr, eventBus } = createManager();
			const onClose = vi.fn();
			eventBus.subscribe('session.close', onClose);

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			const firstStartedAt = mgr.startedAtMs;
			mgr.updateResumptionHandle('handle_1');
			mgr.bufferMessage({ type: 'audio', data: 'chunk', timestamp: 1 });
			await mgr.closeWithReason('user_hangup');
			expect(mgr.state).toBe('CLOSED');

			mgr.reset();

			expect(mgr.state).toBe('CREATED');
			expect(mgr.resumptionHandle).toBeNull();
			expect(mgr.drainBufferedMessages()).toEqual([]);
			expect(mgr.startedAtMs).toBe(firstStartedAt);

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			const second = mgr.closeWithReason('timeout');
			// Inside one cycle a repeated close stays idempotent.
			expect(mgr.closeWithReason('error')).toBe(second);
			await second;

			expect(mgr.state).toBe('CLOSED');
			expect(onClose).toHaveBeenCalledTimes(2);
			expect(onClose).toHaveBeenNthCalledWith(1, { sessionId: 'sess_1', reason: 'user_hangup' });
			expect(onClose).toHaveBeenNthCalledWith(2, { sessionId: 'sess_1', reason: 'timeout' });
		});

		it('throws while a close is in flight, before the CLOSED transition', async () => {
			const { mgr } = createManager();
			let releaseFinalizer!: () => void;
			mgr.registerPreCloseFinalizer(
				() =>
					new Promise<void>((resolve) => {
						releaseFinalizer = resolve;
					}),
			);
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			const closing = mgr.closeWithReason('normal');
			expect(mgr.state).toBe('ACTIVE');
			expect(() => mgr.reset()).toThrow(SessionError);
			expect(() => mgr.reset()).toThrow(/in flight/);

			releaseFinalizer();
			await closing;
			mgr.reset();
			expect(mgr.state).toBe('CREATED');
		});

		it('throws after the CLOSED transition while a drained post-session report is pending, and succeeds once it settles', async () => {
			let releaseProcessor!: () => void;
			class Held extends PostSessionProcessor {
				readonly name = 'held';
				async run() {
					await new Promise<void>((resolve) => {
						releaseProcessor = resolve;
					});
				}
			}
			const pipeline = new InMemoryPostSessionPipeline();
			pipeline.register(new Held());
			pipeline.freeze();
			const { mgr } = createManager({ pipeline, drain: true });
			mgr.registerSnapshotBuilder(snapshotBuilder());
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			const closing = mgr.closeWithReason('normal');
			expect(mgr.state).toBe('CLOSED');
			await vi.waitFor(() => expect(releaseProcessor).toBeTypeOf('function'));
			expect(() => mgr.reset()).toThrow(SessionError);
			expect(mgr.state).toBe('CLOSED');

			releaseProcessor();
			await closing;
			mgr.reset();
			expect(mgr.state).toBe('CREATED');
		});

		it('a managed manager resets like a standalone one before it starts', () => {
			const { mgr } = createManager(undefined, true);
			mgr.updateResumptionHandle('handle_1');
			mgr.bufferMessage({ type: 'audio', data: 'chunk', timestamp: 1 });

			mgr.reset();

			expect(mgr.state).toBe('CREATED');
			expect(mgr.resumptionHandle).toBeNull();
			expect(mgr.drainBufferedMessages()).toEqual([]);
		});

		it('a managed manager throws once a close has been claimed, and after it settles', async () => {
			const { mgr } = createManager(undefined, true);
			let releaseFinalizer!: () => void;
			mgr.registerPreCloseFinalizer(
				() =>
					new Promise<void>((resolve) => {
						releaseFinalizer = resolve;
					}),
			);
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			const closing = mgr.closeWithReason('normal');
			expect(mgr.state).toBe('ACTIVE');
			expect(() => mgr.reset()).toThrow(SessionError);
			expect(() => mgr.reset()).toThrow(/managed/);

			releaseFinalizer();
			await closing;
			expect(() => mgr.reset()).toThrow(/managed/);
			expect(mgr.state).toBe('CLOSED');
		});

		it('a managed manager throws after a direct transitionTo(CLOSED)', () => {
			const { mgr } = createManager(undefined, true);
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('CLOSED');

			expect(() => mgr.reset()).toThrow(SessionError);
			expect(() => mgr.reset()).toThrow(/managed/);
			expect(mgr.state).toBe('CLOSED');
		});
	});

	describe('resumption', () => {
		it('starts with null handle', () => {
			const { mgr } = createManager();
			expect(mgr.resumptionHandle).toBeNull();
		});

		it('updateResumptionHandle stores handle', () => {
			const { mgr } = createManager();
			mgr.updateResumptionHandle('handle_abc');
			expect(mgr.resumptionHandle).toBe('handle_abc');
		});

		it('fires session.resume event', () => {
			const { mgr, eventBus } = createManager();
			const handler = vi.fn();
			eventBus.subscribe('session.resume', handler);

			mgr.updateResumptionHandle('handle_abc');

			expect(handler).toHaveBeenCalledWith({
				sessionId: 'sess_1',
				handle: 'handle_abc',
			});
		});

		// P2: clear-on-non-resumable so reconnect-with-state cannot stale-resume
		it('clearResumptionHandle resets to null', () => {
			const { mgr } = createManager();
			mgr.updateResumptionHandle('handle_abc');
			expect(mgr.resumptionHandle).toBe('handle_abc');
			mgr.clearResumptionHandle();
			expect(mgr.resumptionHandle).toBeNull();
		});

		it('clearResumptionHandle is idempotent on already-null state', () => {
			const { mgr } = createManager();
			expect(mgr.resumptionHandle).toBeNull();
			mgr.clearResumptionHandle();
			expect(mgr.resumptionHandle).toBeNull();
		});
	});

	describe('message buffering', () => {
		it('buffers and drains messages in order', () => {
			const { mgr } = createManager();
			mgr.bufferMessage({ type: 'audio', data: 'chunk1', timestamp: 1 });
			mgr.bufferMessage({ type: 'audio', data: 'chunk2', timestamp: 2 });

			const messages = mgr.drainBufferedMessages();
			expect(messages).toHaveLength(2);
			expect(messages[0].data).toBe('chunk1');
			expect(messages[1].data).toBe('chunk2');
		});

		it('drain empties the buffer', () => {
			const { mgr } = createManager();
			mgr.bufferMessage({ type: 'audio', data: 'chunk', timestamp: 1 });
			mgr.drainBufferedMessages();

			const second = mgr.drainBufferedMessages();
			expect(second).toHaveLength(0);
		});
	});

	it('exposes config properties', () => {
		const { mgr } = createManager();
		expect(mgr.sessionId).toBe('sess_1');
		expect(mgr.userId).toBe('user_1');
		expect(mgr.initialAgent).toBe('general');
	});
});
