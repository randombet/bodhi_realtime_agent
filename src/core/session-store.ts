import type { SessionCheckpoint } from '../types/session.js';

export interface SessionStore {
	save(checkpoint: SessionCheckpoint): Promise<void>;
	load(sessionId: string): Promise<SessionCheckpoint | null>;
	delete(sessionId: string): Promise<void>;
}

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
