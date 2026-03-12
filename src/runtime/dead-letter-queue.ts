// SPDX-License-Identifier: MIT

/**
 * Dead-letter queue for the actor runtime.
 *
 * Bounded queue that retains undeliverable envelopes with error metadata
 * and retry information. Surfaced via observability hooks.
 */

import type { Envelope } from './envelope.js';

/** A dead-letter entry with metadata. */
export interface DeadLetterEntry {
	/** The undeliverable envelope. */
	envelope: Envelope;
	/** Why the message was dead-lettered. */
	reason: 'no_actor' | 'actor_stopped' | 'processing_failed';
	/** Error details if applicable. */
	error?: string;
	/** Timestamp when dead-lettered. */
	timestamp: number;
	/** Number of times this message was retried (0 = never retried). */
	retryCount: number;
}

/** Configuration for the dead-letter queue. */
export interface DeadLetterQueueConfig {
	/** Maximum number of entries to retain (oldest are evicted). */
	maxSize: number;
}

const DEFAULT_CONFIG: DeadLetterQueueConfig = {
	maxSize: 100,
};

/**
 * Bounded dead-letter queue.
 *
 * When the queue is full, the oldest entry is evicted to make room.
 * Provides query methods for observability and diagnostics.
 */
export class DeadLetterQueue {
	private entries: DeadLetterEntry[] = [];
	private config: DeadLetterQueueConfig;
	private _totalCount = 0;

	constructor(config?: Partial<DeadLetterQueueConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/** Add a dead-letter entry. */
	enqueue(envelope: Envelope, reason: DeadLetterEntry['reason'], error?: string): void {
		this._totalCount++;

		const entry: DeadLetterEntry = {
			envelope,
			reason,
			error,
			timestamp: Date.now(),
			retryCount: 0,
		};

		this.entries.push(entry);

		// Evict oldest if over capacity
		if (this.entries.length > this.config.maxSize) {
			this.entries.shift();
		}
	}

	/** Get all current entries. */
	getEntries(): readonly DeadLetterEntry[] {
		return this.entries;
	}

	/** Get entries filtered by target actor. */
	getEntriesForActor(actorId: string): DeadLetterEntry[] {
		return this.entries.filter((e) => e.envelope.to === actorId);
	}

	/** Get entries filtered by message type. */
	getEntriesByType(messageType: string): DeadLetterEntry[] {
		return this.entries.filter((e) => e.envelope.type === messageType);
	}

	/** Current number of retained entries. */
	get size(): number {
		return this.entries.length;
	}

	/** Total number of dead letters ever enqueued (including evicted). */
	get totalCount(): number {
		return this._totalCount;
	}

	/** Clear all entries. */
	clear(): void {
		this.entries = [];
	}

	/** Get the most recent entry. */
	get latest(): DeadLetterEntry | undefined {
		return this.entries.length > 0 ? this.entries[this.entries.length - 1] : undefined;
	}
}
