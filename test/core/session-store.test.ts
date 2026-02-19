// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../../src/core/session-store.js';
import type { SessionCheckpoint } from '../../src/types/session.js';

function createCheckpoint(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
	return {
		sessionId: 'sess_1',
		userId: 'user_1',
		activeAgent: 'echo',
		resumptionHandle: 'handle_abc',
		conversationItems: [{ role: 'user', content: 'Hello', timestamp: 1000 }],
		conversationSummary: null,
		pendingToolCalls: [],
		timestamp: Date.now(),
		...overrides,
	};
}

describe('InMemorySessionStore', () => {
	it('save and load returns checkpoint', async () => {
		const store = new InMemorySessionStore();
		const checkpoint = createCheckpoint();

		await store.save(checkpoint);
		const loaded = await store.load('sess_1');

		expect(loaded).toEqual(checkpoint);
	});

	it('load returns null for unknown session', async () => {
		const store = new InMemorySessionStore();
		const loaded = await store.load('unknown');
		expect(loaded).toBeNull();
	});

	it('save overwrites existing checkpoint', async () => {
		const store = new InMemorySessionStore();

		await store.save(createCheckpoint({ activeAgent: 'echo' }));
		await store.save(createCheckpoint({ activeAgent: 'booking' }));

		const loaded = await store.load('sess_1');
		expect(loaded?.activeAgent).toBe('booking');
	});

	it('delete removes checkpoint', async () => {
		const store = new InMemorySessionStore();

		await store.save(createCheckpoint());
		await store.delete('sess_1');

		const loaded = await store.load('sess_1');
		expect(loaded).toBeNull();
	});

	it('delete is safe for unknown session', async () => {
		const store = new InMemorySessionStore();
		await expect(store.delete('unknown')).resolves.toBeUndefined();
	});

	it('save creates deep clone (mutation isolation)', async () => {
		const store = new InMemorySessionStore();
		const checkpoint = createCheckpoint();

		await store.save(checkpoint);

		// Mutate original
		checkpoint.activeAgent = 'mutated';
		checkpoint.conversationItems.push({ role: 'assistant', content: 'Extra', timestamp: 2000 });

		const loaded = await store.load('sess_1');
		expect(loaded?.activeAgent).toBe('echo');
		expect(loaded?.conversationItems).toHaveLength(1);
	});

	it('load returns deep clone (mutation isolation)', async () => {
		const store = new InMemorySessionStore();
		await store.save(createCheckpoint());

		const loaded1 = await store.load('sess_1');
		expect(loaded1).not.toBeNull();
		if (loaded1) loaded1.activeAgent = 'mutated';

		const loaded2 = await store.load('sess_1');
		expect(loaded2?.activeAgent).toBe('echo');
	});
});
