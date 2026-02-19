// SPDX-License-Identifier: MIT

import type { SessionCheckpoint } from '../types/session.js';

/**
 * Persistence interface for session checkpoints (crash recovery / session restore).
 * Implementations should deep-copy on save/load to prevent shared-reference mutations.
 */
export interface SessionStore {
	/** Persist a session checkpoint (overwrites any existing checkpoint for this session). */
	save(checkpoint: SessionCheckpoint): Promise<void>;
	/** Load a session checkpoint by ID (null if not found). */
	load(sessionId: string): Promise<SessionCheckpoint | null>;
	/** Delete a session checkpoint. */
	delete(sessionId: string): Promise<void>;
}

/**
 * Map-based in-memory implementation of SessionStore.
 * Uses structuredClone for deep-copy isolation between save/load calls.
 */
export class InMemorySessionStore implements SessionStore {
	private store = new Map<string, SessionCheckpoint>();

	async save(checkpoint: SessionCheckpoint): Promise<void> {
		this.store.set(checkpoint.sessionId, structuredClone(checkpoint));
	}

	async load(sessionId: string): Promise<SessionCheckpoint | null> {
		const checkpoint = this.store.get(sessionId);
		return checkpoint ? structuredClone(checkpoint) : null;
	}

	async delete(sessionId: string): Promise<void> {
		this.store.delete(sessionId);
	}
}
