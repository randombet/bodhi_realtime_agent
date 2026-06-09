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

	/**
	 * Fires when end-of-user-speech is detected (client/provider VAD end) — the
	 * anchor for stop-to-first-audio (S2FA) and stop-to-transcript (S2T). `atMs`
	 * comes from the session's metric clock (see `VoiceSessionConfig.nowMs`).
	 */
	onUserSpeechEnd?(event: {
		sessionId: string;
		turnId?: string;
		atMs: number;
	}): void;

	/**
	 * Fires when the user transcript for a turn is finalized (STT commit). Paired
	 * with `onUserSpeechEnd`, the delta gives stop-to-transcript (S2T). Carries
	 * `textLength` only — never the transcript text (privacy, see design §6).
	 */
	onTranscriptReady?(event: {
		sessionId: string;
		turnId?: string;
		atMs: number;
		textLength: number;
	}): void;

	/**
	 * Fires when a client-VAD barge-in is detected over assistant audio. Cancel
	 * latency is `cancelRequestedAtMs - detectedAtMs` (detection → actuation), NOT
	 * anything involving speech end. `successful` is false when the barge-in was
	 * detected but declined (below threshold / no active audio). All timestamps
	 * come from the session metric clock.
	 */
	onBargeInDetected?(event: {
		sessionId: string;
		speechStartedAtMs: number;
		detectedAtMs: number;
		cancelRequestedAtMs: number;
		audioStoppedAtMs?: number;
		latencyMs: number;
		successful: boolean;
	}): void;

	/**
	 * Fires once when any turn is finalized — clean or interrupted. Gives the
	 * agent-interruption rate (interrupted / total) and the denominator for
	 * barge-in recovery rate.
	 */
	onTurnFinalized?(event: {
		sessionId: string;
		turnId: string;
		interrupted: boolean;
	}): void;

	/**
	 * Fires when the agent's audio starts while the user is still actively speaking
	 * — a "jump-in" / false turn-end (the agent took the floor prematurely).
	 * Jump-in rate = jump-ins / turns.
	 */
	onJumpIn?(event: { sessionId: string; turnId?: string }): void;

	/**
	 * Fires when the agent re-enters with audio after yielding to a barge-in.
	 * `reentryMs` is the pause between the interrupt and the next agent audio
	 * (human baseline ≈ 200ms).
	 */
	onAgentReentry?(event: { sessionId: string; reentryMs: number }): void;

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

	/**
	 * Fires once per background notification, after `NotificationActor` flushes
	 * it to its subscribers. Driven by the built-in `NotificationHooksObserverActor`
	 * (a default subscriber). Useful for end-to-end tracing of background
	 * tool completions, interactive subagent questions, and wall-clock /
	 * external producer events. `deferredMs` reports the time the notification
	 * spent in the queue (0 for immediate-deliver paths).
	 *
	 * Actor mode only — only fires when `orchestrationMode: 'actor'`.
	 */
	onBackgroundNotification?(event: {
		sessionId: string;
		id: string;
		label: string;
		priority: 'normal' | 'high';
		publishedAtMs: number;
		deliveredAtMs: number;
		deferredMs: number;
		correlationId?: string;
	}): void;

	/** Fires on any framework error. Use for centralized error logging/alerting. */
	onError?(event: {
		sessionId?: string;
		component: string;
		error: Error;
		severity: 'warn' | 'error' | 'fatal';
	}): void;
}
