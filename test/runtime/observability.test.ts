// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../../src/runtime/envelope.js';
import type { ObservableEvent } from '../../src/runtime/observability.js';
import { RuntimeObserver } from '../../src/runtime/observability.js';

describe('RuntimeObserver', () => {
	let observer: RuntimeObserver;

	beforeEach(() => {
		observer = new RuntimeObserver();
	});

	// -- Message tracking ---------------------------------------------------

	describe('message tracking', () => {
		it('counts messages processed per actor', () => {
			const env = createEnvelope('test.msg', {}, 'actor-a');

			observer.recordMessageProcessed('actor-a', env);
			observer.recordMessageProcessed('actor-a', env);
			observer.recordMessageProcessed('actor-b', env);

			expect(observer.getMessagesProcessed('actor-a')).toBe(2);
			expect(observer.getMessagesProcessed('actor-b')).toBe(1);
			expect(observer.getMessagesProcessed('actor-c')).toBe(0);
		});

		it('fires listener on message processed', () => {
			const events: ObservableEvent[] = [];
			observer.setListener((e) => events.push(e));

			const env = createEnvelope('transport.session_ready', {}, 'session', {
				correlationId: 'corr-1',
			});
			observer.recordMessageProcessed('session', env);

			expect(events).toHaveLength(1);
			expect(events[0].category).toBe('message');
			expect(events[0].actorId).toBe('session');
			expect(events[0].messageType).toBe('transport.session_ready');
			expect(events[0].correlationId).toBe('corr-1');
		});

		it('does not fire when no listener', () => {
			// Should not throw
			const env = createEnvelope('test.msg', {}, 'actor-a');
			observer.recordMessageProcessed('actor-a', env);
		});
	});

	// -- Failure tracking ---------------------------------------------------

	describe('failure tracking', () => {
		it('counts failures per actor', () => {
			const env = createEnvelope('test.msg', {}, 'actor-a');

			observer.recordFailure('actor-a', new Error('boom'), env);
			observer.recordFailure('actor-a', new Error('boom2'), env);

			expect(observer.getFailureCount('actor-a')).toBe(2);
			expect(observer.getFailureCount('actor-b')).toBe(0);
		});

		it('fires listener with error metadata', () => {
			const events: ObservableEvent[] = [];
			observer.setListener((e) => events.push(e));

			const env = createEnvelope('test.msg', {}, 'actor-a');
			observer.recordFailure('actor-a', new Error('connection lost'), env);

			expect(events[0].category).toBe('error');
			expect(events[0].metadata?.error).toBe('connection lost');
		});
	});

	// -- Dead letter tracking -----------------------------------------------

	describe('dead letter tracking', () => {
		it('counts dead letters', () => {
			const env = createEnvelope('test.msg', {}, 'nonexistent');

			observer.recordDeadLetter(env);
			observer.recordDeadLetter(env);

			expect(observer.deadLetterCount).toBe(2);
		});

		it('fires listener for dead letters', () => {
			const events: ObservableEvent[] = [];
			observer.setListener((e) => events.push(e));

			observer.recordDeadLetter(createEnvelope('test.msg', {}, 'ghost'));

			expect(events[0].category).toBe('dead_letter');
			expect(events[0].actorId).toBe('ghost');
		});
	});

	// -- Workflow transition -------------------------------------------------

	describe('workflow transitions', () => {
		it('fires listener with workflow context', () => {
			const events: ObservableEvent[] = [];
			observer.setListener((e) => events.push(e));

			observer.recordWorkflowTransition(
				'subagent-supervisor',
				'wf-1',
				'running',
				'completed',
				'tc-1',
			);

			expect(events[0].category).toBe('workflow');
			expect(events[0].workflowId).toBe('wf-1');
			expect(events[0].toolCallId).toBe('tc-1');
			expect(events[0].messageType).toBe('workflow.running_to_completed');
		});
	});

	// -- Lifecycle events ----------------------------------------------------

	describe('lifecycle events', () => {
		it('fires listener for actor lifecycle', () => {
			const events: ObservableEvent[] = [];
			observer.setListener((e) => events.push(e));

			observer.recordLifecycle('transport', 'started');
			observer.recordLifecycle('transport', 'stopped');

			expect(events).toHaveLength(2);
			expect(events[0].messageType).toBe('actor.started');
			expect(events[1].messageType).toBe('actor.stopped');
		});
	});

	// -- Metrics snapshot ----------------------------------------------------

	describe('getMetrics', () => {
		it('returns metrics snapshot', () => {
			const env = createEnvelope('test.msg', {}, 'actor-a');
			observer.recordMessageProcessed('actor-a', env);
			observer.recordFailure('actor-b', new Error('x'), env);
			observer.recordDeadLetter(env);

			const metrics = observer.getMetrics(
				(id) => (id === 'actor-a' ? 3 : 0),
				['actor-a', 'actor-b'],
			);

			expect(metrics.messagesProcessed.get('actor-a')).toBe(1);
			expect(metrics.failureCount.get('actor-b')).toBe(1);
			expect(metrics.deadLetterCount).toBe(1);
			expect(metrics.mailboxDepth.get('actor-a')).toBe(3);
		});
	});

	// -- Reset ---------------------------------------------------------------

	describe('reset', () => {
		it('clears all counters', () => {
			const env = createEnvelope('test.msg', {}, 'actor-a');
			observer.recordMessageProcessed('actor-a', env);
			observer.recordFailure('actor-a', new Error('x'), env);
			observer.recordDeadLetter(env);

			observer.reset();

			expect(observer.getMessagesProcessed('actor-a')).toBe(0);
			expect(observer.getFailureCount('actor-a')).toBe(0);
			expect(observer.deadLetterCount).toBe(0);
		});
	});
});
