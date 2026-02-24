// SPDX-License-Identifier: MIT

import type { MemoryFact, MemoryStore } from '../types/memory.js';

/**
 * Caches memory facts from a MemoryStore for quick in-session access.
 *
 * Extracted from VoiceSession to isolate the memory caching concern.
 * Callers use `refresh()` to reload from the store and `facts` to read
 * the latest cached snapshot. Failures during refresh are non-fatal —
 * the previous cache is retained.
 */
export class MemoryCacheManager {
	private cache: MemoryFact[] = [];

	constructor(
		private store: MemoryStore,
		private userId: string,
	) {}

	/** Reload cached facts from the store. Best-effort: keeps stale cache on failure. */
	async refresh(): Promise<void> {
		try {
			this.cache = await this.store.getAll(this.userId);
		} catch {
			// Best-effort — keep stale cache on failure
		}
	}

	/** Return the current cached facts. */
	get facts(): MemoryFact[] {
		return this.cache;
	}
}
