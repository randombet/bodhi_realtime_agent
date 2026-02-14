import type { ConversationItem } from './conversation.js';
import type { MemoryFact } from './memory.js';
import type { ToolDefinition } from './tool.js';

export interface AgentContext {
	sessionId: string;
	agentName: string;
	injectSystemMessage(text: string): void;
	getRecentTurns(count?: number): ConversationItem[];
	getMemoryFacts(): MemoryFact[];
}

export interface MainAgent {
	name: string;
	instructions: string | (() => string);
	tools: ToolDefinition[];
	onEnter?(ctx: AgentContext): Promise<void>;
	onExit?(ctx: AgentContext): Promise<void>;
	onTurnCompleted?(ctx: AgentContext, transcript: string): Promise<void>;
}

export interface SubagentConfig {
	name: string;
	instructions: string;
	tools: Record<string, unknown>; // Vercel AI SDK tool() definitions
	maxSteps?: number;
	timeout?: number;
	model?: string;
}

export interface ServiceSubagentConfig {
	agent: SubagentConfig;
	eventSources: EventSourceConfig[];
	shouldInvoke?(event: ExternalEvent): boolean;
}

export interface EventSourceConfig {
	name: string;
	start(emit: (event: ExternalEvent) => void, signal: AbortSignal): void;
	stop(): Promise<void>;
}

export interface ExternalEvent {
	source: string;
	type: string;
	data: Record<string, unknown>;
	priority?: NotificationPriority;
}

export type NotificationPriority = 'normal' | 'urgent';
