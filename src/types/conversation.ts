import type { MemoryFact } from './memory.js';

export type ConversationItemRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'transfer';

export interface ConversationItem {
	role: ConversationItemRole;
	content: string;
	timestamp: number;
	metadata?: Record<string, unknown>;
}

export interface ToolCall {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	toolName: string;
	result: unknown;
	error?: string;
}

export interface SubagentTask {
	description: string;
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface SubagentResult {
	text: string;
	stepCount: number;
	uiPayload?: UIPayload;
}

export interface SubagentContextSnapshot {
	task: SubagentTask;
	conversationSummary: string | null;
	recentTurns: ConversationItem[];
	relevantMemoryFacts: MemoryFact[];
	agentInstructions: string;
}

/** Structured UI payload for dual-channel delivery (voice + UI) */
export interface UIPayload {
	type: 'choice' | 'confirmation' | 'status' | 'form' | 'image';
	requestId?: string;
	data: Record<string, unknown>;
}
