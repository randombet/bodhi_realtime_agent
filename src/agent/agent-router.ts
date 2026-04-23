// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import type { ConversationContext } from '../core/conversation-context.js';
import { AgentError } from '../core/errors.js';
import type { IEventBus } from '../core/event-bus.js';
import type { HooksManager } from '../core/hooks.js';
import type { SessionManager } from '../core/session-manager.js';
import type { MainAgent, SubagentConfig } from '../types/agent.js';
import type { SubagentResult, ToolCall } from '../types/conversation.js';
import type { IClientChannel } from '../types/session-client.js';
import type { ToolDefinition } from '../types/tool.js';
import type { LLMTransport } from '../types/transport.js';
import { createAgentContext, resolveInstructions } from './agent-context.js';
import { runSubagent } from './subagent-runner.js';
import type { SubagentMessage, SubagentSession } from './subagent-session.js';
import { SubagentSessionImpl } from './subagent-session.js';

function isHandoffDebugLogging(): boolean {
	return process.env.LOG_LEVEL === 'debug';
}

/** Best-effort model id for logs (`@ai-sdk/*` models usually set `modelId`). */
function reasoningModelLabelForLog(model: LanguageModelV1): string {
	const m = model as { modelId?: string };
	return typeof m.modelId === 'string' && m.modelId.length > 0
		? m.modelId
		: '(LanguageModelV1: no modelId)';
}

/** Tracks a running background subagent so it can be cancelled. */
interface ActiveSubagent {
	controller: AbortController;
	toolCallId: string;
	configName: string;
	/** Present when the subagent is interactive (config.interactive === true). */
	session?: SubagentSession;
}

/** Callbacks for interactive subagent lifecycle events. */
export interface SubagentEventCallbacks {
	/** Fired when a subagent sends a message (question, progress) to the user. */
	onMessage?: (toolCallId: string, msg: SubagentMessage) => void;
	/** Fired when a subagent session transitions to a terminal state (completed/cancelled). */
	onSessionEnd?: (toolCallId: string) => void;
}

/** Hooks for bridging external-audio agents with VoiceSession audio routing. */
export interface ExternalAudioCallbacks {
	/** Called when an external agent wants to receive raw client mic audio. */
	setExternalAudioHandler?: (handler: ((data: Buffer) => void) | null) => void;
	/** Called when an external agent wants to play raw PCM audio to the client. */
	sendAudioToClient?: (data: Buffer) => void;
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
	private _activeAgent: MainAgent | null = null;
	private activeSubagents = new Map<string, ActiveSubagent>();
	/** Response modality to include in transfer SessionUpdate (set by VoiceSession for TTS). */
	responseModality?: 'audio' | 'text';

	constructor(
		private sessionManager: SessionManager,
		private eventBus: IEventBus,
		private hooks: HooksManager,
		private conversationContext: ConversationContext,
		private transport: LLMTransport,
		private clientTransport: IClientChannel,
		private model: LanguageModelV1,
		private getInstructionSuffix?: () => string,
		private extraTools: ToolDefinition[] = [],
		private subagentCallbacks?: SubagentEventCallbacks,
		private externalAudioCallbacks?: ExternalAudioCallbacks,
	) {}

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
		if (!this._activeAgent) {
			throw new AgentError('No active agent — call setInitialAgent() first');
		}
		return this._activeAgent;
	}

	/**
	 * Transfer the active LLM session to a different agent.
	 * Uses transport.transferSession() — the transport decides whether to
	 * apply in-place (OpenAI session.update) or reconnect-based (Gemini).
	 *
	 * @deprecated Use `MainAgentActor` via `RuntimeOrchestrator` instead.
	 * Retained for backward compatibility during the actor runtime transition.
	 */
	async transfer(toAgentName: string): Promise<void> {
		const toAgent = this.agents.get(toAgentName);
		if (!toAgent) {
			throw new AgentError(`Unknown agent: ${toAgentName}`);
		}

		const fromAgent = this.activeAgent;
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

		try {
			if (toAgent.audioMode === 'external') {
				// External audio agent: disconnect LLM transport, let agent manage audio
				await this.transport.disconnect();
				this._activeAgent = toAgent;

				// onEnter receives context — agent wires its own audio path.
				// Buffering continues until agent calls ctx.stopBufferingAndDrain().
				const newCtx = this.createContext(toAgent.name);
				await toAgent.onEnter?.(newCtx);

				this.sessionManager.transitionTo('ACTIVE');
				this.eventBus.publish('agent.enter', {
					sessionId: this.sessionManager.sessionId,
					agentName: toAgent.name,
				});
			} else {
				// Standard LLM agent: reconnect transport with new config
				const suffix = this.getInstructionSuffix?.() ?? '';
				const resolvedInstructions = resolveInstructions(toAgent) + suffix;
				const allTools = [...toAgent.tools, ...this.extraTools];

				const state = {
					conversationHistory: this.conversationContext.toReplayContent(),
				};

				const providerOptions: Record<string, unknown> = {
					...(toAgent.providerOptions ?? {}),
				};
				if (toAgent.googleSearch !== undefined && providerOptions.googleSearch === undefined) {
					providerOptions.googleSearch = toAgent.googleSearch;
				}

				await this.transport.transferSession(
					{
						instructions: resolvedInstructions,
						tools: allTools,
						providerOptions,
						...(this.responseModality ? { responseModality: this.responseModality } : {}),
					},
					state,
				);

				// Stop buffering and replay audio
				const buffered = this.clientTransport.stopBuffering();
				for (const chunk of buffered) {
					this.transport.sendAudio(chunk.toString('base64'));
				}

				this.sessionManager.transitionTo('ACTIVE');
				this._activeAgent = toAgent;

				const newCtx = this.createContext(toAgent.name);
				await toAgent.onEnter?.(newCtx);
				this.eventBus.publish('agent.enter', {
					sessionId: this.sessionManager.sessionId,
					agentName: toAgent.name,
				});
			}

			// Publish transfer event (both paths)
			this.eventBus.publish('agent.transfer', {
				sessionId: this.sessionManager.sessionId,
				fromAgent: fromAgent.name,
				toAgent: toAgentName,
			});
		} catch (err) {
			// Transfer failed — session is broken, clean up and transition to CLOSED
			this.clientTransport.stopBuffering();
			this.sessionManager.transitionTo('CLOSED');
			const error = new AgentError(
				`Transfer to "${toAgentName}" failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			if (this.hooks.onError) {
				this.hooks.onError({
					sessionId: this.sessionManager.sessionId,
					component: 'agent-router',
					error,
					severity: 'fatal',
				});
			}
			throw error;
		}
	}

	/** Look up the SubagentSession for an active interactive subagent, or null. */
	getSubagentSession(toolCallId: string): SubagentSession | null {
		return this.activeSubagents.get(toolCallId)?.session ?? null;
	}

	/** Find the SubagentSession that has a pending UI request with the given requestId. */
	findSessionByRequestId(requestId: string): SubagentSession | null {
		for (const sub of this.activeSubagents.values()) {
			if (sub.session?.hasUiRequest(requestId)) {
				return sub.session;
			}
		}
		return null;
	}

	/**
	 * Spawn a background subagent to handle a tool call asynchronously.
	 *
	 * @deprecated Use `SubagentSupervisorActor` via `RuntimeOrchestrator` instead.
	 * Retained for backward compatibility during the actor runtime transition.
	 */
	async handoff(
		toolCall: ToolCall,
		subagentConfig: SubagentConfig,
		externalSignal?: AbortSignal,
	): Promise<SubagentResult> {
		const controller = new AbortController();
		const session = subagentConfig.interactive
			? new SubagentSessionImpl(toolCall.toolCallId, subagentConfig)
			: undefined;
		const onExternalAbort = () => {
			session?.cancel();
			controller.abort();
		};
		externalSignal?.addEventListener('abort', onExternalAbort);

		// Wire interactive session callbacks so VoiceSession can relay
		// subagent questions to the user and clean up interaction mode.
		if (session) {
			if (this.subagentCallbacks?.onMessage) {
				session.onMessage((msg) => this.subagentCallbacks?.onMessage?.(toolCall.toolCallId, msg));
			}
			if (this.subagentCallbacks?.onSessionEnd) {
				session.onStateChange((newState) => {
					if (newState === 'completed' || newState === 'cancelled') {
						this.subagentCallbacks?.onSessionEnd?.(toolCall.toolCallId);
					}
				});
			}
		}

		this.activeSubagents.set(toolCall.toolCallId, {
			controller,
			toolCallId: toolCall.toolCallId,
			configName: subagentConfig.name,
			session,
		});

		this.eventBus.publish('agent.handoff', {
			sessionId: this.sessionManager.sessionId,
			agentName: this.activeAgent.name,
			subagentName: subagentConfig.name,
			toolCallId: toolCall.toolCallId,
		});

		const resolvedReasoningModel = subagentConfig.reasoningModel ?? this.model;
		const handoffWallStartedAt = Date.now();
		if (isHandoffDebugLogging()) {
			console.log(
				`[AgentRouter:handoff:start] sessionId=${this.sessionManager.sessionId} toolName=${toolCall.toolName} toolCallId=${toolCall.toolCallId} subagent=${subagentConfig.name} activeAgent=${this.activeAgent.name} reasoningOverride=${Boolean(subagentConfig.reasoningModel)} resolvedModelId=${reasoningModelLabelForLog(resolvedReasoningModel)}`,
			);
		}

		try {
			const context = this.conversationContext.getSubagentContext(
				{
					description: `Execute tool: ${toolCall.toolName}`,
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					args: toolCall.args,
				},
				subagentConfig.instructions,
				[],
			);

			const result = await runSubagent({
				config: subagentConfig,
				context,
				hooks: this.hooks,
				model: resolvedReasoningModel,
				abortSignal: controller.signal,
				session,
			});

			if (isHandoffDebugLogging()) {
				console.log(
					`[AgentRouter:handoff:ok] sessionId=${this.sessionManager.sessionId} toolName=${toolCall.toolName} toolCallId=${toolCall.toolCallId} subagent=${subagentConfig.name} wallMs=${Date.now() - handoffWallStartedAt} stepCount=${result.stepCount} textChars=${result.text?.length ?? 0}`,
				);
			}
			return result;
		} catch (err) {
			if (isHandoffDebugLogging()) {
				console.warn(
					`[AgentRouter:handoff:error] sessionId=${this.sessionManager.sessionId} toolName=${toolCall.toolName} toolCallId=${toolCall.toolCallId} subagent=${subagentConfig.name} wallMs=${Date.now() - handoffWallStartedAt} message=${err instanceof Error ? err.message : String(err)}`,
				);
			}
			throw err;
		} finally {
			externalSignal?.removeEventListener('abort', onExternalAbort);
			this.activeSubagents.delete(toolCall.toolCallId);
		}
	}

	/** Abort a running background subagent by its originating tool call ID. */
	cancelSubagent(toolCallId: string): void {
		const sub = this.activeSubagents.get(toolCallId);
		if (sub) {
			sub.session?.cancel();
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
			requestTransfer: (toAgent: string) => {
				setImmediate(() => {
					this.eventBus.publish('agent.transfer_requested', {
						sessionId: this.sessionManager.sessionId,
						toAgent,
					});
				});
			},
			stopBufferingAndDrain: (handler: (chunk: Buffer) => void) => {
				const buffered = this.clientTransport.stopBuffering();
				for (const chunk of buffered) {
					handler(chunk);
				}
			},
			sendJsonToClient: (message: Record<string, unknown>) => {
				this.clientTransport.sendJsonToClient(message);
			},
			sendAudioToClient: (data: Buffer) => {
				if (this.externalAudioCallbacks?.sendAudioToClient) {
					this.externalAudioCallbacks.sendAudioToClient(data);
					return;
				}
				this.clientTransport.sendAudioToClient(data);
			},
			setExternalAudioHandler: (handler: ((data: Buffer) => void) | null) => {
				this.externalAudioCallbacks?.setExternalAudioHandler?.(handler);
			},
		});
	}
}
