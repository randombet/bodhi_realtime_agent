import type { ToolExecution } from './tool.js';

export interface FrameworkHooks {
	onSessionStart?(event: {
		sessionId: string;
		userId: string;
		agentName: string;
	}): void;

	onSessionEnd?(event: {
		sessionId: string;
		durationMs: number;
		reason: string;
	}): void;

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

	onToolCall?(event: {
		sessionId: string;
		toolCallId: string;
		toolName: string;
		execution: ToolExecution;
		agentName: string;
	}): void;

	onToolResult?(event: {
		toolCallId: string;
		durationMs: number;
		status: 'completed' | 'cancelled' | 'error';
		error?: string;
	}): void;

	onAgentTransfer?(event: {
		sessionId: string;
		fromAgent: string;
		toAgent: string;
		reconnectMs: number;
	}): void;

	onSubagentStep?(event: {
		subagentName: string;
		stepNumber: number;
		toolCalls: string[];
		tokensUsed: number;
	}): void;

	onMemoryExtraction?(event: {
		userId: string;
		factsExtracted: number;
		durationMs: number;
	}): void;

	onError?(event: {
		sessionId?: string;
		component: string;
		error: Error;
		severity: 'warn' | 'error' | 'fatal';
	}): void;
}
