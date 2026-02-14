import type { ClientMessage } from './audio.js';
import type { ConversationItem } from './conversation.js';

export type SessionState =
	| 'CREATED'
	| 'CONNECTING'
	| 'ACTIVE'
	| 'RECONNECTING'
	| 'TRANSFERRING'
	| 'CLOSED';

export interface SessionConfig {
	sessionId: string;
	userId: string;
	geminiModel?: string;
	initialAgent: string;
}

export interface ResumptionState {
	latestHandle: string | null;
	resumable: boolean;
	pendingMessages: ClientMessage[];
}

export interface ResumptionUpdate {
	handle: string;
	resumable: boolean;
}

export interface SessionCheckpoint {
	sessionId: string;
	userId: string;
	activeAgent: string;
	resumptionHandle: string | null;
	conversationItems: ConversationItem[];
	conversationSummary: string | null;
	pendingToolCalls: PendingToolCall[];
	timestamp: number;
}

export interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	subagentConfigName: string;
	arguments: Record<string, unknown>;
	startedAt: number;
	timeout: number;
}
