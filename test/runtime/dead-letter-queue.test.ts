// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { DeadLetterQueue } from '../../src/runtime/dead-letter-queue.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

describe('DeadLetterQueue', () => {
	it('enqueues and retrieves entries', () => {
		const dlq = new DeadLetterQueue();
		const env = createEnvelope('test.msg', {}, 'ghost-actor');

		dlq.enqueue(env, 'no_actor');

		expect(dlq.size).toBe(1);
		expect(dlq.totalCount).toBe(1);

		const entries = dlq.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].envelope).toBe(env);
		expect(entries[0].reason).toBe('no_actor');
		expect(entries[0].retryCount).toBe(0);
	});

	it('stores error details', () => {
		const dlq = new DeadLetterQueue();
		const env = createEnvelope('test.msg', {}, 'actor-a');

		dlq.enqueue(env, 'processing_failed', 'connection timeout');

		const entry = dlq.latest;
		expect(entry?.error).toBe('connection timeout');
		expect(entry?.reason).toBe('processing_failed');
	});

	it('evicts oldest entries when over capacity', () => {
		const dlq = new DeadLetterQueue({ maxSize: 3 });

		for (let i = 0; i < 5; i++) {
			dlq.enqueue(createEnvelope(`msg.${i}`, {}, 'actor'), 'no_actor');
		}

		expect(dlq.size).toBe(3);
		expect(dlq.totalCount).toBe(5);

		// Oldest entries (msg.0, msg.1) should be evicted
		const entries = dlq.getEntries();
		expect(entries[0].envelope.type).toBe('msg.2');
		expect(entries[2].envelope.type).toBe('msg.4');
	});

	it('filters entries by actor', () => {
		const dlq = new DeadLetterQueue();
		dlq.enqueue(createEnvelope('msg.1', {}, 'actor-a'), 'no_actor');
		dlq.enqueue(createEnvelope('msg.2', {}, 'actor-b'), 'no_actor');
		dlq.enqueue(createEnvelope('msg.3', {}, 'actor-a'), 'no_actor');

		const actorA = dlq.getEntriesForActor('actor-a');
		expect(actorA).toHaveLength(2);
	});

	it('filters entries by message type', () => {
		const dlq = new DeadLetterQueue();
		dlq.enqueue(createEnvelope('transport.error', {}, 'a'), 'no_actor');
		dlq.enqueue(createEnvelope('subagent.failed', {}, 'b'), 'no_actor');
		dlq.enqueue(createEnvelope('transport.error', {}, 'c'), 'no_actor');

		const errors = dlq.getEntriesByType('transport.error');
		expect(errors).toHaveLength(2);
	});

	it('returns latest entry', () => {
		const dlq = new DeadLetterQueue();

		expect(dlq.latest).toBeUndefined();

		dlq.enqueue(createEnvelope('msg.1', {}, 'a'), 'no_actor');
		dlq.enqueue(createEnvelope('msg.2', {}, 'b'), 'no_actor');

		expect(dlq.latest?.envelope.type).toBe('msg.2');
	});

	it('clears all entries', () => {
		const dlq = new DeadLetterQueue();
		dlq.enqueue(createEnvelope('msg.1', {}, 'a'), 'no_actor');
		dlq.enqueue(createEnvelope('msg.2', {}, 'b'), 'no_actor');

		dlq.clear();

		expect(dlq.size).toBe(0);
		expect(dlq.totalCount).toBe(2); // totalCount is NOT reset
	});

	it('uses default maxSize of 100', () => {
		const dlq = new DeadLetterQueue();

		for (let i = 0; i < 120; i++) {
			dlq.enqueue(createEnvelope(`msg.${i}`, {}, 'a'), 'no_actor');
		}

		expect(dlq.size).toBe(100);
		expect(dlq.totalCount).toBe(120);
	});
});
