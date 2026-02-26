// SPDX-License-Identifier: MIT

import type { MemoryFact } from './memory.js';

/** The role of a conversation item, used to distinguish message types in the context. */
export type ConversationItemRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'transfer';

/** A single entry in the conversation timeline (message, tool call, or agent transfer). */
export interface ConversationItem {
	/** Who produced this item. */
	role: ConversationItemRole;
	/** The textual content (or JSON-serialized data for tool_call/tool_result). */
	content: string;
	/** Unix timestamp in milliseconds when this item was created. */
	timestamp: number;
	/** Optional application-specific metadata. */
	metadata?: Record<string, unknown>;
}

/** A tool invocation request from the model. */
export interface ToolCall {
	/** Unique ID assigned by Gemini for correlating call → result. */
	toolCallId: string;
	/** Name of the tool being invoked. */
	toolName: string;
	/** Parsed arguments for the tool. */
	args: Record<string, unknown>;
}

/** The result of executing a tool, sent back to Gemini. */
export interface ToolResult {
	/** Correlates back to the originating ToolCall. */
	toolCallId: string;
	/** Name of the tool that was executed. */
	toolName: string;
	/** The successful return value (null when error is set). */
	result: unknown;
	/** Error message if execution failed. */
	error?: string;
}

/** Describes the work a subagent should perform (derived from a background tool call). */
export interface SubagentTask {
	/** Human-readable description of what the subagent should do. */
	description: string;
	/** Correlates back to the originating background tool call. */
	toolCallId: string;
	/** Name of the background tool that triggered this task. */
	toolName: string;
	/** Arguments originally passed to the tool. */
	args: Record<string, unknown>;
}

/** The output produced by a subagent after completing its task. */
export interface SubagentResult {
	/** The textual result to relay back to Gemini as a tool response. */
	text: string;
	/** How many LLM steps the subagent took. */
	stepCount: number;
	/** Optional structured UI payload for dual-channel (voice + screen) delivery. */
	uiPayload?: UIPayload;
}

/**
 * Everything a subagent needs to understand the current conversation state.
 * Built by ConversationContext and passed to the subagent runner.
 */
export interface SubagentContextSnapshot {
	/** The task the subagent should execute. */
	task: SubagentTask;
	/** Compressed summary of earlier conversation (null if no summarization has occurred). */
	conversationSummary: string | null;
	/** The most recent conversation items for immediate context. */
	recentTurns: ConversationItem[];
	/** User-specific memory facts relevant to the task. */
	relevantMemoryFacts: MemoryFact[];
	/** The subagent's own system instructions. */
	agentInstructions: string;
}

/** Structured UI payload for dual-channel delivery (voice + UI). */
export interface UIPayload {
	/** The kind of UI element to render on the client. */
	type: 'choice' | 'confirmation' | 'status' | 'form' | 'image';
	/** Identifier for correlating UI responses back to the originating request. */
	requestId?: string;
	/** Type-specific data for rendering the UI element. */
	data: Record<string, unknown>;
}
