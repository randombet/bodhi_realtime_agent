import type { ConversationItem } from './conversation.js';
import type { PendingToolCall } from './session.js';

export interface SessionRecord {
	id: string;
	userId: string;
	initialAgentName: string;
	finalAgentName?: string;
	status: 'active' | 'ended' | 'error';
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	disconnectReason?: 'user_hangup' | 'error' | 'timeout' | 'go_away' | 'transfer';
	transcript?: string;
	analytics?: SessionAnalytics;
	metadata?: Record<string, unknown>;
}

export interface SessionAnalytics {
	turnCount: number;
	userMessageCount: number;
	assistantMessageCount: number;
	toolCallCount: number;
	agentTransferCount: number;
	totalTokens?: number;
}

export interface SessionReport extends SessionRecord {
	items: ConversationItem[];
	pendingToolCalls: PendingToolCall[];
}

export interface SessionSummary {
	id: string;
	userId: string;
	initialAgentName: string;
	status: 'active' | 'ended' | 'error';
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
}

export interface PaginationOptions {
	limit?: number;
	offset?: number;
	cursor?: string;
}

export interface ConversationHistoryStore {
	createSession(session: SessionRecord): Promise<void>;
	updateSession(sessionId: string, update: Partial<SessionRecord>): Promise<void>;
	addItems(sessionId: string, items: ConversationItem[]): Promise<void>;
	saveSessionReport(report: SessionReport): Promise<void>;
	getSession(sessionId: string): Promise<SessionRecord | null>;
	getSessionItems(sessionId: string, options?: PaginationOptions): Promise<ConversationItem[]>;
	listUserSessions(userId: string, options?: PaginationOptions): Promise<SessionSummary[]>;
}
