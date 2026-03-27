// SPDX-License-Identifier: MIT

import type { ExternalEvent } from './agent.js';
import type { SubagentResult, ToolCall, ToolResult, UIPayload } from './conversation.js';
import type { SessionState } from './session.js';
import type { UIResponse } from './ui.js';

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
	'context.compact': { sessionId: string; removedItems: number };

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
