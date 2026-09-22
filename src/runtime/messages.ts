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

/**
 * First-time activation. Emitted by `SessionActor.handleSessionReady` when the
 * previous phase was `'created'` or `'connecting'`. Drives
 * `BackgroundAgentHostActor`'s deferred first `agent.onStart(ctx)` so
 * background agents only start publishing after the live transport is ready.
 */
export interface SessionConnected {
	type: 'session.connected';
}

/**
 * Subsequent activation after a recoverable transport error. Emitted by
 * `SessionActor.handleSessionReady` when the previous phase was
 * `'reconnecting'`. Drives `BackgroundAgent.onReconnect`. Distinguishing this
 * from `session.connected` keeps the supervisor's lifecycle handlers
 * single-purpose without forcing it to subscribe to raw
 * `transport.session_ready` (which fires on every activation indistinguishably).
 */
export interface SessionReconnected {
	type: 'session.reconnected';
}

// ---------------------------------------------------------------------------
// 6. Background notification subsystem
// ---------------------------------------------------------------------------
//
// `NotificationActor` is the actor-mode home of the legacy
// `BackgroundNotificationQueue`. Producers send `notification.publish` to
// inject a synthetic user turn into the live LLM; the actor handles priority,
// audio-received gating, turn-complete flushing, and label-filtered fan-out
// to subscribers via `notification.delivered`.

/**
 * Documented label vocabulary used by in-tree emitters. Producers may pass any
 * string; NotificationActor normalizes it on ingest. This union is a
 * type-level autocomplete hint — combine with `(string & {})` to keep arbitrary
 * user labels valid.
 */
export type KnownNotificationLabel = 'SYSTEM' | 'SUBAGENT UPDATE' | 'SUBAGENT QUESTION';

/** Optional filter on a subscription registration. */
export interface NotificationFilter {
	/** Only deliver notifications whose label is in this set. Omit to receive all labels. */
	labels?: string[];
	/** Only deliver if priority >= this. Default: 'normal' (all). */
	minPriority?: 'normal' | 'high';
}

/**
 * Inject a synthetic user turn ("[label]: text") into the live LLM. Wrapping
 * happens at TransportActor on `notification.delivered`, not at producers.
 */
export interface NotificationPublish {
	type: 'notification.publish';
	/** Optional caller-supplied id; NotificationActor assigns one when absent. */
	id?: string;
	/** Producer-supplied label (validated/normalized: uppercase + sanitize). */
	label: string;
	/** Producer-supplied body text. */
	text: string;
	/** Default `'normal'`. */
	priority?: 'normal' | 'high';
	/** Default `true`. */
	turnComplete?: boolean;
	/** When set, replaces any pending entry with the same key (latest-wins). */
	dedupKey?: string;
}

export interface NotificationSubscribe {
	type: 'notification.subscribe';
	subscriberId: string;
	/** Omitted filter ⇒ deliver every notification. */
	filter?: NotificationFilter;
}

export interface NotificationUnsubscribe {
	type: 'notification.unsubscribe';
	subscriberId: string;
}

/**
 * Once-per-turn signal that the model has begun producing audio this turn.
 * Sent by `VoiceSession` (debounced at the audio fast-path call site) so the
 * audio bytes themselves never enter the actor mailbox.
 */
export interface NotificationAudioStarted {
	type: 'notification.audio_started';
	turnId?: string;
}

/**
 * User barge-in signal mirrored from `adapter.onInterrupted`. Always paired
 * with `notification.reset_audio` (sent first) to match the legacy
 * `resetAudio() + markInterrupted()` call sequence.
 */
export interface NotificationInterrupted {
	type: 'notification.interrupted';
}

/**
 * Model turn boundary mirrored from `adapter.onTurnComplete`. Triggers the
 * flush of one queued notification (unless the turn was interrupted).
 */
export interface NotificationTurnComplete {
	type: 'notification.turn_complete';
	turnId?: string;
}

/**
 * Pre-greeting and post-interrupt reset of the per-turn audio flag. Mirrors
 * legacy `BackgroundNotificationQueue.resetAudio()`. The queue itself is
 * preserved; only the gating flag is cleared.
 */
export interface NotificationResetAudio {
	type: 'notification.reset_audio';
}

/**
 * Drop all pending notifications. Reserved for future explicit drops (e.g.
 * agent-transfer-clears-pending). Not emitted on session close — that is
 * handled by `NotificationActor.onStop` clearing its own state in-place.
 */
export interface NotificationClear {
	type: 'notification.clear';
	reason: string;
}

/**
 * Outbound fan-out envelope to every matching subscriber. TransportActor's
 * handler translates this into `adapter.sendContent` with the wrapped
 * "[label]: text" form; other subscribers (observability, UI) consume the
 * structured payload directly.
 */
export interface NotificationDelivered {
	type: 'notification.delivered';
	id: string;
	label: string;
	text: string;
	priority: 'normal' | 'high';
	turnComplete: boolean;
	publishedAtMs: number;
	deliveredAtMs: number;
	/** = deliveredAtMs - publishedAtMs. */
	deferredMs: number;
}

// ---------------------------------------------------------------------------
// 7. Timeout messages (explicit timer-as-message)
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
	| SessionConnected
	| SessionReconnected
	// Background notification subsystem
	| NotificationPublish
	| NotificationSubscribe
	| NotificationUnsubscribe
	| NotificationAudioStarted
	| NotificationInterrupted
	| NotificationTurnComplete
	| NotificationResetAudio
	| NotificationClear
	| NotificationDelivered
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
