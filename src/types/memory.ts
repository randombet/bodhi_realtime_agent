// SPDX-License-Identifier: MIT

/** Classification categories for extracted memory facts. */
export type MemoryCategory = 'preference' | 'entity' | 'decision' | 'requirement';

/** A single piece of durable information extracted from conversation about the user. */
export interface MemoryFact {
	/** The fact expressed as a self-contained statement. */
	content: string;
	/** Classification of this fact. */
	category: MemoryCategory;
	/** When this fact was extracted (Unix ms). 0 if parsed from storage. */
	timestamp: number;
}

/**
 * Persistence interface for per-user memory facts and directives.
 * Implementations must be safe for concurrent reads and writes.
 * See JsonMemoryStore for the built-in file-based implementation.
 */
export interface MemoryStore {
	/** Append new facts to the user's memory (creates the store entry if needed). */
	addFacts(userId: string, facts: MemoryFact[]): Promise<void>;
	/** Retrieve all stored facts for a user (empty array if none). */
	getAll(userId: string): Promise<MemoryFact[]>;
	/** Atomically replace all facts for a user (used by consolidation). */
	replaceAll(userId: string, facts: MemoryFact[]): Promise<void>;
	/** Retrieve structured directives (e.g. behavior presets) for a user. */
	getDirectives(userId: string): Promise<Record<string, string>>;
	/** Persist structured directives for a user (preserves existing facts). */
	setDirectives(userId: string, directives: Record<string, string>): Promise<void>;
}
