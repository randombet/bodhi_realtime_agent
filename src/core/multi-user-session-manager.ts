/**
 * Multi-User Session Manager
 *
 * Manages multiple VoiceSession instances for concurrent users.
 * Handles session lifecycle, cleanup, and resource limits.
 */

import type { VoiceSession } from './voice-session.js';
import type { VoiceSessionConfig } from './voice-session.js';

export interface SessionMetadata {
	sessionId: string;
	userId: string;
	createdAt: number;
	lastActivityAt: number;
	webSocketId?: string; // Optional identifier for the WebSocket connection
}

export interface MultiUserSessionManagerConfig {
	/** Maximum number of concurrent sessions per user */
	maxSessionsPerUser?: number;
	/** Maximum total concurrent sessions */
	maxTotalSessions?: number;
	/** Idle session timeout in milliseconds */
	sessionTimeoutMs?: number;
	/** Cleanup interval in milliseconds */
	cleanupIntervalMs?: number;
}

/**
 * Manages a pool of VoiceSession instances for multiple concurrent users.
 */
export class MultiUserSessionManager {
	private sessions = new Map<string, VoiceSession>();
	private sessionMetadata = new Map<string, SessionMetadata>();
	private cleanupTimer: NodeJS.Timeout | null = null;
	private readonly config: Required<MultiUserSessionManagerConfig>;

	constructor(config: MultiUserSessionManagerConfig = {}) {
		this.config = {
			maxSessionsPerUser: config.maxSessionsPerUser ?? 5,
			maxTotalSessions: config.maxTotalSessions ?? 1000,
			sessionTimeoutMs: config.sessionTimeoutMs ?? 30 * 60 * 1000, // 30 minutes
			cleanupIntervalMs: config.cleanupIntervalMs ?? 60 * 1000, // 1 minute
		};

		// Start cleanup timer
		this.startCleanupTimer();
	}

	/**
	 * Create a new VoiceSession for a user.
	 */
	async createSession(
		userId: string,
		sessionConfig: Omit<VoiceSessionConfig, 'sessionId' | 'userId'>,
		webSocketId?: string,
	): Promise<VoiceSession> {
		// Check total session limit
		if (this.sessions.size >= this.config.maxTotalSessions) {
			throw new Error(`Maximum total sessions (${this.config.maxTotalSessions}) reached`);
		}

		// Check per-user session limit
		const userSessions = this.getAllSessionsForUser(userId);
		if (userSessions.length >= this.config.maxSessionsPerUser) {
			throw new Error(
				`Maximum sessions per user (${this.config.maxSessionsPerUser}) reached for user ${userId}`,
			);
		}

		// Generate unique session ID
		const sessionId = this.generateSessionId(userId);

		// Create VoiceSession
		const { VoiceSession } = await import('./voice-session.js');
		const session = new VoiceSession({
			...sessionConfig,
			sessionId,
			userId,
		});

		// Track session
		this.sessions.set(sessionId, session);
		this.sessionMetadata.set(sessionId, {
			sessionId,
			userId,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
			webSocketId,
		});

		return session;
	}

	/**
	 * Get a session by ID.
	 */
	getSession(sessionId: string): VoiceSession | null {
		return this.sessions.get(sessionId) ?? null;
	}

	/**
	 * Get session metadata.
	 */
	getSessionMetadata(sessionId: string): SessionMetadata | null {
		return this.sessionMetadata.get(sessionId) ?? null;
	}

	/**
	 * Get all active sessions for a user.
	 */
	getAllSessionsForUser(userId: string): VoiceSession[] {
		const sessions: VoiceSession[] = [];
		for (const [sessionId, metadata] of this.sessionMetadata.entries()) {
			if (metadata.userId === userId) {
				const session = this.sessions.get(sessionId);
				if (session) {
					sessions.push(session);
				}
			}
		}
		return sessions;
	}

	/**
	 * Update last activity time for a session.
	 */
	updateActivity(sessionId: string): void {
		const metadata = this.sessionMetadata.get(sessionId);
		if (metadata) {
			metadata.lastActivityAt = Date.now();
		}
	}

	/**
	 * Close and remove a session.
	 */
	async closeSession(sessionId: string, reason = 'user_disconnect'): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			try {
				await session.close(reason);
			} catch (error) {
				console.error(`Error closing session ${sessionId}:`, error);
			}
		}

		this.sessions.delete(sessionId);
		this.sessionMetadata.delete(sessionId);
	}

	/**
	 * Close all sessions for a user.
	 */
	async closeAllSessionsForUser(userId: string, reason = 'user_logout'): Promise<void> {
		const sessions = this.getAllSessionsForUser(userId);
		await Promise.all(sessions.map((s) => this.closeSession(s.getSessionId(), reason)));
	}

	/**
	 * Get statistics about active sessions.
	 */
	getStats(): {
		totalSessions: number;
		sessionsByUser: Record<string, number>;
		oldestSession: number | null;
		newestSession: number | null;
	} {
		const sessionsByUser: Record<string, number> = {};
		let oldestSession: number | null = null;
		let newestSession: number | null = null;

		for (const metadata of this.sessionMetadata.values()) {
			sessionsByUser[metadata.userId] = (sessionsByUser[metadata.userId] ?? 0) + 1;

			if (oldestSession === null || metadata.createdAt < oldestSession) {
				oldestSession = metadata.createdAt;
			}
			if (newestSession === null || metadata.createdAt > newestSession) {
				newestSession = metadata.createdAt;
			}
		}

		return {
			totalSessions: this.sessions.size,
			sessionsByUser,
			oldestSession,
			newestSession,
		};
	}

	/**
	 * Get all session metadata for API.
	 */
	getAllSessionMetadata(): SessionMetadata[] {
		return Array.from(this.sessionMetadata.values());
	}

	/**
	 * Cleanup idle sessions.
	 */
	async cleanupIdleSessions(): Promise<number> {
		const now = Date.now();
		const idleSessions: string[] = [];

		for (const [sessionId, metadata] of this.sessionMetadata.entries()) {
			const idleTime = now - metadata.lastActivityAt;
			if (idleTime > this.config.sessionTimeoutMs) {
				idleSessions.push(sessionId);
			}
		}

		// Close idle sessions
		await Promise.all(
			idleSessions.map((sessionId) => this.closeSession(sessionId, 'idle_timeout')),
		);

		return idleSessions.length;
	}

	/**
	 * Start the cleanup timer.
	 */
	private startCleanupTimer(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}

		this.cleanupTimer = setInterval(async () => {
			try {
				const cleaned = await this.cleanupIdleSessions();
				if (cleaned > 0) {
					console.log(`[MultiUserSessionManager] Cleaned up ${cleaned} idle sessions`);
				}
			} catch (error) {
				console.error('[MultiUserSessionManager] Cleanup error:', error);
			}
		}, this.config.cleanupIntervalMs);
	}

	/**
	 * Stop the cleanup timer and close all sessions.
	 */
	async shutdown(): Promise<void> {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		// Close all sessions
		const sessionIds = Array.from(this.sessions.keys());
		await Promise.all(sessionIds.map((id) => this.closeSession(id, 'server_shutdown')));
	}

	/**
	 * Generate a unique session ID.
	 */
	private generateSessionId(userId: string): string {
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2, 9);
		return `session_${userId}_${timestamp}_${random}`;
	}
}
