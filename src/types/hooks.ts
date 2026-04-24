// SPDX-License-Identifier: MIT

import type { ToolExecution } from './tool.js';
import type { RealtimeLLMUsageEvent } from './transport.js';

/**
 * Optional lifecycle hooks for observability, logging, and metrics.
 * All hooks are synchronous and fire-and-forget — exceptions are caught and logged.
 * Register hooks via VoiceSessionConfig or HooksManager.register().
 */
export interface FrameworkHooks {
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

	/** Fires when a realtime LLM transport reports provider usage (tokens or duration). */
	onRealtimeLLMUsage?(event: {
		sessionId: string;
		agentName: string;
		usage: RealtimeLLMUsageEvent;
	}): void;

	/** Fires after the memory distiller extracts facts from conversation. */
	onMemoryExtraction?(event: {
		userId: string;
		factsExtracted: number;
		durationMs: number;
	}): void;

	/** Fires after each TTS synthesis request completes. */
	onTTSSynthesis?(event: {
		sessionId: string;
		provider: string;
		textLength: number;
		durationMs: number;
		audioMs: number;
		ttfbMs: number;
		requestId: number;
	}): void;

	/** Fires on any framework error. Use for centralized error logging/alerting. */
	onError?(event: {
		sessionId?: string;
		component: string;
		error: Error;
		severity: 'warn' | 'error' | 'fatal';
	}): void;
}
