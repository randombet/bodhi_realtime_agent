import { z } from 'zod';
import * as ai from 'ai';
import { LanguageModelV1 } from 'ai';

/** Classification categories for extracted memory facts. */
type MemoryCategory = 'preference' | 'entity' | 'decision' | 'requirement';
/** A single piece of durable information extracted from conversation about the user. */
interface MemoryFact {
    /** The fact expressed as a self-contained statement. */
    content: string;
    /** Classification of this fact. */
    category: MemoryCategory;
    /** When this fact was extracted (Unix ms). 0 if parsed from storage. */
    timestamp: number;
}
/**
 * Persistence interface for per-user memory facts and directives.
 * Implementations must be safe for concurrent reads and writes.
 * See JsonMemoryStore for the built-in file-based implementation.
 */
interface MemoryStore {
    /** Append new facts to the user's memory (creates the store entry if needed). */
    addFacts(userId: string, facts: MemoryFact[]): Promise<void>;
    /** Retrieve all stored facts for a user (empty array if none). */
    getAll(userId: string): Promise<MemoryFact[]>;
    /** Atomically replace all facts for a user (used by consolidation). */
    replaceAll(userId: string, facts: MemoryFact[]): Promise<void>;
    /** Retrieve structured directives (e.g. behavior presets) for a user. */
    getDirectives(userId: string): Promise<Record<string, string>>;
    /** Persist structured directives for a user (preserves existing facts). */
    setDirectives(userId: string, directives: Record<string, string>): Promise<void>;
}

/** The role of a conversation item, used to distinguish message types in the context. */
type ConversationItemRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'transfer';
/** A single entry in the conversation timeline (message, tool call, or agent transfer). */
interface ConversationItem {
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
interface ToolCall {
    /** Unique ID assigned by Gemini for correlating call → result. */
    toolCallId: string;
    /** Name of the tool being invoked. */
    toolName: string;
    /** Parsed arguments for the tool. */
    args: Record<string, unknown>;
}
/** The result of executing a tool, sent back to Gemini. */
interface ToolResult {
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
interface SubagentTask {
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
interface SubagentResult {
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
interface SubagentContextSnapshot {
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
interface UIPayload {
    /** The kind of UI element to render on the client. */
    type: 'choice' | 'confirmation' | 'status' | 'form' | 'image';
    /** Identifier for correlating UI responses back to the originating request. */
    requestId?: string;
    /** Type-specific data for rendering the UI element. */
    data: Record<string, unknown>;
}

/**
 * How a tool is executed relative to the Gemini audio stream.
 * - `inline`: Executed synchronously — Gemini waits for the result before continuing.
 * - `background`: Handed off to a subagent — Gemini continues speaking while it runs.
 */
type ToolExecution = 'inline' | 'background';
/**
 * Declares a tool that Gemini can invoke during a voice session.
 * The framework converts the Zod schema to a Gemini function declaration,
 * validates arguments at runtime, and routes execution based on the `execution` mode.
 */
interface ToolDefinition {
    /** Unique tool name (must match across declaration and execution). */
    name: string;
    /** Description shown to the model to guide tool selection. */
    description: string;
    /** Zod schema used for both Gemini declaration and runtime argument validation. */
    parameters: z.ZodSchema;
    /** Whether this tool runs inline (blocking) or in the background (non-blocking). */
    execution: ToolExecution;
    /** For background tools: message sent to Gemini immediately so it can acknowledge the request. */
    pendingMessage?: string;
    /** Execution timeout in milliseconds (default 30 000). */
    timeout?: number;
    /** Execute the tool with validated arguments and an abort-aware context. */
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}
/**
 * Runtime context provided to a tool's execute function.
 * Includes identifiers for correlation and an AbortSignal for cancellation.
 */
interface ToolContext {
    /** Unique identifier for this specific tool invocation. */
    toolCallId: string;
    /** Name of the agent that owns this tool. */
    agentName: string;
    /** Session in which this tool call is happening. */
    sessionId: string;
    /** Aborted when the tool call is cancelled (user interruption or timeout). */
    abortSignal: AbortSignal;
    /** Send a JSON message to the connected client (delivered as a WebSocket text frame). */
    sendJsonToClient?(message: Record<string, unknown>): void;
    /**
     * Set an active directive by category key.
     * Directives are reinforced every turn via sendClientContent injection,
     * keeping them fresh in Gemini's context to prevent behavioral drift.
     * Pass null to clear a directive.
     *
     * @param scope — `'session'` persists across agent transfers (e.g. pacing);
     *                `'agent'` (default) is cleared on agent transfer.
     */
    setDirective?(key: string, value: string | null, scope?: 'session' | 'agent'): void;
}

/** Static capabilities — orchestrator branches on these, never on provider names. */
interface TransportCapabilities {
    /** Can truncate server-side message at audio playback position (OpenAI: yes, Gemini: no). */
    messageTruncation: boolean;
    /** Server-side VAD / end-of-turn detection (V1 requires true). */
    turnDetection: boolean;
    /** Provides transcriptions of user audio input. */
    userTranscription: boolean;
    /** Supports in-place session update without reconnection (OpenAI: yes, Gemini: no). */
    inPlaceSessionUpdate: boolean;
    /** Supports session resumption on disconnect (Gemini: yes, OpenAI: no). */
    sessionResumption: boolean;
    /** Supports server-side context compression (Gemini: yes, OpenAI: no). */
    contextCompression: boolean;
    /** Provides grounding metadata with search citations (Gemini: yes, OpenAI: no). */
    groundingMetadata: boolean;
}
/** Audio format descriptor passed to an STT provider at configuration time. */
interface STTAudioConfig {
    /** Sample rate in Hz (e.g. 16000 for Gemini, 24000 for OpenAI). */
    sampleRate: number;
    /** Bits per sample (16). */
    bitDepth: number;
    /** Number of channels (1 = mono). */
    channels: number;
}
/**
 * Provider-agnostic interface for pluggable speech-to-text providers.
 *
 * VoiceSession creates the provider, calls configure() with the transport's
 * audio format, then start(). Audio flows via feedAudio(); turn signals via
 * commit()/handleInterrupted()/handleTurnComplete(). Results arrive via the
 * onTranscript/onPartialTranscript callbacks.
 */
interface STTProvider {
    /** Configure the audio format that feedAudio() will deliver.
     *  Called once before start(). The provider MUST resample or reject
     *  if it cannot handle the given format. */
    configure(audio: STTAudioConfig): void;
    /** Start the STT session (e.g. open WebSocket). */
    start(): Promise<void>;
    /** Stop the STT session (e.g. close WebSocket). */
    stop(): Promise<void>;
    /** Feed audio data. Format matches the STTAudioConfig from configure().
     *  @param base64Pcm Base64-encoded PCM audio chunk. */
    feedAudio(base64Pcm: string): void;
    /** Signal that the user's turn has ended (model started responding).
     *  For batch providers, this triggers transcription.
     *  For streaming providers, this may trigger a manual commit.
     *  @param turnId Monotonically increasing turn counter for ordering. */
    commit(turnId: number): void;
    /** Signal that the current turn was interrupted by the user.
     *  Providers MUST preserve buffered audio for the next commit(). */
    handleInterrupted(): void;
    /** Signal a natural turn completion (model finished, no interruption).
     *  Batch providers SHOULD clear buffers. Streaming providers may no-op. */
    handleTurnComplete(): void;
    /** Final transcription of user speech.
     *  @param text The transcribed text.
     *  @param turnId The turn this transcript belongs to (from commit()).
     *               Undefined when a streaming provider's VAD auto-commits
     *               before the framework calls commit(). */
    onTranscript?: (text: string, turnId: number | undefined) => void;
    /** Partial/interim transcription (streaming providers only).
     *  Replaces any previous partial for the same turn. */
    onPartialTranscript?: (text: string) => void;
}
/** Simple text turn for injection (greetings, directives, text input). */
interface ContentTurn {
    role: 'user' | 'assistant';
    text: string;
}
/**
 * Rich replay item for reconnect/transfer recovery.
 * Preserves the full conversation structure — text, tool calls/results, files,
 * and agent transfers — so that recovery is lossless even for multimodal and
 * tool-heavy sessions.
 */
type ReplayItem = {
    type: 'text';
    role: 'user' | 'assistant';
    text: string;
} | {
    type: 'tool_call';
    id: string;
    name: string;
    args: Record<string, unknown>;
} | {
    type: 'tool_result';
    id: string;
    name: string;
    result: unknown;
    error?: string;
} | {
    type: 'file';
    role: 'user';
    base64Data: string;
    mimeType: string;
} | {
    type: 'transfer';
    fromAgent: string;
    toAgent: string;
};
/** Audio format specification advertised by a transport.
 *  Input and output rates may differ (e.g. Gemini: 16kHz in / 24kHz out). */
interface AudioFormatSpec {
    inputSampleRate: number;
    outputSampleRate: number;
    channels: number;
    bitDepth: number;
    encoding: 'pcm';
}
/** Configuration for establishing a transport connection. */
interface LLMTransportConfig {
    auth: TransportAuth;
    model: string;
    instructions?: string;
    tools?: ToolDefinition[];
    voice?: string;
    transcription?: {
        input?: boolean;
        output?: boolean;
    };
    providerOptions?: Record<string, unknown>;
}
/** Authentication method for the transport. */
type TransportAuth = {
    type: 'api_key';
    apiKey: string;
} | {
    type: 'service_account';
    projectId: string;
    location?: string;
} | {
    type: 'token_provider';
    getToken: () => Promise<string>;
};
/** Partial session update — used for updateSession() and transferSession(). */
interface SessionUpdate {
    instructions?: string;
    tools?: ToolDefinition[];
    providerOptions?: Record<string, unknown>;
}
/** Tool call as delivered by the transport. */
interface TransportToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}
/** Tool result sent back to the transport. */
interface TransportToolResult {
    id: string;
    name: string;
    result: unknown;
    /** Delivery scheduling hint. The transport owns actual timing.
     *  'immediate': send result now (inline tools)
     *  'when_idle': wait for model to finish speaking (background tools)
     *  'interrupt': interrupt current response and deliver immediately
     *  'silent':    send result without triggering a new response */
    scheduling?: 'immediate' | 'when_idle' | 'interrupt' | 'silent';
}
/** State provided to the transport for reconnection/recovery. */
interface ReconnectState {
    /** Full conversation replay for recovery — rich typed items, not text-only. */
    conversationHistory?: ReplayItem[];
    /** In-flight tool calls to recover after reconnect. */
    pendingToolCalls?: TransportPendingToolCall[];
}
/** Snapshot of an in-flight tool call for reconnect recovery. Named TransportPendingToolCall
 *  to avoid conflict with PendingToolCall in session.ts (used for session checkpoints). */
interface TransportPendingToolCall {
    /** Transport-assigned tool call ID (used for idempotency dedup). */
    id: string;
    /** Tool name. */
    name: string;
    /** Parsed arguments. */
    args: Record<string, unknown>;
    /** Whether the tool is still running or has completed. */
    status: 'executing' | 'completed';
    /** Result value (present only when status === 'completed'). */
    result?: unknown;
    /** When execution started (Unix ms). Used for timeout calculation on recovery. */
    startedAt: number;
    /** Max execution time in ms. Transport skips re-execution if wall-clock exceeds this. */
    timeoutMs?: number;
    /** Whether this was an inline or background tool call. */
    execution: 'inline' | 'background';
    /** Name of the agent that owned this tool call at dispatch time. */
    agentName: string;
}
/** Transport-level error with recovery signal. Named LLMTransportError to avoid
 *  collision with the TransportError class in core/errors.ts. */
interface LLMTransportError {
    error: Error;
    recoverable: boolean;
}
/**
 * Provider-agnostic interface for realtime LLM transports.
 *
 * Each provider (Gemini Live, OpenAI Realtime) implements this interface,
 * exposing static capabilities and handling provider-specific wire protocols internally.
 */
interface LLMTransport {
    /** Static capabilities — read before connecting, used for orchestrator branching. */
    readonly capabilities: TransportCapabilities;
    connect(config?: LLMTransportConfig): Promise<void>;
    disconnect(): Promise<void>;
    reconnect(state?: ReconnectState): Promise<void>;
    readonly isConnected: boolean;
    sendAudio(base64Data: string): void;
    readonly audioFormat: AudioFormatSpec;
    commitAudio(): void;
    clearAudio(): void;
    updateSession(config: SessionUpdate): void;
    transferSession(config: SessionUpdate, state?: ReconnectState): Promise<void>;
    sendContent(turns: ContentTurn[], turnComplete?: boolean): void;
    sendFile(base64Data: string, mimeType: string): void;
    sendToolResult(result: TransportToolResult): void;
    triggerGeneration(instructions?: string): void;
    onAudioOutput?: (base64Data: string) => void;
    onToolCall?: (calls: TransportToolCall[]) => void;
    onToolCallCancel?: (ids: string[]) => void;
    onTurnComplete?: () => void;
    onInterrupted?: () => void;
    onInputTranscription?: (text: string) => void;
    onOutputTranscription?: (text: string) => void;
    onSessionReady?: (sessionId: string) => void;
    onError?: (error: LLMTransportError) => void;
    onClose?: (code?: number, reason?: string) => void;
    /** Fires when the model begins any response (audio, tool call, etc.).
     *  Used by VoiceSession to trigger STT provider commit. */
    onModelTurnStart?: () => void;
    onGoAway?: (timeLeft: string) => void;
    onResumptionUpdate?: (handle: string, resumable: boolean) => void;
    onGroundingMetadata?: (metadata: Record<string, unknown>) => void;
}

/**
 * In-memory conversation timeline that tracks all messages, tool calls, and agent transfers.
 *
 * Key concepts:
 * - **Items**: Append-only list of ConversationItems (user messages, assistant messages, tool events, transfers).
 * - **Checkpoint**: A cursor into the items list. `getItemsSinceCheckpoint()` returns only new items since the last checkpoint.
 *   Used by ConversationHistoryWriter and MemoryDistiller to process incremental batches.
 * - **Summary**: A compressed representation of older conversation turns. When set via `setSummary()`,
 *   items before the checkpoint are evicted (they're captured in the summary).
 * - **Token estimate**: Rough heuristic (`content.length / 4`) used to decide when to trigger summarization.
 */
declare class ConversationContext {
    private _items;
    private _summary;
    private checkpointIndex;
    get items(): readonly ConversationItem[];
    get summary(): string | null;
    /** Rough token count estimate for all items + summary (content.length / 4). */
    get tokenEstimate(): number;
    addUserMessage(content: string): void;
    addAssistantMessage(content: string): void;
    addToolCall(call: ToolCall): void;
    addToolResult(result: ToolResult): void;
    addAgentTransfer(fromAgent: string, toAgent: string): void;
    /** Return all items added since the last checkpoint (or all items if no checkpoint set). */
    getItemsSinceCheckpoint(): ConversationItem[];
    /** Advance the checkpoint cursor to the current end of the items list. */
    markCheckpoint(): void;
    /** Store a compressed summary and evict all items before the current checkpoint. */
    setSummary(summary: string): void;
    /** Build a snapshot of conversation state for a subagent (summary + recent turns + memory). */
    getSubagentContext(task: SubagentTask, agentInstructions: string, memoryFacts: MemoryFact[], recentTurnCount?: number): SubagentContextSnapshot;
    /** Format the conversation as provider-neutral ReplayItem[] for replay after reconnection. */
    toReplayContent(): ReplayItem[];
}

/**
 * Optional lifecycle hooks for observability, logging, and metrics.
 * All hooks are synchronous and fire-and-forget — exceptions are caught and logged.
 * Register hooks via VoiceSessionConfig or HooksManager.register().
 */
interface FrameworkHooks {
    /** Fires when the Gemini connection becomes ACTIVE for the first time. */
    onSessionStart?(event: {
        sessionId: string;
        userId: string;
        agentName: string;
    }): void;
    /** Fires when the session transitions to CLOSED. */
    onSessionEnd?(event: {
        sessionId: string;
        durationMs: number;
        reason: string;
    }): void;
    /** Fires at the end of each turn with segment-level latency breakdown. */
    onTurnLatency?(event: {
        sessionId: string;
        turnId: string;
        segments: {
            clientToBackendMs?: number;
            backendToGeminiMs?: number;
            geminiProcessingMs?: number;
            geminiToBackendMs?: number;
            backendToClientMs?: number;
            totalE2EMs: number;
        };
    }): void;
    /** Fires when Gemini requests a tool invocation (before execution). */
    onToolCall?(event: {
        sessionId: string;
        toolCallId: string;
        toolName: string;
        execution: ToolExecution;
        agentName: string;
    }): void;
    /** Fires after a tool completes, is cancelled, or errors. */
    onToolResult?(event: {
        toolCallId: string;
        durationMs: number;
        status: 'completed' | 'cancelled' | 'error';
        error?: string;
    }): void;
    /** Fires after an agent transfer completes (reconnection included). */
    onAgentTransfer?(event: {
        sessionId: string;
        fromAgent: string;
        toAgent: string;
        reconnectMs: number;
    }): void;
    /** Fires after each step of a background subagent's LLM execution. */
    onSubagentStep?(event: {
        subagentName: string;
        stepNumber: number;
        toolCalls: string[];
        tokensUsed: number;
    }): void;
    /** Fires after the memory distiller extracts facts from conversation. */
    onMemoryExtraction?(event: {
        userId: string;
        factsExtracted: number;
        durationMs: number;
    }): void;
    /** Fires on any framework error. Use for centralized error logging/alerting. */
    onError?(event: {
        sessionId?: string;
        component: string;
        error: Error;
        severity: 'warn' | 'error' | 'fatal';
    }): void;
}

/**
 * Manages registered lifecycle hooks and exposes them as getter accessors.
 * Zero-overhead pattern: callers check `if (hooks.onX) hooks.onX(event)`.
 */
declare class HooksManager {
    private hooks;
    /** Register (or overwrite) hook callbacks. Merges with any previously registered hooks. */
    register(hooks: FrameworkHooks): void;
    get onSessionStart(): ((event: {
        sessionId: string;
        userId: string;
        agentName: string;
    }) => void) | undefined;
    get onSessionEnd(): ((event: {
        sessionId: string;
        durationMs: number;
        reason: string;
    }) => void) | undefined;
    get onTurnLatency(): ((event: {
        sessionId: string;
        turnId: string;
        segments: {
            clientToBackendMs?: number;
            backendToGeminiMs?: number;
            geminiProcessingMs?: number;
            geminiToBackendMs?: number;
            backendToClientMs?: number;
            totalE2EMs: number;
        };
    }) => void) | undefined;
    get onToolCall(): ((event: {
        sessionId: string;
        toolCallId: string;
        toolName: string;
        execution: ToolExecution;
        agentName: string;
    }) => void) | undefined;
    get onToolResult(): ((event: {
        toolCallId: string;
        durationMs: number;
        status: "completed" | "cancelled" | "error";
        error?: string;
    }) => void) | undefined;
    get onAgentTransfer(): ((event: {
        sessionId: string;
        fromAgent: string;
        toAgent: string;
        reconnectMs: number;
    }) => void) | undefined;
    get onSubagentStep(): ((event: {
        subagentName: string;
        stepNumber: number;
        toolCalls: string[];
        tokensUsed: number;
    }) => void) | undefined;
    get onMemoryExtraction(): ((event: {
        userId: string;
        factsExtracted: number;
        durationMs: number;
    }) => void) | undefined;
    get onError(): ((event: {
        sessionId?: string;
        component: string;
        error: Error;
        severity: "warn" | "error" | "fatal";
    }) => void) | undefined;
}

/**
 * Runtime context passed to agent lifecycle hooks (onEnter, onExit, onTurnCompleted).
 * Provides read access to session state and the ability to inject messages.
 */
interface AgentContext {
    /** Current session identifier. */
    sessionId: string;
    /** Name of the agent receiving this context. */
    agentName: string;
    /** Inject a system-level message into the conversation (visible to the model on next turn). */
    injectSystemMessage(text: string): void;
    /** Retrieve the most recent conversation turns (default 10). */
    getRecentTurns(count?: number): ConversationItem[];
    /** Retrieve all memory facts currently stored for this user. */
    getMemoryFacts(): MemoryFact[];
}
/**
 * Defines a top-level voice agent that Gemini interacts with directly.
 * Each agent has its own system instructions, tool set, and lifecycle hooks.
 * Agents are registered with VoiceSession and selected via agent transfers.
 */
interface MainAgent {
    /** Unique name used for routing (e.g. "main", "math_expert"). */
    name: string;
    /** System instructions sent to Gemini. Can be a static string or a factory function. */
    instructions: string | (() => string);
    /** Tools available to Gemini when this agent is active. */
    tools: ToolDefinition[];
    /** Enable Gemini's built-in Google Search grounding for this agent.
     *  @deprecated Use providerOptions.googleSearch instead. */
    googleSearch?: boolean;
    /** Provider-specific options passed to the transport during agent transfer. */
    providerOptions?: Record<string, unknown>;
    /** IETF BCP 47 language tag for this agent (e.g., 'zh-CN', 'es-ES', 'ja-JP'). When set, a language directive is prepended to the system instruction. */
    language?: string;
    /** Called when this agent becomes the active agent (after a transfer or initial start). */
    onEnter?(ctx: AgentContext): Promise<void>;
    /** Called when this agent is being replaced by another agent. */
    onExit?(ctx: AgentContext): Promise<void>;
    /** Called after each completed turn while this agent is active. */
    onTurnCompleted?(ctx: AgentContext, transcript: string): Promise<void>;
    /** Optional greeting prompt sent to Gemini when this agent activates and a client is connected.
     *  Gemini will generate a spoken response based on this prompt. */
    greeting?: string;
}
/**
 * Configuration for a background subagent that runs via the Vercel AI SDK.
 * Subagents handle long-running tool calls asynchronously while Gemini continues speaking.
 */
interface SubagentConfig {
    /** Unique name identifying this subagent configuration. */
    name: string;
    /** System instructions for the subagent's LLM call. */
    instructions: string;
    /** Vercel AI SDK tool() definitions available to the subagent. */
    tools: Record<string, unknown>;
    /** Maximum number of LLM steps before stopping (default 5). */
    maxSteps?: number;
    /** Timeout in milliseconds for the entire subagent run. */
    timeout?: number;
    /** Override the model used for this subagent (defaults to session model). */
    model?: string;
    /** When true, a SubagentSession with user interaction capabilities is created. */
    interactive?: boolean;
    /**
     * Optional factory that returns an isolated subagent config instance per handoff.
     * Use this when tool state must not be shared across concurrent background runs.
     */
    createInstance?: () => SubagentConfig;
    /** Optional cleanup function called when the subagent run ends (success, error, or abort). */
    dispose?: () => Promise<void> | void;
}
/**
 * Configuration for a service subagent that reacts to external events
 * (e.g. webhooks, database changes) and can proactively notify the user.
 */
interface ServiceSubagentConfig {
    /** The subagent to invoke when an event matches. */
    agent: SubagentConfig;
    /** Event sources that feed into this service subagent. */
    eventSources: EventSourceConfig[];
    /** Optional filter — return true to invoke the subagent for a given event. */
    shouldInvoke?(event: ExternalEvent): boolean;
}
/**
 * Defines a source of external events (e.g. a webhook listener, polling loop).
 * The framework manages its lifecycle via start/stop.
 */
interface EventSourceConfig {
    /** Human-readable name for logging and debugging. */
    name: string;
    /** Begin emitting events. The signal is aborted when the session closes. */
    start(emit: (event: ExternalEvent) => void, signal: AbortSignal): void;
    /** Gracefully shut down this event source. */
    stop(): Promise<void>;
}
/** An event from an external system delivered to a service subagent. */
interface ExternalEvent {
    /** Originating system (e.g. "webhook", "database"). */
    source: string;
    /** Event type within that source (e.g. "order.created"). */
    type: string;
    /** Arbitrary event payload. */
    data: Record<string, unknown>;
    /** Delivery priority — urgent events may interrupt the current turn. */
    priority?: NotificationPriority;
}
/** Priority level for external event notifications. */
type NotificationPriority = 'normal' | 'urgent';

/**
 * Factory that builds an AgentContext object for agent lifecycle hooks.
 * Wires `injectSystemMessage` and `getRecentTurns` to the live ConversationContext.
 */
declare function createAgentContext(options: {
    sessionId: string;
    agentName: string;
    conversationContext: ConversationContext;
    hooks: HooksManager;
    memoryFacts?: MemoryFact[];
}): AgentContext;

/**
 * PCM 16-bit signed little-endian, 16 kHz mono — Gemini Live API's native audio format.
 * All audio buffers and transport operations assume this format.
 */
declare const AUDIO_FORMAT: {
    readonly sampleRate: 16000;
    readonly channels: 1;
    readonly bitDepth: 16;
    readonly bytesPerSample: 2;
    /** 16000 samples/s * 2 bytes/sample = 32 000 bytes/s */
    readonly bytesPerSecond: 32000;
};
/** Type alias for the AUDIO_FORMAT constant's shape. */
type AudioFormat = typeof AUDIO_FORMAT;
/** Non-audio control message from the client transport (e.g. JSON commands). */
interface ClientMessage {
    /** Message type identifier (application-defined). */
    type: string;
    /** Message payload. */
    data: unknown;
    /** Unix timestamp (ms) when the message was received. */
    timestamp: number;
}

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
type SessionState = 'CREATED' | 'CONNECTING' | 'ACTIVE' | 'RECONNECTING' | 'TRANSFERRING' | 'CLOSED';
/** Initial configuration for creating a session manager. */
interface SessionConfig {
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
interface ResumptionState {
    /** The most recent resumption handle from Gemini (null before first update). */
    latestHandle: string | null;
    /** Whether the current handle is still valid for resumption. */
    resumable: boolean;
    /** Messages queued during disconnection, to be replayed after reconnection. */
    pendingMessages: ClientMessage[];
}
/** A resumption handle update received from the Gemini server. */
interface ResumptionUpdate {
    /** Opaque handle string used to resume the Gemini session. */
    handle: string;
    /** Whether the session can be resumed with this handle. */
    resumable: boolean;
}
/**
 * A serializable snapshot of the entire session state.
 * Used by SessionStore for persistence and crash recovery.
 */
interface SessionCheckpoint {
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
interface PendingToolCall {
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

/**
 * A UI response sent by the client in reply to a UIPayload request.
 * Correlates back to the original request via requestId.
 */
interface UIResponse {
    /** Matches the requestId from the originating UIPayload. */
    requestId: string;
    /** The option the user selected (for 'choice' / 'confirmation' payloads). */
    selectedOptionId?: string;
    /** Form field values (for 'form' payloads). */
    formData?: Record<string, unknown>;
}

/** Function returned by EventBus.subscribe() — call it to remove the subscription. */
type Unsubscribe = () => void;
/**
 * Maps each event type string to its payload shape.
 * EventBus uses this mapped type for compile-time type safety on publish/subscribe.
 *
 * @example
 * ```ts
 * eventBus.subscribe('agent.transfer', (payload) => {
 *   // payload is typed as { sessionId: string; fromAgent: string; toAgent: string }
 * });
 * ```
 */
interface EventPayloadMap {
    'agent.enter': {
        sessionId: string;
        agentName: string;
    };
    'agent.exit': {
        sessionId: string;
        agentName: string;
    };
    'agent.transfer': {
        sessionId: string;
        fromAgent: string;
        toAgent: string;
    };
    'agent.handoff': {
        sessionId: string;
        agentName: string;
        subagentName: string;
        toolCallId: string;
    };
    'tool.call': ToolCall & {
        sessionId: string;
        agentName: string;
    };
    'tool.result': ToolResult & {
        sessionId: string;
    };
    'tool.cancel': {
        sessionId: string;
        toolCallIds: string[];
    };
    'turn.start': {
        sessionId: string;
        turnId: string;
    };
    'turn.end': {
        sessionId: string;
        turnId: string;
    };
    'turn.interrupted': {
        sessionId: string;
        turnId: string;
    };
    'gui.update': {
        sessionId: string;
        data: Record<string, unknown>;
    };
    'gui.notification': {
        sessionId: string;
        message: string;
    };
    'session.start': {
        sessionId: string;
        userId: string;
        agentName: string;
    };
    'session.close': {
        sessionId: string;
        reason: string;
    };
    'session.stateChange': {
        sessionId: string;
        fromState: SessionState;
        toState: SessionState;
    };
    'session.resume': {
        sessionId: string;
        handle: string;
    };
    'session.goaway': {
        sessionId: string;
        timeLeft: string;
    };
    'context.compact': {
        sessionId: string;
        removedItems: number;
    };
    'subagent.ui.send': {
        sessionId: string;
        payload: UIPayload;
    };
    'subagent.ui.response': {
        sessionId: string;
        response: UIResponse;
    };
    'subagent.notification': {
        sessionId: string;
        result: SubagentResult;
        event: ExternalEvent;
    };
}
/** Union of all valid event type strings (e.g. "agent.enter", "tool.call"). */
type EventType = keyof EventPayloadMap;
/** Resolves the payload type for a given event type string. */
type EventPayload<T extends EventType> = EventPayloadMap[T];

/** Callback function type for a specific event type. */
type EventHandler<T extends EventType> = (payload: EventPayload<T>) => void;
/**
 * Type-safe event bus interface.
 * All framework components communicate via this bus for loose coupling.
 */
interface IEventBus {
    /** Synchronously dispatch an event to all registered handlers. */
    publish<T extends EventType>(event: T, payload: EventPayloadMap[T]): void;
    /** Register a handler for an event type. Returns an unsubscribe function. */
    subscribe<T extends EventType>(event: T, handler: EventHandler<T>): Unsubscribe;
    /** Remove all handlers (used for cleanup in tests and session teardown). */
    clear(): void;
}
/**
 * In-memory, synchronous event bus.
 * Handler exceptions are caught and logged — they never propagate to the publisher.
 */
declare class EventBus implements IEventBus {
    private handlers;
    publish<T extends EventType>(event: T, payload: EventPayloadMap[T]): void;
    subscribe<T extends EventType>(event: T, handler: EventHandler<T>): Unsubscribe;
    clear(): void;
}

/**
 * Manages the session state machine and resumption handle.
 * Publishes state-change events to the EventBus and fires lifecycle hooks.
 * Also buffers client messages during disconnected states (RECONNECTING/TRANSFERRING).
 */
declare class SessionManager {
    private eventBus;
    private hooks;
    private _state;
    private _resumptionHandle;
    private _bufferedMessages;
    private startedAt;
    readonly sessionId: string;
    readonly userId: string;
    readonly initialAgent: string;
    constructor(config: SessionConfig, eventBus: IEventBus, hooks: HooksManager);
    get state(): SessionState;
    get isActive(): boolean;
    get isDisconnected(): boolean;
    get resumptionHandle(): string | null;
    /** Reset to CREATED state — allows a fresh session after CLOSED. */
    reset(): void;
    transitionTo(newState: SessionState): void;
    updateResumptionHandle(handle: string): void;
    bufferMessage(message: ClientMessage): void;
    drainBufferedMessages(): ClientMessage[];
}

/** Callbacks fired by ClientTransport when client events occur. */
interface ClientTransportCallbacks {
    /** Raw PCM audio data received from the client WebSocket (binary frames). */
    onAudioFromClient?(data: Buffer): void;
    /** A JSON message received from the client WebSocket (text frames). */
    onJsonFromClient?(message: Record<string, unknown>): void;
    /** A client WebSocket connection was established. */
    onClientConnected?(): void;
    /** The client WebSocket disconnected. */
    onClientDisconnected?(): void;
    /** An image was uploaded by the client (base64-encoded). */
    onImageUpload?(imageBase64: string, mimeType: string): void;
}
/**
 * WebSocket server that bridges a client audio app to the framework.
 *
 * Multiplexes two message types on the same WebSocket connection:
 * - **Binary frames**: Raw PCM audio (forwarded via `onAudioFromClient` or buffered during transfers).
 * - **Text frames**: JSON messages for GUI events (`onJsonFromClient`).
 *
 * Buffering mode (`startBuffering`/`stopBuffering`) only affects binary audio frames.
 * Text frames are always delivered immediately.
 */
declare class ClientTransport {
    private port;
    private callbacks;
    private host;
    private listenTimeoutMs;
    private wss;
    private client;
    private audioBuffer;
    private _buffering;
    constructor(port: number, callbacks: ClientTransportCallbacks, host?: string, listenTimeoutMs?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Send raw PCM audio to the client as a binary frame. */
    sendAudioToClient(data: Buffer): void;
    /** Send a JSON message to the client as a text frame. */
    sendJsonToClient(message: Record<string, unknown>): void;
    startBuffering(): void;
    stopBuffering(): Buffer[];
    get isClientConnected(): boolean;
    get buffering(): boolean;
}

/** Severity level for framework errors, used by the onError hook. */
type ErrorSeverity = 'warn' | 'error' | 'fatal';
/**
 * Base error class for all framework errors.
 * Carries a `component` tag and `severity` level for structured error handling.
 * Supports cause chaining via the standard `cause` property.
 */
declare class FrameworkError extends Error {
    readonly component: string;
    readonly severity: ErrorSeverity;
    readonly cause?: Error;
    constructor(message: string, options: {
        component: string;
        severity?: ErrorSeverity;
        cause?: Error;
    });
}
/** Error originating from the Gemini or client WebSocket transport layer. */
declare class TransportError extends FrameworkError {
    constructor(message: string, options?: {
        severity?: ErrorSeverity;
        cause?: Error;
    });
}
/** Error related to session state machine transitions or lifecycle. */
declare class SessionError extends FrameworkError {
    constructor(message: string, options?: {
        severity?: ErrorSeverity;
        cause?: Error;
    });
}
/** Error during tool execution (timeout, validation failure, runtime exception). */
declare class ToolExecutionError extends FrameworkError {
    constructor(message: string, options?: {
        severity?: ErrorSeverity;
        cause?: Error;
    });
}
/** Error related to agent routing, transfers, or subagent execution. */
declare class AgentError extends FrameworkError {
    constructor(message: string, options?: {
        severity?: ErrorSeverity;
        cause?: Error;
    });
}
/** Error in the memory extraction or consolidation pipeline. */
declare class MemoryError extends FrameworkError {
    constructor(message: string, options?: {
        severity?: ErrorSeverity;
        cause?: Error;
    });
}
/** Error from input validation (Zod schema, config checks). */
declare class ValidationError extends FrameworkError {
    constructor(message: string, options?: {
        severity?: ErrorSeverity;
        cause?: Error;
    });
}

/** Thrown when a SubagentSession is cancelled (user disconnect, agent transfer, explicit cancel). */
declare class CancelledError extends FrameworkError {
    constructor(message?: string);
}
/** Thrown when waitForInput() exceeds its timeout. */
declare class InputTimeoutError extends FrameworkError {
    constructor(timeoutMs: number);
}
/** Thrown when the session completes while a waitForInput()/nextUserInput() is pending. */
declare class SessionCompletedError extends FrameworkError {
    constructor();
}
/** Message sent from a subagent to the user via the main voice agent. */
interface SubagentMessage {
    type: 'progress' | 'question' | 'approval_request' | 'result';
    text: string;
    action?: string;
    blocking?: boolean;
    uiPayload?: UIPayload;
}
/** SubagentSession lifecycle states. */
type SubagentSessionState = 'running' | 'waiting_for_input' | 'completed' | 'cancelled';
/** Extends SubagentConfig with interactive session options. */
interface InteractiveSubagentConfig extends SubagentConfig {
    /** Whether this subagent supports interactive user input. */
    interactive?: boolean;
    /** Timeout per waitForInput() call in ms. Default: 120_000 (2 min). */
    inputTimeout?: number;
    /** Max retries before cancellation on timeout. Default: 3. */
    maxInputRetries?: number;
}
type MessageHandler = (msg: SubagentMessage) => void;
type StateChangeHandler = (newState: SubagentSessionState, oldState: SubagentSessionState) => void;
/** Structured option for UI button choices. */
interface SubagentOption {
    id: string;
    label: string;
    description: string;
}
/** Public interface for interacting with an interactive subagent session. */
interface SubagentSession {
    readonly toolCallId: string;
    readonly state: SubagentSessionState;
    sendToUser(msg: SubagentMessage): void;
    sendToSubagent(input: string): void;
    /** Non-throwing variant: returns false if state is not 'waiting_for_input'. */
    trySendToSubagent(input: string): boolean;
    waitForInput(timeoutMs?: number): Promise<string>;
    nextUserInput(): Promise<string>;
    cancellation(): Promise<never>;
    onMessage(handler: MessageHandler): void;
    onStateChange(handler: StateChangeHandler): void;
    /** Register a UI request for option-based responses (requestId → options mapping). */
    registerUiRequest(requestId: string, options: SubagentOption[]): void;
    /** Look up an option by requestId and selectedOptionId. */
    resolveOption(requestId: string, selectedOptionId: string): SubagentOption | undefined;
    /** Check if this session has a pending UI request with the given requestId. */
    hasUiRequest(requestId: string): boolean;
    cancel(): void;
    complete(result: unknown): void;
}
declare class SubagentSessionImpl implements SubagentSession {
    readonly toolCallId: string;
    private _state;
    private readonly config;
    private readonly messageHandlers;
    private readonly stateChangeHandlers;
    /** At most one pending waitForInput()/nextUserInput() at a time. */
    private pendingInput;
    /** Pending cancellation() Promise — rejects on cancel(). */
    private pendingCancellation;
    /** UI request registry: requestId → options for mapping button clicks back to labels. */
    private readonly uiRequests;
    constructor(toolCallId: string, config?: InteractiveSubagentConfig);
    get state(): SubagentSessionState;
    sendToUser(msg: SubagentMessage): void;
    sendToSubagent(input: string): void;
    trySendToSubagent(input: string): boolean;
    registerUiRequest(requestId: string, options: SubagentOption[]): void;
    resolveOption(requestId: string, selectedOptionId: string): SubagentOption | undefined;
    hasUiRequest(requestId: string): boolean;
    waitForInput(timeoutMs?: number): Promise<string>;
    nextUserInput(): Promise<string>;
    cancellation(): Promise<never>;
    onMessage(handler: MessageHandler): void;
    onStateChange(handler: StateChangeHandler): void;
    cancel(): void;
    complete(_result: unknown): void;
    private transitionTo;
    private rejectAllPending;
}

/** Callbacks for interactive subagent lifecycle events. */
interface SubagentEventCallbacks {
    /** Fired when a subagent sends a message (question, progress) to the user. */
    onMessage?: (toolCallId: string, msg: SubagentMessage) => void;
    /** Fired when a subagent session transitions to a terminal state (completed/cancelled). */
    onSessionEnd?: (toolCallId: string) => void;
}
/**
 * Manages agent lifecycle: transfers between MainAgents and handoffs to background subagents.
 *
 * **Transfer flow** (agent → agent):
 *   onExit → agent.exit event → TRANSFERRING → buffer audio → disconnect →
 *   reconnect with new agent config → replay context + buffered audio →
 *   ACTIVE → onEnter → agent.enter event → agent.transfer event
 *
 * **Handoff flow** (background tool → subagent):
 *   Create AbortController → build context snapshot → agent.handoff event →
 *   runSubagent() async → return SubagentResult
 */
declare class AgentRouter {
    private sessionManager;
    private eventBus;
    private hooks;
    private conversationContext;
    private transport;
    private clientTransport;
    private model;
    private getInstructionSuffix?;
    private extraTools;
    private subagentCallbacks?;
    private agents;
    private _activeAgent;
    private activeSubagents;
    constructor(sessionManager: SessionManager, eventBus: IEventBus, hooks: HooksManager, conversationContext: ConversationContext, transport: LLMTransport, clientTransport: ClientTransport, model: LanguageModelV1, getInstructionSuffix?: (() => string) | undefined, extraTools?: ToolDefinition[], subagentCallbacks?: SubagentEventCallbacks | undefined);
    registerAgents(agents: MainAgent[]): void;
    setInitialAgent(agentName: string): void;
    get activeAgent(): MainAgent;
    /**
     * Transfer the active LLM session to a different agent.
     * Uses transport.transferSession() — the transport decides whether to
     * apply in-place (OpenAI session.update) or reconnect-based (Gemini).
     */
    transfer(toAgentName: string): Promise<void>;
    /** Look up the SubagentSession for an active interactive subagent, or null. */
    getSubagentSession(toolCallId: string): SubagentSession | null;
    /** Find the SubagentSession that has a pending UI request with the given requestId. */
    findSessionByRequestId(requestId: string): SubagentSession | null;
    /** Spawn a background subagent to handle a tool call asynchronously. */
    handoff(toolCall: ToolCall, subagentConfig: SubagentConfig): Promise<SubagentResult>;
    /** Abort a running background subagent by its originating tool call ID. */
    cancelSubagent(toolCallId: string): void;
    get activeSubagentCount(): number;
    private createContext;
}

/** Options for running a background subagent via the Vercel AI SDK. */
interface RunSubagentOptions {
    /** Subagent configuration (instructions, tools, maxSteps). */
    config: SubagentConfig;
    /** Conversation snapshot providing context for the subagent. */
    context: SubagentContextSnapshot;
    /** Hook manager for onSubagentStep notifications. */
    hooks: HooksManager;
    /** Language model to use for the subagent's generateText call. */
    model: LanguageModelV1;
    /** Signal to abort the subagent execution (e.g. on tool cancellation). */
    abortSignal?: AbortSignal;
    /** Interactive session for user input. Required when config.interactive is true. */
    session?: SubagentSession;
}
/**
 * Create an AI SDK `tool()` that lets the subagent ask the user a question
 * and wait for a response via the interactive SubagentSession.
 *
 * Supports optional structured `options` with stable IDs for dual-channel
 * delivery (voice + UI buttons). When options are present, a `uiPayload`
 * is included so the client can render clickable buttons.
 */
declare function createAskUserTool(session: SubagentSession, maxInputRetries: number): ai.Tool<z.ZodObject<{
    question: z.ZodString;
    options: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        description: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        id: string;
        label: string;
        description: string;
    }, {
        id: string;
        label: string;
        description: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    question: string;
    options?: {
        id: string;
        label: string;
        description: string;
    }[] | undefined;
}, {
    question: string;
    options?: {
        id: string;
        label: string;
        description: string;
    }[] | undefined;
}>, {
    userResponse: string;
    error?: undefined;
} | {
    error: string;
    userResponse?: undefined;
}> & {
    execute: (args: {
        question: string;
        options?: {
            id: string;
            label: string;
            description: string;
        }[] | undefined;
    }, options: ai.ToolExecutionOptions) => PromiseLike<{
        userResponse: string;
        error?: undefined;
    } | {
        error: string;
        userResponse?: undefined;
    }>;
};
/**
 * Execute a background subagent using the Vercel AI SDK's generateText.
 * Fires onSubagentStep hooks after each LLM step.
 * Returns the final text result and step count.
 *
 * When `config.interactive` is true and a `session` is provided, an `ask_user`
 * tool is injected and this function owns the session's terminal transitions
 * (complete on success, cancel on error).
 */
declare function runSubagent(options: RunSubagentOptions): Promise<SubagentResult>;

type Turn = {
    role: string;
    parts: Array<{
        text: string;
    }>;
};
/** Priority for notification delivery. */
type QueuePriority = 'normal' | 'high';
/** Options for sendOrQueue. */
interface SendOrQueueOptions {
    /** Delivery priority. 'high' attempts immediate delivery or front-of-queue. Default: 'normal'. */
    priority?: QueuePriority;
    /** Tool call ID for deduplication. If provided, prevents duplicate notifications for the same tool call. */
    toolCallId?: string;
}
/**
 * Queues background tool completion notifications when the LLM is actively
 * generating audio, and flushes them one-at-a-time at turn boundaries.
 *
 * Extracted from VoiceSession to isolate the queuing/delivery concern.
 * On transports without messageTruncation (Gemini), the model silently absorbs
 * client content while generating — notifications must be held until the model
 * finishes its current turn. On transports with messageTruncation (OpenAI),
 * high-priority messages can be delivered immediately (the transport handles
 * response cancellation internally).
 */
declare class BackgroundNotificationQueue {
    private sendContent;
    private log;
    private messageTruncation;
    private queue;
    private audioReceived;
    private interrupted;
    /** Track tool calls that have already been notified to prevent duplicates. */
    private sentNotifications;
    constructor(sendContent: (turns: Turn[], turnComplete: boolean) => void, log: (msg: string) => void, messageTruncation?: boolean);
    /**
     * Send a notification immediately if the model is idle, or queue it if
     * the model is currently generating audio.
     *
     * High-priority messages attempt immediate delivery when the transport
     * supports message truncation (OpenAI). On non-truncation transports (Gemini),
     * high-priority messages are queued at the front of the queue.
     *
     * Deduplication: If a toolCallId is provided and has already been notified,
     * the notification is silently skipped to prevent race conditions where a
     * background task completes synchronously before audio generation begins.
     */
    sendOrQueue(turns: Turn[], turnComplete: boolean, options?: SendOrQueueOptions): void;
    /** Mark that the first audio chunk has been received this turn. */
    markAudioReceived(): void;
    /** Mark that the current turn was interrupted by the user. */
    markInterrupted(): void;
    /**
     * Handle turn completion: reset audio/interruption flags and flush one
     * queued notification (unless the turn was interrupted).
     */
    onTurnComplete(): void;
    /** Reset audio flag without flushing (used when starting a new greeting). */
    resetAudio(): void;
    /** Drop all queued notifications (used on session close). */
    clear(): void;
    private flushOne;
}

/** Default timeout for individual tool executions (ms). */
declare const DEFAULT_TOOL_TIMEOUT_MS = 30000;
/** Default timeout for memory extraction via AI (ms). */
declare const DEFAULT_EXTRACTION_TIMEOUT_MS = 30000;
/** Default timeout for Gemini Live API connect/setupComplete (ms). */
declare const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
/** Default timeout for reconnection (disconnect + connect) (ms). */
declare const DEFAULT_RECONNECT_TIMEOUT_MS = 45000;
/** Default timeout for subagent execution (ms). */
declare const DEFAULT_SUBAGENT_TIMEOUT_MS = 60000;

/**
 * Manages session-scoped and agent-scoped directives.
 *
 * Extracted from VoiceSession to isolate the directive management concern.
 * Session directives persist across agent transfers; agent directives are
 * cleared on each transfer.
 */
declare class DirectiveManager {
    private agentDirectives;
    private sessionDirectives;
    /** Set or delete a directive. Defaults to agent scope if not specified. */
    set(key: string, value: string | null, scope?: 'session' | 'agent'): void;
    /** Clear agent-scoped directives (called on agent transfer). */
    clearAgent(): void;
    /** Returns session-scoped directives formatted as a system instruction suffix. */
    getSessionSuffix(): string;
    /**
     * Merge both directive maps and return formatted reinforcement text.
     * Agent directives override session directives with the same key.
     * Returns empty string if no directives are set.
     */
    getReinforcementText(): string;
}

/**
 * Tracks whether user transcript should flow to the main LLM agent or
 * to an interactive subagent that is waiting for user input.
 *
 * Only one subagent can be the active interaction target at a time.
 * Additional subagents that request interaction are queued (FIFO) and
 * promoted when the currently active one deactivates.
 */
/** Discriminated union describing who currently owns user transcript. */
type SessionInteractionMode = {
    type: 'main_agent';
} | {
    type: 'subagent_interaction';
    toolCallId: string;
    prompt?: string;
};
/**
 * Manages the FIFO queue for interactive subagent sessions.
 *
 * - `activate()` — makes this subagent the interaction target (or queues it).
 * - `deactivate()` — clears the active interaction and promotes the next queued entry.
 * - `getMode()` — returns the current `SessionInteractionMode`.
 */
declare class InteractionModeManager {
    private mode;
    private queue;
    /** Returns the current interaction mode. */
    getMode(): SessionInteractionMode;
    /** Shorthand: true when a subagent owns user transcript. */
    isSubagentActive(): boolean;
    /** Returns the active subagent's toolCallId, or null if in main_agent mode. */
    getActiveToolCallId(): string | null;
    /**
     * Request interaction ownership for the given subagent.
     *
     * - If no subagent is currently active, activates immediately (returned Promise resolves).
     * - If another subagent is active, enqueues this one (FIFO). The returned Promise
     *   resolves when this subagent is promoted to the active interaction target.
     */
    activate(toolCallId: string, prompt?: string): Promise<void>;
    /**
     * Release interaction ownership for the given subagent.
     *
     * If this subagent is the active one, promotes the next queued entry (if any)
     * or reverts to `main_agent` mode. If the subagent is queued (not active),
     * removes it from the queue.
     */
    deactivate(toolCallId: string): void;
    /** Number of subagents waiting in the queue (excluding the active one). */
    get queueLength(): number;
    private promoteNext;
}

/** Metadata for a single voice session, stored by ConversationHistoryStore. */
interface SessionRecord {
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
interface SessionAnalytics {
    turnCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    toolCallCount: number;
    agentTransferCount: number;
    totalTokens?: number;
}
/** A full session report including conversation items and pending tool state. */
interface SessionReport extends SessionRecord {
    /** Complete conversation timeline. */
    items: ConversationItem[];
    /** Tool calls that were still running when the session ended. */
    pendingToolCalls: PendingToolCall[];
}
/** Lightweight session summary for listing endpoints (no conversation items). */
interface SessionSummary {
    id: string;
    userId: string;
    initialAgentName: string;
    status: 'active' | 'ended' | 'error';
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
}
/** Cursor-based pagination options for history queries. */
interface PaginationOptions {
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
interface ConversationHistoryStore {
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

/**
 * EventBus-driven writer that persists conversation items to a ConversationHistoryStore.
 *
 * Subscribes to session lifecycle events and flushes incremental batches of conversation
 * items (since the last checkpoint) to the store. Tracks session analytics counters
 * and writes a final SessionReport on session close.
 *
 * Call `dispose()` to unsubscribe from all events.
 */
declare class ConversationHistoryWriter {
    private sessionId;
    private userId;
    private initialAgentName;
    private eventBus;
    private conversationContext;
    private store;
    private unsubscribers;
    private analytics;
    constructor(sessionId: string, userId: string, initialAgentName: string, eventBus: IEventBus, conversationContext: ConversationContext, store: ConversationHistoryStore);
    private subscribe;
    dispose(): void;
    private handleSessionStart;
    private handleTurnEnd;
    private handleSessionClose;
    private flush;
    private updateAnalytics;
    private mapReason;
}

/**
 * Persistence interface for session checkpoints (crash recovery / session restore).
 * Implementations should deep-copy on save/load to prevent shared-reference mutations.
 */
interface SessionStore {
    /** Persist a session checkpoint (overwrites any existing checkpoint for this session). */
    save(checkpoint: SessionCheckpoint): Promise<void>;
    /** Load a session checkpoint by ID (null if not found). */
    load(sessionId: string): Promise<SessionCheckpoint | null>;
    /** Delete a session checkpoint. */
    delete(sessionId: string): Promise<void>;
}
/**
 * Map-based in-memory implementation of SessionStore.
 * Uses structuredClone for deep-copy isolation between save/load calls.
 */
declare class InMemorySessionStore implements SessionStore {
    private store;
    save(checkpoint: SessionCheckpoint): Promise<void>;
    load(sessionId: string): Promise<SessionCheckpoint | null>;
    delete(sessionId: string): Promise<void>;
}

/**
 * Caches memory facts from a MemoryStore for quick in-session access.
 *
 * Extracted from VoiceSession to isolate the memory caching concern.
 * Callers use `refresh()` to reload from the store and `facts` to read
 * the latest cached snapshot. Failures during refresh are non-fatal —
 * the previous cache is retained.
 */
declare class MemoryCacheManager {
    private store;
    private userId;
    private cache;
    constructor(store: MemoryStore, userId: string);
    /** Reload cached facts from the store. Best-effort: keeps stale cache on failure. */
    refresh(): Promise<void>;
    /** Return the current cached facts. */
    get facts(): MemoryFact[];
}

/**
 * Executes inline tool calls requested by Gemini.
 *
 * For each tool call: validates arguments via Zod, creates an AbortController,
 * fires onToolCall/onToolResult hooks, publishes EventBus events, and enforces timeouts.
 * Multiple tool calls can run concurrently — each is tracked in the `pending` map.
 */
declare class ToolExecutor {
    private hooks;
    private eventBus;
    private sessionId;
    private agentName;
    private sendJsonToClient?;
    private setDirective?;
    private tools;
    private pending;
    constructor(hooks: HooksManager, eventBus: IEventBus, sessionId: string, agentName: string, sendJsonToClient?: ((message: Record<string, unknown>) => void) | undefined, setDirective?: ((key: string, value: string | null, scope?: "session" | "agent") => void) | undefined);
    register(tools: ToolDefinition[]): void;
    /** Execute a tool call: validate args, run with timeout, fire hooks, return result. */
    handleToolCall(call: ToolCall): Promise<ToolResult>;
    /** Abort one or more pending tool executions and fire cancellation hooks/events. */
    cancel(toolCallIds: string[]): void;
    get pendingCount(): number;
    private executeWithTimeout;
}

/** Callbacks fired by TranscriptManager when transcript state changes. */
interface TranscriptSink {
    /** Send a JSON message to the connected client (partial or final transcript). */
    sendToClient(msg: Record<string, unknown>): void;
    /** Record a finalized user message in conversation context. */
    addUserMessage(text: string): void;
    /** Record a finalized assistant message in conversation context. */
    addAssistantMessage(text: string): void;
}
/**
 * Manages input/output transcription buffering, deduplication, and flushing.
 *
 * Extracted from VoiceSession to isolate transcript accumulation from session
 * orchestration. Callers feed in transcription events; the manager buffers,
 * deduplicates across tool-call boundaries, and flushes finalized text to
 * the provided sink.
 */
declare class TranscriptManager {
    private sink;
    private inputBuffer;
    private outputBuffer;
    /** Pre-tool-call output text, saved when a tool call splits a turn. */
    private outputPrefix;
    /**
     * Optional callback fired when user input is finalized (committed as a non-partial message).
     * Triggers from both `flushInput()` and the input-flushing section of `flush()`.
     * Used by VoiceSession to relay finalized user text to interactive subagent sessions.
     */
    onInputFinalized?: (text: string) => void;
    constructor(sink: TranscriptSink);
    /** Handle a partial/interim transcript from a streaming STT provider.
     *  Sends to client for live display but does NOT accumulate in inputBuffer.
     *  The streaming provider manages its own partial state — each partial
     *  replaces the previous one on the client. */
    handleInputPartial(text: string): void;
    /** Accumulate incoming user speech transcription and emit a partial transcript. */
    handleInput(text: string): void;
    /** Accumulate incoming model speech transcription and emit a partial transcript. */
    handleOutput(text: string): void;
    /**
     * Save current output buffer as prefix and reset buffer.
     * Called before tool execution so post-tool transcription can be deduplicated.
     */
    saveOutputPrefix(): void;
    /**
     * Flush only the input transcript buffer — finalize as a user message and
     * send a non-partial transcript to the client. Used before tool calls so
     * the user utterance appears in context before tool results.
     */
    flushInput(): void;
    /** Flush all transcript buffers — finalize user and assistant messages. */
    flush(): void;
    /**
     * Combine pre-tool prefix and post-tool buffer, deduplicating any overlap.
     *
     * Gemini's outputTranscription can "leak" post-tool text into the pre-tool
     * stream, then re-send it after the tool result. This finds the longest
     * suffix of prefix that matches a prefix of buffer and removes the overlap.
     */
    private combineOutput;
}

/** Callbacks that the ToolCallRouter needs from VoiceSession. */
interface ToolCallRouterDeps {
    toolExecutor: ToolExecutor;
    agentRouter: AgentRouter;
    conversationContext: ConversationContext;
    notificationQueue: BackgroundNotificationQueue;
    transcriptManager: TranscriptManager;
    subagentConfigs: Record<string, SubagentConfig>;
    /** Send a tool result back to the LLM transport. */
    sendToolResult(result: TransportToolResult): void;
    /** Trigger an agent transfer. */
    transfer(toAgent: string): Promise<void>;
    /** Report an error via hooks/logging. */
    reportError(component: string, error: unknown): void;
    /** Diagnostic log. */
    log(msg: string): void;
}
/**
 * Routes tool calls from the LLM to the correct execution path:
 * inline execution, background subagent handoff, or agent transfer.
 *
 * Extracted from VoiceSession to reduce its line count and isolate
 * tool call routing as a self-contained concern.
 */
declare class ToolCallRouter {
    private deps;
    constructor(deps: ToolCallRouterDeps);
    /** Update the tool executor (e.g. after an agent transfer). */
    set toolExecutor(executor: ToolExecutor);
    /** Dispatch incoming tool calls to the appropriate handler. */
    handleToolCalls(calls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
    }>): void;
    /** Abort one or more pending tool executions and subagents. */
    handleToolCallCancellation(ids: string[]): void;
    private handleInlineToolCall;
    private handleBackgroundToolCall;
}

/** A single preset within a behavior category. */
interface BehaviorPreset {
    /** Machine-readable preset name (enum value in tool schema). */
    name: string;
    /** Human-readable label for client UI display. */
    label: string;
    /** Directive text injected into model context. null = clear directive. */
    directive: string | null;
}
/** Declares a tunable behavior with discrete presets. */
interface BehaviorCategory {
    /** Unique category key — becomes the directive key (e.g. "pacing"). */
    key: string;
    /** Tool name auto-generated for the LLM (e.g. "set_pacing"). */
    toolName: string;
    /** Tool description shown to the LLM for tool selection. */
    toolDescription: string;
    /** Ordered presets. First preset is the default. */
    presets: BehaviorPreset[];
    /** Directive scope. 'session' (default) persists across agent transfers. */
    scope?: 'session' | 'agent';
}

/**
 * Configuration for creating a VoiceSession.
 */
interface VoiceSessionConfig {
    /** Unique session identifier. */
    sessionId: string;
    /** User identifier (used for memory storage and history). */
    userId: string;
    /** Google API key for the Gemini Live API (used when no transport is provided). */
    apiKey: string;
    /** All agents available in this session. */
    agents: MainAgent[];
    /** Name of the agent to activate on start. */
    initialAgent: string;
    /** Background subagent configs keyed by tool name. */
    subagentConfigs?: Record<string, SubagentConfig>;
    /** Lifecycle hooks for observability. */
    hooks?: FrameworkHooks;
    /** Port for the client WebSocket server. */
    port: number;
    /** Host for the client WebSocket server (default: '0.0.0.0' for all interfaces). */
    host?: string;
    /** LLM model name (e.g. "gemini-live-2.5-flash-preview"). */
    geminiModel?: string;
    /** Vercel AI SDK model for subagent text generation. */
    model: LanguageModelV1;
    /** Voice configuration for Gemini's speech output. */
    speechConfig?: {
        voiceName?: string;
    };
    /** Context window compression thresholds. */
    compressionConfig?: {
        triggerTokens: number;
        targetTokens: number;
    };
    /** Enable server-side transcription of user audio input (default: true).
     *  Has no effect when sttProvider is set (built-in is disabled automatically).
     *  Use false to disable all input transcription for privacy or cost control. */
    inputAudioTranscription?: boolean;
    /** External STT provider for user input transcription.
     *  When set, transport built-in transcription is automatically disabled.
     *  When omitted, the transport's built-in transcription is used. */
    sttProvider?: STTProvider;
    /** Behavior categories for dynamic runtime tuning (speech speed, verbosity, etc.). */
    behaviors?: BehaviorCategory[];
    /** Enable memory distillation. Extracts durable user facts from conversation and persists them. */
    memory?: {
        /** Where to persist extracted facts. */
        store: MemoryStore;
        /** Extract every N turns (default: 5). */
        turnFrequency?: number;
    };
    /** Pre-constructed LLM transport. If provided, apiKey/geminiModel/speechConfig/compressionConfig are ignored. */
    transport?: LLMTransport;
}
/**
 * Top-level integration hub that wires all framework components together.
 *
 * Manages the full lifecycle of a real-time voice session:
 * - **Audio fast-path**: Client audio → LLM (and back) without touching the EventBus.
 * - **Tool routing**: Inline tools execute synchronously; background tools hand off to subagents.
 * - **Agent transfers**: Intercepts `transfer_to_agent` tool calls and delegates to AgentRouter.
 * - **Reconnection**: Handles GoAway signals and unexpected disconnects via session resumption.
 * - **Conversation tracking**: Transcriptions populate ConversationContext automatically.
 *
 * @example
 * ```ts
 * const session = new VoiceSession({
 *   sessionId: 'session_1',
 *   userId: 'user_1',
 *   apiKey: process.env.GOOGLE_API_KEY,
 *   agents: [mainAgent, expertAgent],
 *   initialAgent: 'main',
 *   port: 9900,
 *   model: google('gemini-2.5-flash'),
 * });
 * await session.start();
 * ```
 */
declare class VoiceSession {
    readonly eventBus: EventBus;
    readonly sessionManager: SessionManager;
    readonly conversationContext: ConversationContext;
    readonly hooks: HooksManager;
    private transport;
    private clientTransport;
    private agentRouter;
    private toolExecutor;
    private toolCallRouter;
    private subagentConfigs;
    private behaviorManager?;
    private memoryDistiller?;
    private memoryCacheManager?;
    private turnId;
    private sttProvider?;
    private _commitFiredForTurn;
    private config;
    private directiveManager;
    private transcriptManager;
    /** Whether a client WebSocket connection is currently active. */
    private _clientConnected;
    /** Whether a browser client is currently connected via WebSocket. */
    get clientConnected(): boolean;
    private notificationQueue;
    private interactionMode;
    constructor(config: VoiceSessionConfig);
    /**
     * Queue a short spoken update for the user.
     * Delivered immediately when possible, otherwise after the current turn.
     */
    notifyBackground(text: string, options?: {
        priority?: 'normal' | 'high';
        label?: 'SUBAGENT UPDATE' | 'SUBAGENT QUESTION';
    }): void;
    /** Start the client WebSocket server and connect to the LLM transport. */
    start(): Promise<void>;
    /** Gracefully shut down: disconnect Gemini, stop the WebSocket server, transition to CLOSED. */
    close(_reason?: string): Promise<void>;
    /** Transfer the active session to a different agent (reconnects with new config). */
    transfer(toAgent: string): Promise<void>;
    private createToolExecutor;
    private handleAudioFromClient;
    private handleAudioOutput;
    private handleSetupComplete;
    private handleTurnComplete;
    /** Inject all active directives into the LLM's context to prevent behavioral drift. */
    private reinforceDirectives;
    /** Send the active agent's greeting prompt to the LLM to trigger a spoken greeting. */
    private sendGreeting;
    private handleInterrupted;
    /** Handle a message from an interactive subagent (question, progress update). */
    private handleSubagentMessage;
    private handleGroundingMetadata;
    private handleGoAway;
    private handleResumptionUpdate;
    private handleJsonFromClient;
    private handleFileUpload;
    private handleTextInput;
    private handleClientConnected;
    private handleClientDisconnected;
    private handleTransportError;
    private handleTransportClose;
    private reportError;
    /** Compact diagnostic log: HH:MM:SS.mmm [VoiceSession] message */
    private log;
}

/**
 * File-based MemoryStore that persists facts and directives as a JSON file per user.
 *
 * File layout (`{baseDir}/{userId}.json`):
 * ```json
 * {
 *   "directives": { "pacing": "slow" },
 *   "facts": [
 *     { "content": "Prefers dark mode", "category": "preference" }
 *   ]
 * }
 * ```
 *
 * All writes use `write-file-atomic` for crash-safe persistence.
 */
declare class JsonMemoryStore implements MemoryStore {
    private baseDir;
    constructor(baseDir: string);
    addFacts(userId: string, facts: MemoryFact[]): Promise<void>;
    getAll(userId: string): Promise<MemoryFact[]>;
    replaceAll(userId: string, facts: MemoryFact[]): Promise<void>;
    getDirectives(userId: string): Promise<Record<string, string>>;
    setDirectives(userId: string, directives: Record<string, string>): Promise<void>;
    private filePath;
    private readFile;
    private writeFile;
}

/** Configuration for the MemoryDistiller. */
interface MemoryDistillerConfig {
    /** User whose memory to manage. */
    userId: string;
    /** Session ID for error reporting. */
    sessionId: string;
    /** Extract every N turns (default 5). */
    turnFrequency?: number;
    /** Timeout for each extraction LLM call in milliseconds (default 30 000). */
    extractionTimeoutMs?: number;
}
/**
 * Extracts durable user facts from conversation and persists them to a MemoryStore.
 *
 * **Extraction triggers:**
 * - `onTurnEnd()`: Every `turnFrequency` turns (default 5th turn).
 * - `onCheckpoint()`: Immediately (e.g. on agent transfer, tool result, session close).
 * - `forceExtract()`: Awaitable on-demand extraction.
 *
 * **Coalescing:** Only one extraction runs at a time (`extractionInFlight` flag).
 * Additional triggers while an extraction is running are silently skipped.
 *
 * **Merge-on-write:** Each extraction produces the COMPLETE updated fact list
 * (existing + new, deduplicated, contradictions resolved) and replaces all facts.
 */
declare class MemoryDistiller {
    private conversationContext;
    private memoryStore;
    private hooks;
    private model;
    private turnCount;
    private extractionInFlight;
    private readonly turnFrequency;
    private readonly extractionTimeoutMs;
    private readonly userId;
    private readonly sessionId;
    constructor(conversationContext: ConversationContext, memoryStore: MemoryStore, hooks: HooksManager, model: LanguageModelV1, config: MemoryDistillerConfig);
    onTurnEnd(): void;
    onCheckpoint(): void;
    forceExtract(): Promise<void>;
    private extract;
    private runExtraction;
    private reportError;
}

/**
 * Bounded ring buffer for PCM audio chunks.
 * When the buffer exceeds its capacity, the oldest chunks are dropped first.
 * Used by ClientTransport to buffer audio during agent transfers and reconnections.
 */
declare class AudioBuffer {
    private buffer;
    private totalBytes;
    private maxBytes;
    constructor(maxDurationMs?: number);
    /** Add an audio chunk, dropping oldest chunks if the buffer is full. */
    push(chunk: Buffer): void;
    /** Remove and return all buffered chunks, resetting the buffer to empty. */
    drain(): Buffer[];
    clear(): void;
    get size(): number;
    get isEmpty(): boolean;
}

/** Configuration for the ElevenLabs Scribe v2 Realtime STT provider. */
interface ElevenLabsSTTConfig {
    /** ElevenLabs API key (xi-api-key). Required. */
    apiKey: string;
    /** Model identifier. Default: `'scribe_v2'`. */
    model?: string;
    /** BCP-47 language code. Default: `'en'`. */
    languageCode?: string;
}
/**
 * Streaming STT provider backed by ElevenLabs Scribe v2 Realtime API.
 *
 * Unlike the batch {@link GeminiBatchSTTProvider}, this provider forwards
 * every audio chunk to ElevenLabs in real time over a persistent WebSocket
 * and fires `onPartialTranscript` during speech.
 */
declare class ElevenLabsSTTProvider implements STTProvider {
    private readonly _apiKey;
    private readonly _model;
    private readonly _languageCode;
    private _sampleRate;
    private _audioFormat;
    private _state;
    private _ws;
    private _pendingTurnIds;
    private _reconnectBuffer;
    private _reconnectBufferBytes;
    private _reconnectBackoff;
    private _reconnectTimer;
    private _sessionStartedResolve;
    onTranscript?: (text: string, turnId: number | undefined) => void;
    onPartialTranscript?: (text: string) => void;
    constructor(config: ElevenLabsSTTConfig);
    configure(audio: STTAudioConfig): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    feedAudio(base64Pcm: string): void;
    commit(turnId: number): void;
    handleInterrupted(): void;
    handleTurnComplete(): void;
    private _connect;
    private _handleMessage;
    private _handleClose;
    private _scheduleReconnect;
    private _flushReconnectBuffer;
    private _bufferForReconnect;
    private _send;
    private _log;
}

/** Configuration for the Gemini batch STT provider. */
interface GeminiBatchSTTConfig {
    /** Google API key for the Gemini API. */
    apiKey: string;
    /** Model name for STT (e.g. "gemini-3-flash-preview"). */
    model: string;
}
/**
 * STTProvider that uses a separate Gemini model via generateContent() for
 * batch transcription of buffered user audio.
 *
 * Extracted from GeminiLiveTransport. Audio is buffered via feedAudio(),
 * then transcribed when commit() is called (triggered by model turn start).
 */
declare class GeminiBatchSTTProvider implements STTProvider {
    private ai;
    private model;
    private sampleRate;
    private _audioChunks;
    private _bufferBytes;
    private _wasInterrupted;
    onTranscript?: (text: string, turnId: number | undefined) => void;
    onPartialTranscript?: (text: string) => void;
    constructor(config: GeminiBatchSTTConfig);
    configure(audio: STTAudioConfig): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    feedAudio(base64Pcm: string): void;
    commit(turnId: number): void;
    handleInterrupted(): void;
    handleTurnComplete(): void;
}

/** Configuration for connecting to the Gemini Live API. */
interface GeminiTransportConfig {
    /** Google API key for authentication. */
    apiKey: string;
    /** Gemini model name (default: "gemini-live-2.5-flash-preview"). */
    model?: string;
    /** System instruction sent to the model at connection time. */
    systemInstruction?: string;
    /** Tool definitions to register with the model (converted to Gemini function declarations). */
    tools?: ToolDefinition[];
    /** Opaque handle from a previous session, used to resume an existing Gemini session. */
    resumptionHandle?: string;
    /** Voice configuration for Gemini's speech synthesis. */
    speechConfig?: {
        voiceName?: string;
    };
    /** Context window compression settings (trigger and target token counts). */
    compressionConfig?: {
        triggerTokens: number;
        targetTokens: number;
    };
    /** Enable Gemini's built-in Google Search grounding. */
    googleSearch?: boolean;
    /** Enable server-side transcription of user audio input (default: true). */
    inputAudioTranscription?: boolean;
    /** Timeout in ms for connect() to receive setupComplete (default: 30000). */
    connectTimeoutMs?: number;
    /** Timeout in ms for the overall reconnect operation (default: 45000). */
    reconnectTimeoutMs?: number;
}
/** Callbacks fired by GeminiLiveTransport when server messages arrive. */
interface GeminiTransportCallbacks {
    /** Gemini session setup is complete and ready for audio. */
    onSetupComplete?(sessionId: string): void;
    /** Base64-encoded PCM audio output from the model. */
    onAudioOutput?(data: string): void;
    /** Model is requesting one or more tool invocations. */
    onToolCall?(calls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
    }>): void;
    /** Model is cancelling previously requested tool calls. */
    onToolCallCancellation?(ids: string[]): void;
    /** Model has finished its response turn. */
    onTurnComplete?(): void;
    /** Model's response was interrupted by user speech. */
    onInterrupted?(): void;
    /** Model started a new response turn (first audio or tool call). */
    onModelTurnStart?(): void;
    /** Transcription of user's spoken input. */
    onInputTranscription?(text: string): void;
    /** Transcription of model's spoken output. */
    onOutputTranscription?(text: string): void;
    /** Server is shutting down — reconnect before timeLeft expires. */
    onGoAway?(timeLeft: string): void;
    /** New session resumption handle available. */
    onResumptionUpdate?(handle: string, resumable: boolean): void;
    /** Grounding metadata from Google Search results. */
    onGroundingMetadata?(metadata: Record<string, unknown>): void;
    /** Transport-level error. */
    onError?(error: Error): void;
    /** WebSocket connection closed. */
    onClose?(code?: number, reason?: string): void;
}
/**
 * WebSocket transport layer for the Gemini Live API.
 *
 * Wraps the `@google/genai` SDK's live.connect() to manage the bidirectional
 * audio stream. Handles connection setup, message routing, tool declaration
 * conversion (Zod → JSON Schema), and session resumption.
 *
 * Implements `LLMTransport` for provider-agnostic usage. The constructor
 * callback pattern is preserved for backward compatibility alongside the
 * LLMTransport callback properties.
 */
declare class GeminiLiveTransport implements LLMTransport {
    private session;
    private ai;
    private callbacks;
    private config;
    /** Resolves when setupComplete fires — used to make connect() await Gemini readiness. */
    private setupResolver;
    /** Tracks whether onModelTurnStart has already fired for the current turn. */
    private _modelTurnStarted;
    readonly capabilities: TransportCapabilities;
    readonly audioFormat: AudioFormatSpec;
    onAudioOutput?: (base64Data: string) => void;
    onToolCall?: (calls: TransportToolCall[]) => void;
    onToolCallCancel?: (ids: string[]) => void;
    onTurnComplete?: () => void;
    onInterrupted?: () => void;
    onInputTranscription?: (text: string) => void;
    onOutputTranscription?: (text: string) => void;
    onSessionReady?: (sessionId: string) => void;
    onError?: (error: LLMTransportError) => void;
    onClose?: (code?: number, reason?: string) => void;
    onModelTurnStart?: () => void;
    onGoAway?: (timeLeft: string) => void;
    onResumptionUpdate?: (handle: string, resumable: boolean) => void;
    onGroundingMetadata?: (metadata: Record<string, unknown>) => void;
    constructor(config: GeminiTransportConfig, callbacks: GeminiTransportCallbacks);
    /** Establish a WebSocket connection to the Gemini Live API.
     *  Resolves only after Gemini sends `setupComplete`, so callers can safely
     *  send content immediately after awaiting this method.
     *
     *  Also satisfies `LLMTransport.connect(config)` — if config is provided,
     *  it is applied before connecting.
     */
    connect(transportConfig?: LLMTransportConfig): Promise<void>;
    /** Disconnect and reconnect, optionally with a new resumption handle or ReconnectState.
     *  Accepts either a string handle (legacy API) or ReconnectState (LLMTransport API).
     */
    reconnect(stateOrHandle?: ReconnectState | string): Promise<void>;
    disconnect(): Promise<void>;
    /** Send base64-encoded PCM audio to Gemini as realtime input. */
    sendAudio(base64Data: string): void;
    /** Send tool execution results back to Gemini (legacy API). */
    sendToolResponse(responses: Array<{
        id?: string;
        name?: string;
        response?: Record<string, unknown>;
    }>, _scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT'): void;
    /** Send text-based conversation turns to Gemini (legacy API, used for context replay). */
    sendClientContent(turns: Array<{
        role: string;
        parts: Array<{
            text: string;
        }>;
    }>, turnComplete?: boolean): void;
    /** Update the tool declarations (applied on next reconnect). */
    updateTools(tools: ToolDefinition[]): void;
    /** Update the system instruction (applied on next reconnect). */
    updateSystemInstruction(instruction: string): void;
    /** Update Google Search grounding flag (applied on next reconnect). */
    updateGoogleSearch(enabled: boolean): void;
    get isConnected(): boolean;
    /** Send provider-neutral content turns to Gemini. Converts ContentTurn to Gemini format. */
    sendContent(turns: ContentTurn[], turnComplete?: boolean): void;
    /** Send a file/image to Gemini as inline data. */
    sendFile(base64Data: string, mimeType: string): void;
    /** Send a tool result back to Gemini (LLMTransport API). */
    sendToolResult(result: TransportToolResult): void;
    /** No-op for Gemini — generation is automatic after tool results and content injection. */
    triggerGeneration(_instructions?: string): void;
    /** No-op for V1 — server VAD only. */
    commitAudio(): void;
    /** No-op for V1 — server VAD only. */
    clearAudio(): void;
    /** Update session configuration (applied on next reconnect for Gemini). */
    updateSession(config: SessionUpdate): void;
    /** Transfer session: update config → reconnect → replay conversation history. */
    transferSession(config: SessionUpdate, state?: ReconnectState): Promise<void>;
    /** Apply LLMTransportConfig fields to the internal GeminiTransportConfig. */
    /** Merge LLMTransportConfig into the internal config. Only provided fields are applied;
     *  undefined fields preserve existing constructor values.
     */
    private applyTransportConfig;
    /** Convert ReplayItem[] to Gemini Content format and send as client content. */
    private replayHistory;
    private handleMessage;
}

/** Configuration for constructing an OpenAIRealtimeTransport. */
interface OpenAIRealtimeConfig {
    /** OpenAI API key. */
    apiKey: string;
    /** Model identifier (default: 'gpt-realtime'). */
    model?: string;
    /** Voice name (default: 'coral'). */
    voice?: string;
    /** Transcription model (default: 'gpt-4o-mini-transcribe'). Set to null to disable input transcription. */
    transcriptionModel?: string | null;
    /** Turn detection configuration. */
    turnDetection?: Record<string, unknown>;
    /** Noise reduction configuration. */
    noiseReduction?: Record<string, unknown>;
}
/**
 * LLMTransport implementation for the OpenAI Realtime API.
 *
 * Uses the `openai` SDK's WebSocket transport (`OpenAIRealtimeWS`) for
 * bidirectional audio streaming with function calling support.
 *
 * Key differences from Gemini:
 * - In-place session updates (no reconnect for agent transfers)
 * - Streamed function call arguments (accumulated before dispatch)
 * - Client-managed interruption (truncate + cancel)
 * - 24kHz audio (vs Gemini's 16kHz)
 * - Explicit `response.create` required after tool results
 */
declare class OpenAIRealtimeTransport implements LLMTransport {
    readonly capabilities: TransportCapabilities;
    readonly audioFormat: AudioFormatSpec;
    onAudioOutput?: (base64Data: string) => void;
    onToolCall?: (calls: TransportToolCall[]) => void;
    onToolCallCancel?: (ids: string[]) => void;
    onTurnComplete?: () => void;
    onInterrupted?: () => void;
    onInputTranscription?: (text: string) => void;
    onOutputTranscription?: (text: string) => void;
    onSessionReady?: (sessionId: string) => void;
    onError?: (error: LLMTransportError) => void;
    onClose?: (code?: number, reason?: string) => void;
    onModelTurnStart?: () => void;
    onGoAway?: (timeLeft: string) => void;
    onResumptionUpdate?: (handle: string, resumable: boolean) => void;
    onGroundingMetadata?: (metadata: Record<string, unknown>) => void;
    private client;
    private rt;
    private _isConnected;
    private config;
    private instructions?;
    private tools?;
    private voice;
    private lastAssistantItemId;
    private audioOutputMs;
    private pendingFunctionCalls;
    private _isModelGenerating;
    private _pendingWhenIdle;
    private _suppressAudio;
    constructor(config: OpenAIRealtimeConfig);
    get isConnected(): boolean;
    connect(transportConfig?: LLMTransportConfig): Promise<void>;
    disconnect(): Promise<void>;
    reconnect(state?: ReconnectState): Promise<void>;
    sendAudio(base64Data: string): void;
    commitAudio(): void;
    clearAudio(): void;
    updateSession(config: SessionUpdate): void;
    transferSession(config: SessionUpdate, _state?: ReconnectState): Promise<void>;
    sendContent(turns: ContentTurn[], turnComplete?: boolean): void;
    sendFile(base64Data: string, mimeType: string): void;
    sendToolResult(result: TransportToolResult): void;
    triggerGeneration(instructions?: string): void;
    /** Type-safe send wrapper that accepts our dynamically-built events. */
    private rtSend;
    private applyTransportConfig;
    private buildSessionConfig;
    private wireEventListeners;
    /** Flush any tool results queued with 'when_idle' scheduling. */
    private flushPendingWhenIdle;
    private replayHistory;
}

/** Schema output format: Gemini uses UPPERCASE type names, standard JSON Schema uses lowercase. */
type SchemaFormat = 'gemini' | 'standard';
/**
 * Converts a Zod schema to a simplified JSON Schema.
 * Handles the common subset: objects with string/number/boolean/array/enum properties.
 *
 * @param format - `'gemini'` (default) outputs UPPERCASE types for Gemini function declarations.
 *                 `'standard'` outputs lowercase types for OpenAI and standard JSON Schema consumers.
 */
declare function zodToJsonSchema(schema: z.ZodSchema, format?: SchemaFormat): Record<string, unknown>;

/**
 * A notification produced by a service subagent, queued for delivery to the user.
 * Urgent notifications may interrupt the current turn; normal ones wait for a natural pause.
 */
interface QueuedNotification {
    /** Human-readable notification text to speak/display. */
    text: string;
    /** Delivery urgency. */
    priority: NotificationPriority;
    /** Full subagent output that produced this notification. */
    result: SubagentResult;
    /** The external event that triggered the notification. */
    event: ExternalEvent;
    /** Unix timestamp (ms) when this notification was queued. */
    queuedAt: number;
}

export { AUDIO_FORMAT, type AgentContext, AgentError, AgentRouter, AudioBuffer, type AudioFormat, type AudioFormatSpec, BackgroundNotificationQueue, type BehaviorCategory, type BehaviorPreset, CancelledError, type ClientMessage, ClientTransport, type ClientTransportCallbacks, type ContentTurn, ConversationContext, type ConversationHistoryStore, ConversationHistoryWriter, type ConversationItem, type ConversationItemRole, DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_EXTRACTION_TIMEOUT_MS, DEFAULT_RECONNECT_TIMEOUT_MS, DEFAULT_SUBAGENT_TIMEOUT_MS, DEFAULT_TOOL_TIMEOUT_MS, DirectiveManager, type ElevenLabsSTTConfig, ElevenLabsSTTProvider, type ErrorSeverity, EventBus, type EventHandler, type EventPayload, type EventPayloadMap, type EventSourceConfig, type EventType, type ExternalEvent, FrameworkError, type FrameworkHooks, type GeminiBatchSTTConfig, GeminiBatchSTTProvider, GeminiLiveTransport, type GeminiTransportCallbacks, type GeminiTransportConfig, HooksManager, type IEventBus, InMemorySessionStore, InputTimeoutError, InteractionModeManager, type InteractiveSubagentConfig, JsonMemoryStore, type LLMTransport, type LLMTransportConfig, type LLMTransportError, type MainAgent, MemoryCacheManager, type MemoryCategory, MemoryDistiller, type MemoryDistillerConfig, MemoryError, type MemoryFact, type MemoryStore, type NotificationPriority, type OpenAIRealtimeConfig, OpenAIRealtimeTransport, type PaginationOptions, type PendingToolCall, type QueuedNotification, type ReconnectState, type ReplayItem, type ResumptionState, type ResumptionUpdate, type RunSubagentOptions, type STTAudioConfig, type STTProvider, type SendOrQueueOptions, type ServiceSubagentConfig, type SessionAnalytics, type SessionCheckpoint, SessionCompletedError, type SessionConfig, SessionError, type SessionInteractionMode, SessionManager, type SessionRecord, type SessionReport, type SessionState, type SessionStore, type SessionSummary, type SessionUpdate, type SubagentConfig, type SubagentContextSnapshot, type SubagentEventCallbacks, type SubagentMessage, type SubagentResult, type SubagentSession, SubagentSessionImpl, type SubagentSessionState, type SubagentTask, type ToolCall, ToolCallRouter, type ToolCallRouterDeps, type ToolContext, type ToolDefinition, type ToolExecution, ToolExecutionError, ToolExecutor, type ToolResult, TranscriptManager, type TranscriptSink, type TransportAuth, type TransportCapabilities, TransportError, type TransportPendingToolCall, type TransportToolCall, type TransportToolResult, type UIPayload, type UIResponse, type Unsubscribe, ValidationError, VoiceSession, type VoiceSessionConfig, createAgentContext, createAskUserTool, runSubagent, zodToJsonSchema };
