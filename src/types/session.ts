// SPDX-License-Identifier: MIT

import type { ClientMessage } from './audio.js';
import type { ConversationItem } from './conversation.js';

/**
 * Session lifecycle states. Transitions follow a strict state machine:
 *
 *   CREATED → CONNECTING → ACTIVE → RECONNECTING → ACTIVE
 *                           ↓                        ↓
 *                       TRANSFERRING → ACTIVE     CLOSED
 *                           ↓
 *                         CLOSED
 *
 * Any state can transition to CLOSED on fatal error.
 */
export type SessionState =
	| 'CREATED'
	| 'CONNECTING'
	| 'ACTIVE'
	| 'RECONNECTING'
	| 'TRANSFERRING'
	| 'CLOSED';

/** Initial configuration for creating a session manager. */
export interface SessionConfig {
	/** Unique session identifier. */
	sessionId: string;
	/** User identifier for this session. */
	userId: string;
	/** Gemini model to use (e.g. "gemini-2.5-flash-live-001"). */
	geminiModel?: string;
	/** Name of the agent to activate when the session starts. */
	initialAgent: string;
}

/** Tracks the Gemini session resumption state across reconnections. */
export interface ResumptionState {
	/** The most recent resumption handle from Gemini (null before first update). */
	latestHandle: string | null;
	/** Whether the current handle is still valid for resumption. */
	resumable: boolean;
	/** Messages queued during disconnection, to be replayed after reconnection. */
	pendingMessages: ClientMessage[];
}

/** A resumption handle update received from the Gemini server. */
export interface ResumptionUpdate {
	/** Opaque handle string used to resume the Gemini session. */
	handle: string;
	/** Whether the session can be resumed with this handle. */
	resumable: boolean;
}

/**
 * A serializable snapshot of the entire session state.
 * Used by SessionStore for persistence and crash recovery.
 */
export interface SessionCheckpoint {
	sessionId: string;
	userId: string;
	/** Name of the currently active agent. */
	activeAgent: string;
	/** Last known Gemini resumption handle. */
	resumptionHandle: string | null;
	/** Full conversation history at checkpoint time. */
	conversationItems: ConversationItem[];
	/** Compressed conversation summary (null if not yet summarized). */
	conversationSummary: string | null;
	/** Tool calls that were still in flight when the checkpoint was taken. */
	pendingToolCalls: PendingToolCall[];
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

/** Snapshot of a tool call that was in progress when a checkpoint was taken. */
export interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	/** Name of the SubagentConfig handling this call. */
	subagentConfigName: string;
	/** Original arguments passed to the tool. */
	arguments: Record<string, unknown>;
	/** When execution started (Unix ms). */
	startedAt: number;
	/** Configured timeout in milliseconds. */
	timeout: number;
}
