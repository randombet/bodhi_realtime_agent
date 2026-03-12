// SPDX-License-Identifier: MIT

/**
 * Canonical message type union for the actor runtime.
 *
 * All control-plane message types are declared here as a central discriminated
 * union. Payload types start as stubs and are filled in per-step as actors
 * are implemented (Steps 80-83).
 *
 * Audio data does NOT appear here — it stays on the direct-callback fast path.
 *
 * Message naming convention: `domain.action` (e.g., `transport.session_ready`).
 */

// ---------------------------------------------------------------------------
// 1. Transport → Orchestration
// ---------------------------------------------------------------------------

export interface TransportSessionReady {
	type: 'transport.session_ready';
}

export interface TransportTurnComplete {
	type: 'transport.turn_complete';
	turnId?: string;
}

export interface TransportInterrupted {
	type: 'transport.interrupted';
}

export interface TransportToolCallReceived {
	type: 'transport.tool_call_received';
	calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

export interface TransportToolCallCancelled {
	type: 'transport.tool_call_cancelled';
	ids: string[];
}

export interface TransportError {
	type: 'transport.error';
	error: string;
	recoverable: boolean;
}

export interface TransportClosed {
	type: 'transport.closed';
	reason?: string;
}

// ---------------------------------------------------------------------------
// 2. Orchestration → Transport
// ---------------------------------------------------------------------------

export interface TransportSendContent {
	type: 'transport.send_content';
	content: Array<{ role: string; parts: Array<{ text: string }> }>;
	turnComplete?: boolean;
}

export interface TransportSendToolResult {
	type: 'transport.send_tool_result';
	id: string;
	name: string;
	result: unknown;
	scheduling: 'immediate' | 'when_idle';
}

export interface TransportTransferSession {
	type: 'transport.transfer_session';
	config: {
		instructions: string;
		tools: unknown[];
		providerOptions?: Record<string, unknown>;
	};
	state: {
		conversationHistory: unknown;
	};
}

export interface TransportCancelGeneration {
	type: 'transport.cancel_generation';
}

export interface TransportTriggerGeneration {
	type: 'transport.trigger_generation';
}

// ---------------------------------------------------------------------------
// 3. Tool / Subagent lifecycle
// ---------------------------------------------------------------------------

export interface ToolDispatchRequested {
	type: 'tool.dispatch_requested';
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	execution: 'inline' | 'background' | 'transfer';
}

export interface ToolInlineCompleted {
	type: 'tool.inline.completed';
	toolCallId: string;
	toolName: string;
	result: unknown;
}

export interface ToolInlineFailed {
	type: 'tool.inline.failed';
	toolCallId: string;
	toolName: string;
	error: string;
}

export interface SubagentSpawnRequested {
	type: 'subagent.spawn_requested';
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	configName: string;
	lifetime: 'ephemeral' | 'persistent_session';
}

export interface SubagentStarted {
	type: 'subagent.started';
	toolCallId: string;
	workflowId: string;
}

export interface SubagentNeedsInput {
	type: 'subagent.needs_input';
	toolCallId: string;
	workflowId: string;
	question: string;
}

export interface SubagentProgress {
	type: 'subagent.progress';
	toolCallId: string;
	workflowId: string;
	text: string;
}

export interface SubagentCompleted {
	type: 'subagent.completed';
	toolCallId: string;
	workflowId: string;
	result: string;
}

export interface SubagentFailed {
	type: 'subagent.failed';
	toolCallId: string;
	workflowId: string;
	error: string;
}

export interface SubagentCancelRequested {
	type: 'subagent.cancel_requested';
	toolCallId: string;
}

export interface SubagentCancelled {
	type: 'subagent.cancelled';
	toolCallId: string;
	workflowId: string;
}

// ---------------------------------------------------------------------------
// 4. Interaction / UI
// ---------------------------------------------------------------------------

export interface InteractionQuestionPresented {
	type: 'interaction.question_presented';
	toolCallId: string;
	workflowId: string;
	requestId?: string;
}

export interface InteractionUserTextReceived {
	type: 'interaction.user_text_received';
	text: string;
}

export interface InteractionUserOptionSelected {
	type: 'interaction.user_option_selected';
	requestId: string;
	selectedOptionId: string;
}

export interface InteractionAnswerDelivered {
	type: 'interaction.answer_delivered';
	toolCallId: string;
	workflowId: string;
	text: string;
}

// ---------------------------------------------------------------------------
// 5. Session / Agent
// ---------------------------------------------------------------------------

export interface AgentTransferRequested {
	type: 'agent.transfer_requested';
	toAgent: string;
	transferCorrelationId: string;
}

export interface AgentTransferCompleted {
	type: 'agent.transfer_completed';
	fromAgent: string;
	toAgent: string;
	transferCorrelationId: string;
}

export interface AgentTransferFailed {
	type: 'agent.transfer_failed';
	toAgent: string;
	error: string;
	transferCorrelationId: string;
}

export interface SessionCloseRequested {
	type: 'session.close_requested';
	reason?: string;
}

// ---------------------------------------------------------------------------
// 6. Timeout messages (explicit timer-as-message)
// ---------------------------------------------------------------------------

export interface SubagentTimeout {
	type: 'subagent.timeout';
	toolCallId: string;
	workflowId: string;
}

export interface InteractionInputTimeout {
	type: 'interaction.input_timeout';
	toolCallId: string;
	workflowId: string;
}

export interface SessionReconnectTimeout {
	type: 'session.reconnect_timeout';
	attempt: number;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/** All canonical runtime message types. */
export type RuntimeMessage =
	// Transport → Orchestration
	| TransportSessionReady
	| TransportTurnComplete
	| TransportInterrupted
	| TransportToolCallReceived
	| TransportToolCallCancelled
	| TransportError
	| TransportClosed
	// Orchestration → Transport
	| TransportSendContent
	| TransportSendToolResult
	| TransportTransferSession
	| TransportCancelGeneration
	| TransportTriggerGeneration
	// Tool / Subagent lifecycle
	| ToolDispatchRequested
	| ToolInlineCompleted
	| ToolInlineFailed
	| SubagentSpawnRequested
	| SubagentStarted
	| SubagentNeedsInput
	| SubagentProgress
	| SubagentCompleted
	| SubagentFailed
	| SubagentCancelRequested
	| SubagentCancelled
	// Interaction / UI
	| InteractionQuestionPresented
	| InteractionUserTextReceived
	| InteractionUserOptionSelected
	| InteractionAnswerDelivered
	// Session / Agent
	| AgentTransferRequested
	| AgentTransferCompleted
	| AgentTransferFailed
	| SessionCloseRequested
	// Timeouts
	| SubagentTimeout
	| InteractionInputTimeout
	| SessionReconnectTimeout;

/** Extract the type literal from a RuntimeMessage. */
export type RuntimeMessageType = RuntimeMessage['type'];

/**
 * Compile-time exhaustiveness helper for message switch handlers.
 * Usage: `default: assertNever(msg)` in an actor's onMessage switch.
 */
export function assertNever(x: never): never {
	throw new Error(`Unhandled message type: ${(x as RuntimeMessage).type}`);
}
