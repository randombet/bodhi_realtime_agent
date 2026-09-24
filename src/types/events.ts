import type { ExternalEvent } from './agent.js';
import type { SubagentResult, ToolCall, ToolResult, UIPayload } from './conversation.js';
import type { TurnLatencySegments } from './hooks.js';
import type { SessionEndReason, SessionState } from './session.js';
import type { GenerationEndReason, RealtimeLLMUsageEvent } from './transport.js';
import type { UIResponse } from './ui.js';

/** Which VAD produced a speech timing fact. */
export type SpeechEventSource = 'provider' | 'client-vad';

/**
 * What initiated a model response — assigned explicitly at every
 * response-creating call site (observability design §11). Only `'user_audio'`
 * turns are latency-eligible for a `no_anchor` drop.
 */
export type ResponseOrigin =
	| 'user_audio'
	| 'user_text'
	| 'assistant_initiated'
	| 'tool_continuation';

/** Source identifier for a published `realtime.usage` EventBus event. */
export type RealtimeUsageSource =
	| 'openai.response'
	| 'openai.transcription'
	| 'gemini.usage.update'
	| 'gemini.turn.final'
	| 'qwen.response'
	| 'qwen.transcription';

/**
 * Payload for the `realtime.usage` EventBus event. One emission per provider
 * usage callback (NOT one per turn) — OpenAI fires once for `response.done`
 * and once for transcription completion; Gemini fires for interim updates
 * and once at `turnComplete`.
 *
 * Aggregation key recommendations:
 * - openai.response       → (sessionId, turnId, source, providerItemId)
 * - openai.transcription  → (sessionId, source, providerItemId)  // turnId is null
 * - gemini.turn.final     → (sessionId, turnId, source)
 * - gemini.usage.update   → ignored for billing; use `sequence` for replay
 * - qwen.response         → (sessionId, turnId, source, providerItemId)
 * - qwen.transcription    → (sessionId, source, providerItemId)  // turnId is null
 */
export interface RealtimeUsagePublished {
	sessionId: string;
	agentName: string;
	/** Null when the event is not bound to a model turn (transcription). */
	turnId: string | null;
	source: RealtimeUsageSource;
	/** Provider-supplied opaque id. response.id for openai.response,
	 *  item_id for openai.transcription, null for gemini.*. */
	providerItemId: string | null;
	/** Monotonic per-(sessionId, turnId, source). Disambiguates Gemini interim duplicates. */
	sequence: number;
	/** Wall-clock ms when VoiceSession published the event. */
	emittedAt: number;
	usage: RealtimeLLMUsageEvent;
	/** cachedTokens / inputTokens. Undefined when caching was not reported by
	 *  the provider for this event. Treat undefined as "no signal," NOT 0%. */
	cacheHitRatio?: number;
}

export interface RealtimeCacheBustPublished {
	sessionId: string;
	/** currentModelTurnAgentName ?? activeAgent.name fallback. */
	agentName: string;
	/** Null when the bust fires outside an allocated model turn. */
	turnId: string | null;
	reason: 'instructions_changed' | 'tools_changed';
}

/** Function returned by EventBus.subscribe() — call it to remove the subscription. */
export type Unsubscribe = () => void;

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
export interface EventPayloadMap {
	// Agent events
	'agent.enter': { sessionId: string; agentName: string };
	'agent.exit': { sessionId: string; agentName: string };
	'agent.transfer': { sessionId: string; fromAgent: string; toAgent: string };
	'agent.transfer_requested': { sessionId: string; toAgent: string };
	'agent.handoff': {
		sessionId: string;
		agentName: string;
		subagentName: string;
		toolCallId: string;
	};

	// Tool events
	'tool.call': ToolCall & { sessionId: string; agentName: string };
	'tool.result': ToolResult & { sessionId: string };
	'tool.cancel': { sessionId: string; toolCallIds: string[] };

	// Turn events
	// `turn.start` fires once per framework Turn, on its first model start.
	// transportGeneration is the POST-SETUP counter (correlates with lifecycle
	// setup-ok); attemptEpoch is the DIAL counter. Different domains: never
	// compare one with the other. Both are undefined on transports that do not
	// expose them.
	'turn.start': {
		sessionId: string;
		turnId: string;
		transportGeneration?: number;
		attemptEpoch?: number;
	};
	'turn.end': { sessionId: string; turnId: string };
	'turn.interrupted': { sessionId: string; turnId: string };

	// Generation lifecycle — a PAIR, and a different boundary from the turn
	// events above: a generation outlives the provider's turnComplete, because
	// the tool call that finishes an answer can arrive after it. Per-answer
	// state keys on these. generationId is the transport's own counter, not a
	// turnId.
	'generation.start': { sessionId: string; generationId: string };
	'generation.end': { sessionId: string; generationId: string; reason: GenerationEndReason };

	// Raw latency facts (observability design §11 — consumed by TurnLatencyTracker).
	// `atMs` is the SOURCE EDGE on the session metric clock: client-VAD events
	// carry the detector's detected edges (speechStartMs / speechEndMs =
	// lastVoiceMs), NOT publish time; provider events use callback receipt time
	// (bounded late bias — see the design doc).
	'speech.user_started': { sessionId: string; atMs: number; source: SpeechEventSource };
	'speech.user_ended': { sessionId: string; atMs: number; source: SpeechEventSource };
	'response.started': {
		sessionId: string;
		turnId: string;
		atMs: number;
		origin: ResponseOrigin;
	};
	'response.first_audio': { sessionId: string; turnId: string; atMs: number };
	/** In-flight latency stamps must be discarded (reconnect/transfer/close). */
	'session.reset': { sessionId: string; reason: 'reconnect' | 'transfer' | 'close' };
	/** Computed per-turn latency result (mirror of `onTurnLatency`). */
	'turn.latency': { sessionId: string; turnId: string; segments: TurnLatencySegments };

	// GUI events
	'gui.update': { sessionId: string; data: Record<string, unknown> };
	'gui.notification': { sessionId: string; message: string };

	// Session events
	'session.start': { sessionId: string; userId: string; agentName: string };
	'session.close': { sessionId: string; reason: SessionEndReason };
	'session.stateChange': {
		sessionId: string;
		fromState: SessionState;
		toState: SessionState;
	};
	'session.resume': { sessionId: string; handle: string };
	'session.goaway': { sessionId: string; timeLeft: string };
	/** A host recovery (`recoverUpstream()`) crossed its boundary: the active
	 *  turn was finalized as interrupted and the connection abandoned; the
	 *  replacement dials next. `attemptEpoch` is the dial generation the
	 *  replacement dials on. `transportGeneration` carries the same dial
	 *  generation under its older name: it is not the post-setup counter that
	 *  `turn.start.transportGeneration` reports. */
	'session.reconnectBoundary': {
		sessionId: string;
		reason: string;
		transportGeneration: number;
		attemptEpoch: number;
	};
	/** The session parked in UPSTREAM_LOST (`upstreamLossPolicy: 'hold'`): the
	 *  provider connection is gone, nothing was finalized, and no automatic
	 *  dial follows. `code`/`detail` carry the transport close code and reason
	 *  or the failure text, when known. */
	'session.upstreamLost': { sessionId: string; reason: string; code?: number; detail?: string };
	'session.transcription_mode_changed': {
		sessionId: string;
		/** Public, stable mode — 'agent' | 'transcription'. */
		mode: 'agent' | 'transcription';
	};
	'context.compact': { sessionId: string; removedItems: number };

	// Realtime LLM usage + cache events (P4)
	'realtime.usage': RealtimeUsagePublished;
	'realtime.cache.bust': RealtimeCacheBustPublished;

	// Subagent interaction events (Patterns 2 & 3)
	'subagent.ui.send': { sessionId: string; payload: UIPayload };
	'subagent.ui.response': { sessionId: string; response: UIResponse };
	'subagent.notification': {
		sessionId: string;
		result: SubagentResult;
		event: ExternalEvent;
	};
}

/** Union of all valid event type strings (e.g. "agent.enter", "tool.call"). */
export type EventType = keyof EventPayloadMap;

/** Resolves the payload type for a given event type string. */
export type EventPayload<T extends EventType> = EventPayloadMap[T];
