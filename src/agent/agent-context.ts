import type { ConversationContext } from '../core/conversation-context.js';
import type { HooksManager } from '../core/hooks.js';
import type { AgentContext } from '../types/agent.js';
import type { ConversationItem } from '../types/conversation.js';
import type { MemoryFact } from '../types/memory.js';

/**
 * Factory that builds an AgentContext object for agent lifecycle hooks.
 * Wires `injectSystemMessage` and `getRecentTurns` to the live ConversationContext.
 */
export function createAgentContext(options: {
	sessionId: string;
	agentName: string;
	conversationContext: ConversationContext;
	hooks: HooksManager;
	memoryFacts?: MemoryFact[];
}): AgentContext {
	return {
		sessionId: options.sessionId,
		agentName: options.agentName,
		injectSystemMessage(text: string): void {
			options.conversationContext.addAssistantMessage(`[system] ${text}`);
		},
		getRecentTurns(count = 10): ConversationItem[] {
			const items = options.conversationContext.items;
			return items.slice(-count) as ConversationItem[];
		},
		getMemoryFacts(): MemoryFact[] {
			return options.memoryFacts ?? [];
		},
	};
}
