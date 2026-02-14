import type { z } from 'zod';

export type ToolExecution = 'inline' | 'background';

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: z.ZodSchema;
	execution: ToolExecution;
	pendingMessage?: string;
	timeout?: number;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolContext {
	toolCallId: string;
	agentName: string;
	sessionId: string;
	abortSignal: AbortSignal;
}
