// SPDX-License-Identifier: MIT

import type { ExternalEvent } from './agent.js';
import type { SubagentResult, ToolCall, ToolResult, UIPayload } from './conversation.js';
import type { SessionState } from './session.js';
import type { RealtimeLLMUsageEvent } from './transport.js';
import type { UIResponse } from './ui.js';

/** Source identifier for a published `realtime.usage` EventBus event. */
export type RealtimeUsageSource =
	| 'openai.response'
	| 'openai.transcription'
	| 'gemini.usage.update'
	| 'gemini.turn.final';

/**
 * Payload for the `realtime.usage` EventBus event. One emission per provider
 * usage callback (NOT one per turn) — OpenAI fires once for `response.done`
 * and once for transcription completion; Gemini fires for interim updates
 * and once at `turnComplete`.
 *
 * Aggregation key recommendations (see dev_docs/framework/design-context-caching.md §4):
 * - openai.response       → (sessionId, turnId, source, providerItemId)
 * - openai.transcription  → (sessionId, source, providerItemId)  // turnId is null
 * - gemini.turn.final     → (sessionId, turnId, source)
 * - gemini.usage.update   → ignored for billing; use `sequence` for replay
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
	'turn.start': { sessionId: string; turnId: string };
	'turn.end': { sessionId: string; turnId: string };
	'turn.interrupted': { sessionId: string; turnId: string };

	// GUI events
	'gui.update': { sessionId: string; data: Record<string, unknown> };
	'gui.notification': { sessionId: string; message: string };

	// Session events
	'session.start': { sessionId: string; userId: string; agentName: string };
	'session.close': { sessionId: string; reason: string };
	'session.stateChange': {
		sessionId: string;
		fromState: SessionState;
		toState: SessionState;
	};
	'session.resume': { sessionId: string; handle: string };
	'session.goaway': { sessionId: string; timeLeft: string };
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
