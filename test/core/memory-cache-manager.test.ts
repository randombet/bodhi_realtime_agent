// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { MemoryCacheManager } from '../../src/core/memory-cache-manager.js';
import type { MemoryStore } from '../../src/types/memory.js';

function createMockStore(
	facts = [{ content: 'Likes tea', category: 'preference' as const, timestamp: 0 }],
): MemoryStore {
	return {
		addFacts: vi.fn(),
		getAll: vi.fn(async () => facts),
		replaceAll: vi.fn(),
		getDirectives: vi.fn(async () => ({})),
		setDirectives: vi.fn(),
	};
}

describe('MemoryCacheManager', () => {
	it('starts with empty cache', () => {
		const store = createMockStore();
		const mgr = new MemoryCacheManager(store, 'user_1');
		expect(mgr.facts).toEqual([]);
	});

	it('populates cache after refresh', async () => {
		const store = createMockStore();
		const mgr = new MemoryCacheManager(store, 'user_1');

		await mgr.refresh();

		expect(store.getAll).toHaveBeenCalledWith('user_1');
		expect(mgr.facts).toEqual([{ content: 'Likes tea', category: 'preference', timestamp: 0 }]);
	});

	it('keeps stale cache when refresh fails', async () => {
		const store = createMockStore();
		const mgr = new MemoryCacheManager(store, 'user_1');

		// First refresh succeeds
		await mgr.refresh();
		expect(mgr.facts).toHaveLength(1);

		// Second refresh fails
		(store.getAll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network error'));
		await mgr.refresh();

		// Still has the old cache
		expect(mgr.facts).toHaveLength(1);
		expect(mgr.facts[0].content).toBe('Likes tea');
	});

	it('updates cache with new facts on subsequent refresh', async () => {
		const store = createMockStore();
		const mgr = new MemoryCacheManager(store, 'user_1');

		await mgr.refresh();
		expect(mgr.facts).toHaveLength(1);

		// Store returns more facts now
		(store.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
			{ content: 'Likes tea', category: 'preference', timestamp: 0 },
			{ content: 'Lives in Seattle', category: 'entity', timestamp: 0 },
		]);

		await mgr.refresh();
		expect(mgr.facts).toHaveLength(2);
	});
});
