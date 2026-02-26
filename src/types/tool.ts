// SPDX-License-Identifier: MIT

import type { z } from 'zod';

/**
 * How a tool is executed relative to the Gemini audio stream.
 * - `inline`: Executed synchronously — Gemini waits for the result before continuing.
 * - `background`: Handed off to a subagent — Gemini continues speaking while it runs.
 */
export type ToolExecution = 'inline' | 'background';

/**
 * Declares a tool that Gemini can invoke during a voice session.
 * The framework converts the Zod schema to a Gemini function declaration,
 * validates arguments at runtime, and routes execution based on the `execution` mode.
 */
export interface ToolDefinition {
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
export interface ToolContext {
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
