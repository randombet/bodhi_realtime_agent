// SPDX-License-Identifier: MIT

import type { ConversationItem } from './conversation.js';
import type { PendingToolCall } from './session.js';

/** Metadata for a single voice session, stored by ConversationHistoryStore. */
export interface SessionRecord {
	/** Unique session identifier. */
	id: string;
	userId: string;
	/** Agent that was active when the session started. */
	initialAgentName: string;
	/** Agent that was active when the session ended. */
	finalAgentName?: string;
	status: 'active' | 'ended' | 'error';
	/** Unix timestamp (ms) when the session started. */
	startedAt: number;
	/** Unix timestamp (ms) when the session ended. */
	endedAt?: number;
	/** Total session duration in milliseconds. */
	durationMs?: number;
	disconnectReason?: 'user_hangup' | 'error' | 'timeout' | 'go_away' | 'transfer';
	/** Full text transcript of the session (optional). */
	transcript?: string;
	/** Aggregated session statistics. */
	analytics?: SessionAnalytics;
	/** Application-specific metadata. */
	metadata?: Record<string, unknown>;
}

/** Aggregated counters for a single session. */
export interface SessionAnalytics {
	turnCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	toolCallCount: number;
	agentTransferCount: number;
	totalTokens?: number;
}

/** A full session report including conversation items and pending tool state. */
export interface SessionReport extends SessionRecord {
	/** Complete conversation timeline. */
	items: ConversationItem[];
	/** Tool calls that were still running when the session ended. */
	pendingToolCalls: PendingToolCall[];
}

/** Lightweight session summary for listing endpoints (no conversation items). */
export interface SessionSummary {
	id: string;
	userId: string;
	initialAgentName: string;
	status: 'active' | 'ended' | 'error';
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
}

/** Cursor-based pagination options for history queries. */
export interface PaginationOptions {
	/** Maximum number of results to return. */
	limit?: number;
	/** Number of results to skip (offset-based pagination). */
	offset?: number;
	/** Opaque cursor for cursor-based pagination. */
	cursor?: string;
}

/**
 * Persistence interface for conversation history.
 * Implementations are responsible for durable storage of session records and conversation items.
 */
export interface ConversationHistoryStore {
	/** Create a new session record. */
	createSession(session: SessionRecord): Promise<void>;
	/** Update fields on an existing session record. */
	updateSession(sessionId: string, update: Partial<SessionRecord>): Promise<void>;
	/** Append conversation items to a session's history. */
	addItems(sessionId: string, items: ConversationItem[]): Promise<void>;
	/** Save a complete session report (called on session close). */
	saveSessionReport(report: SessionReport): Promise<void>;
	/** Retrieve a session record by ID (null if not found). */
	getSession(sessionId: string): Promise<SessionRecord | null>;
	/** Retrieve conversation items for a session with optional pagination. */
	getSessionItems(sessionId: string, options?: PaginationOptions): Promise<ConversationItem[]>;
	/** List all sessions for a user with optional pagination. */
	listUserSessions(userId: string, options?: PaginationOptions): Promise<SessionSummary[]>;
}
