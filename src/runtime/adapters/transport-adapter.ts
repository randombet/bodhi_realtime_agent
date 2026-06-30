/**
 * Transport adapter interface — bridges provider-specific callbacks to
 * canonical control-plane messages.
 *
 * Each provider (Gemini, OpenAI) implements this interface.
 * Audio data does NOT flow through the adapter — it stays on the fast path.
 */

/** Canonical tool call as emitted by the adapter. */
export interface AdapterToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/**
 * Static capability flags forwarded from the underlying `LLMTransport`.
 * Mirrors `TransportCapabilities` from `src/types/transport.ts` but kept on the
 * adapter so actor-runtime code can branch on transport capability without
 * importing the LLM-side types.
 */
export interface AdapterCapabilities {
	/** Whether the underlying provider supports mid-stream response truncation
	 *  (true on OpenAI Realtime; false on Gemini Live). Determines whether
	 *  high-priority background notifications can interrupt model audio. */
	messageTruncation: boolean;
}

/**
 * Provider-agnostic adapter interface.
 *
 * **Inbound callbacks** (provider → actor): Set by TransportActor.onStart().
 * **Outbound commands** (actor → provider): Called by TransportActor.onMessage().
 */
export interface TransportAdapter {
	// -- Static capabilities -------------------------------------------------

	/** Static capability flags forwarded from the underlying `LLMTransport`. */
	readonly capabilities: AdapterCapabilities;

	// -- Inbound callbacks (set by TransportActor) ---------------------------

	/** Fires when the transport session is ready. */
	onSessionReady?: () => void;
	/** Fires when a model turn completes. */
	onTurnComplete?: (turnId?: string) => void;
	/** Fires when the model's response is interrupted. */
	onInterrupted?: () => void;
	/** Fires when the model emits tool calls. */
	onToolCallReceived?: (calls: AdapterToolCall[]) => void;
	/** Fires when the model cancels tool calls. */
	onToolCallCancelled?: (ids: string[]) => void;
	/** Fires on transport error. */
	onError?: (error: string, recoverable: boolean) => void;
	/** Fires when the transport closes. */
	onClosed?: (reason?: string) => void;

	// -- Outbound commands (called by TransportActor) ------------------------

	/** Send content to the transport. */
	sendContent(content: unknown[], turnComplete?: boolean): void;
	/** Send a tool result to the transport. */
	sendToolResult(id: string, name: string, result: unknown, scheduling: string): void;
	/** Initiate a session transfer. */
	transferSession(config: unknown, state: unknown): Promise<void>;
	/** Cancel the current generation. */
	cancelGeneration(): void;
	/** Trigger a new generation. */
	triggerGeneration(): void;
}
