// SPDX-License-Identifier: MIT

import type { ConversationItem } from './conversation.js';
import type { MemoryFact } from './memory.js';
import type { ToolDefinition } from './tool.js';

/**
 * Runtime context passed to agent lifecycle hooks (onEnter, onExit, onTurnCompleted).
 * Provides read access to session state and the ability to inject messages.
 */
export interface AgentContext {
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
export interface MainAgent {
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
export interface SubagentConfig {
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
}

/**
 * Configuration for a service subagent that reacts to external events
 * (e.g. webhooks, database changes) and can proactively notify the user.
 */
export interface ServiceSubagentConfig {
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
export interface EventSourceConfig {
	/** Human-readable name for logging and debugging. */
	name: string;
	/** Begin emitting events. The signal is aborted when the session closes. */
	start(emit: (event: ExternalEvent) => void, signal: AbortSignal): void;
	/** Gracefully shut down this event source. */
	stop(): Promise<void>;
}

/** An event from an external system delivered to a service subagent. */
export interface ExternalEvent {
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
export type NotificationPriority = 'normal' | 'urgent';
