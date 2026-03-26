// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAISessionSerializer } from '../../src/transport/openai-session-serializer.js';

describe('OpenAISessionSerializer', () => {
	let serializer: OpenAISessionSerializer;

	beforeEach(() => {
		vi.useFakeTimers();
		serializer = new OpenAISessionSerializer(5000);
	});

	afterEach(() => {
		serializer.reset();
		vi.useRealTimers();
	});

	it('starts not busy', () => {
		expect(serializer.isBusy).toBe(false);
		expect(serializer.queueLength).toBe(0);
	});

	it('acquires immediately when not busy', async () => {
		await serializer.acquire('session.update');

		expect(serializer.isBusy).toBe(true);
		expect(serializer.currentType).toBe('session.update');
	});

	it('releases and becomes available', async () => {
		await serializer.acquire('session.update');
		serializer.release();

		expect(serializer.isBusy).toBe(false);
	});

	it('queues operations when busy', async () => {
		await serializer.acquire('session.update');

		// Second acquire should be queued
		let secondResolved = false;
		const secondPromise = serializer.acquire('response.create').then(() => {
			secondResolved = true;
		});

		expect(serializer.queueLength).toBe(1);
		expect(secondResolved).toBe(false);

		// Release first — second should start
		serializer.release();
		await secondPromise;

		expect(secondResolved).toBe(true);
		expect(serializer.currentType).toBe('response.create');
	});

	it('processes queue in order', async () => {
		const order: string[] = [];

		await serializer.acquire('session.update');

		const p1 = serializer.acquire('response.create').then(() => order.push('create'));
		const p2 = serializer.acquire('response.cancel').then(() => order.push('cancel'));

		expect(serializer.queueLength).toBe(2);

		serializer.release(); // releases session.update, starts response.create
		await p1;
		serializer.release(); // releases response.create, starts response.cancel
		await p2;

		expect(order).toEqual(['create', 'cancel']);
	});

	it('rejects current and drains queue on error', async () => {
		await serializer.acquire('session.update');

		let queuedRejected = false;
		serializer.acquire('response.create').catch(() => {
			queuedRejected = true;
		});

		serializer.reject(new Error('connection lost'));

		// Wait for microtasks
		await vi.advanceTimersByTimeAsync(0);

		expect(serializer.isBusy).toBe(false);
		expect(queuedRejected).toBe(true);
	});

	it('times out stale operations', async () => {
		await serializer.acquire('session.update');

		let nextResolved = false;
		serializer.acquire('response.create').then(() => {
			nextResolved = true;
		});

		// Advance past timeout
		await vi.advanceTimersByTimeAsync(5001);

		// The timed-out operation should have been cleaned up,
		// and the next operation should have started
		await vi.advanceTimersByTimeAsync(0);
		expect(nextResolved).toBe(true);
	});

	it('resets clears everything', async () => {
		await serializer.acquire('session.update');

		let rejected = false;
		serializer.acquire('response.create').catch(() => {
			rejected = true;
		});

		serializer.reset();

		await vi.advanceTimersByTimeAsync(0);

		expect(serializer.isBusy).toBe(false);
		expect(serializer.queueLength).toBe(0);
		expect(rejected).toBe(true);
	});
});
