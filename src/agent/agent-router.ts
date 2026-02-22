// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import type { ConversationContext } from '../core/conversation-context.js';
import { AgentError } from '../core/errors.js';
import type { IEventBus } from '../core/event-bus.js';
import type { HooksManager } from '../core/hooks.js';
import type { SessionManager } from '../core/session-manager.js';
import type { ClientTransport } from '../transport/client-transport.js';
import type { GeminiLiveTransport } from '../transport/gemini-live-transport.js';
import type { MainAgent, SubagentConfig } from '../types/agent.js';
import type { SubagentResult, ToolCall } from '../types/conversation.js';
import type { ToolDefinition } from '../types/tool.js';
import { createAgentContext, resolveInstructions } from './agent-context.js';
import { runSubagent } from './subagent-runner.js';

/** Tracks a running background subagent so it can be cancelled. */
interface ActiveSubagent {
	controller: AbortController;
	toolCallId: string;
	configName: string;
}

/**
 * Manages agent lifecycle: transfers between MainAgents and handoffs to background subagents.
 *
 * **Transfer flow** (agent → agent):
 *   onExit → agent.exit event → TRANSFERRING → buffer audio → disconnect →
 *   reconnect with new agent config → replay context + buffered audio →
 *   ACTIVE → onEnter → agent.enter event → agent.transfer event
 *
 * **Handoff flow** (background tool → subagent):
 *   Create AbortController → build context snapshot → agent.handoff event →
 *   runSubagent() async → return SubagentResult
 */
export class AgentRouter {
	private agents = new Map<string, MainAgent>();
	private _activeAgent: MainAgent;
	private activeSubagents = new Map<string, ActiveSubagent>();

	constructor(
		private sessionManager: SessionManager,
		private eventBus: IEventBus,
		private hooks: HooksManager,
		private conversationContext: ConversationContext,
		private geminiTransport: GeminiLiveTransport,
		private clientTransport: ClientTransport,
		private model: LanguageModelV1,
		private getInstructionSuffix?: () => string,
		private extraTools: ToolDefinition[] = [],
	) {
		this._activeAgent = undefined as unknown as MainAgent;
	}

	registerAgents(agents: MainAgent[]): void {
		for (const agent of agents) {
			this.agents.set(agent.name, agent);
		}
	}

	setInitialAgent(agentName: string): void {
		const agent = this.agents.get(agentName);
		if (!agent) {
			throw new AgentError(`Unknown agent: ${agentName}`);
		}
		this._activeAgent = agent;
	}

	get activeAgent(): MainAgent {
		return this._activeAgent;
	}

	/**
	 * Transfer the active Gemini session to a different agent.
	 * Disconnects, reconnects with new system instructions and tools, and replays context.
	 */
	async transfer(toAgentName: string): Promise<void> {
		const toAgent = this.agents.get(toAgentName);
		if (!toAgent) {
			throw new AgentError(`Unknown agent: ${toAgentName}`);
		}

		const fromAgent = this._activeAgent;
		const ctx = this.createContext(fromAgent.name);

		// 1. onExit current agent
		await fromAgent.onExit?.(ctx);
		this.eventBus.publish('agent.exit', {
			sessionId: this.sessionManager.sessionId,
			agentName: fromAgent.name,
		});

		// 2. Record transfer in conversation
		this.conversationContext.addAgentTransfer(fromAgent.name, toAgentName);

		// 3. Transition to TRANSFERRING
		this.sessionManager.transitionTo('TRANSFERRING');

		// 4. Start buffering client audio
		this.clientTransport.startBuffering();

		// 5. Save handle and disconnect
		const handle = this.sessionManager.resumptionHandle;

		// 6. Disconnect and reconnect with new agent config
		const suffix = this.getInstructionSuffix?.() ?? '';
		this.geminiTransport.updateSystemInstruction(resolveInstructions(toAgent) + suffix);
		this.geminiTransport.updateTools([...toAgent.tools, ...this.extraTools]);
		this.geminiTransport.updateGoogleSearch(toAgent.googleSearch ?? false);
		await this.geminiTransport.reconnect(handle ?? undefined);

		// 7. Stop buffering and replay
		const buffered = this.clientTransport.stopBuffering();

		// 8. Replay conversation context
		const replayContent = this.conversationContext.toReplayContent();
		if (replayContent.length > 0) {
			this.geminiTransport.sendClientContent(replayContent, false);
		}

		// 9. Replay buffered audio
		for (const chunk of buffered) {
			this.geminiTransport.sendAudio(chunk.toString('base64'));
		}

		// 10. Transition to ACTIVE
		this.sessionManager.transitionTo('ACTIVE');
		this._activeAgent = toAgent;

		// 11. onEnter new agent
		const newCtx = this.createContext(toAgent.name);
		await toAgent.onEnter?.(newCtx);
		this.eventBus.publish('agent.enter', {
			sessionId: this.sessionManager.sessionId,
			agentName: toAgent.name,
		});

		// 12. Publish transfer event
		this.eventBus.publish('agent.transfer', {
			sessionId: this.sessionManager.sessionId,
			fromAgent: fromAgent.name,
			toAgent: toAgentName,
		});
	}

	/** Spawn a background subagent to handle a tool call asynchronously. */
	async handoff(toolCall: ToolCall, subagentConfig: SubagentConfig): Promise<SubagentResult> {
		const controller = new AbortController();
		this.activeSubagents.set(toolCall.toolCallId, {
			controller,
			toolCallId: toolCall.toolCallId,
			configName: subagentConfig.name,
		});

		this.eventBus.publish('agent.handoff', {
			sessionId: this.sessionManager.sessionId,
			agentName: this._activeAgent.name,
			subagentName: subagentConfig.name,
			toolCallId: toolCall.toolCallId,
		});

		try {
			const context = this.conversationContext.getSubagentContext(
				{
					description: `Execute tool: ${toolCall.toolName}`,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					args: toolCall.args,
				},
				resolveInstructions(this._activeAgent),
				[],
			);

			const result = await runSubagent({
				config: subagentConfig,
				context,
				hooks: this.hooks,
				model: this.model,
				abortSignal: controller.signal,
			});

			return result;
		} finally {
			this.activeSubagents.delete(toolCall.toolCallId);
		}
	}

	/** Abort a running background subagent by its originating tool call ID. */
	cancelSubagent(toolCallId: string): void {
		const sub = this.activeSubagents.get(toolCallId);
		if (sub) {
			sub.controller.abort();
			this.activeSubagents.delete(toolCallId);
		}
	}

	get activeSubagentCount(): number {
		return this.activeSubagents.size;
	}

	private createContext(agentName: string) {
		return createAgentContext({
			sessionId: this.sessionManager.sessionId,
			agentName,
			conversationContext: this.conversationContext,
			hooks: this.hooks,
		});
	}
}
