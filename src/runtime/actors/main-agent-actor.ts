// SPDX-License-Identifier: MIT

/**
 * MainAgentActor — owns agent transfer orchestration and lifecycle hooks.
 *
 * Receives `agent.transfer_requested` messages and coordinates the transfer
 * through the TransportActor (disconnect/reconnect) and SessionActor (state
 * transitions). Fires onEnter/onExit hooks on the affected agents.
 *
 * Does NOT own agent state or session state — those remain in AgentRouter and
 * SessionManager respectively.
 */

import type { Actor } from '../actor-runtime.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { RuntimeMessage } from '../messages.js';

/** Agent definition as seen by the MainAgentActor. */
export interface AgentDefinition {
	name: string;
	instructions: string;
	tools: unknown[];
	providerOptions?: Record<string, unknown>;
	onEnter?: () => Promise<void> | void;
	onExit?: () => Promise<void> | void;
}

/** Hook callbacks that MainAgentActor fires at lifecycle points. */
export interface MainAgentHooks {
	onAgentTransfer?: (info: {
		fromAgent: string;
		toAgent: string;
		transferCorrelationId: string;
	}) => void;
	onError?: (info: {
		component: string;
		error: string;
		severity: string;
	}) => void;
}

export class MainAgentActor implements Actor {
	readonly id: ActorId;
	private agents = new Map<string, AgentDefinition>();
	private _activeAgentName: string | undefined;

	constructor(
		id: ActorId,
		private sendMessage: (type: RuntimeMessage['type'], payload: unknown, to: ActorId) => void,
		private transportActorId: ActorId,
		private sessionActorId: ActorId,
		private hooks: MainAgentHooks = {},
	) {
		this.id = id;
	}

	/** Register available agents. */
	registerAgents(agents: AgentDefinition[]): void {
		for (const agent of agents) {
			this.agents.set(agent.name, agent);
		}
	}

	/** Set the initial active agent (before any transfers). */
	setActiveAgent(agentName: string): void {
		this._activeAgentName = agentName;
	}

	/** Get the current active agent name. */
	get activeAgentName(): string | undefined {
		return this._activeAgentName;
	}

	async onMessage(envelope: Envelope): Promise<void> {
		switch (envelope.type) {
			case 'agent.transfer_requested': {
				const p = envelope.payload as {
					toAgent: string;
					transferCorrelationId: string;
				};
				await this.handleTransferRequest(p);
				break;
			}
			default:
				break;
		}
	}

	private async handleTransferRequest(p: {
		toAgent: string;
		transferCorrelationId: string;
	}): Promise<void> {
		const toAgent = this.agents.get(p.toAgent);
		if (!toAgent) {
			this.sendMessage(
				'agent.transfer_failed',
				{
					toAgent: p.toAgent,
					error: `Unknown agent: ${p.toAgent}`,
					transferCorrelationId: p.transferCorrelationId,
				},
				this.sessionActorId,
			);
			return;
		}

		const fromAgentName = this._activeAgentName;
		const fromAgent = fromAgentName ? this.agents.get(fromAgentName) : undefined;

		try {
			// 1. Fire onExit on current agent
			if (fromAgent?.onExit) {
				await fromAgent.onExit();
			}

			// 2. Request transport to transfer session
			this.sendMessage(
				'transport.transfer_session',
				{
					config: {
						instructions: toAgent.instructions,
						tools: toAgent.tools,
						providerOptions: toAgent.providerOptions ?? {},
					},
					state: {
						conversationHistory: [],
					},
				},
				this.transportActorId,
			);

			// 3. Update active agent
			this._activeAgentName = p.toAgent;

			// 4. Fire onEnter on new agent
			if (toAgent.onEnter) {
				await toAgent.onEnter();
			}

			// 5. Notify session of successful transfer
			this.sendMessage(
				'agent.transfer_completed',
				{
					fromAgent: fromAgentName ?? 'none',
					toAgent: p.toAgent,
					transferCorrelationId: p.transferCorrelationId,
				},
				this.sessionActorId,
			);

			// 6. Fire hooks
			if (this.hooks.onAgentTransfer) {
				this.hooks.onAgentTransfer({
					fromAgent: fromAgentName ?? 'none',
					toAgent: p.toAgent,
					transferCorrelationId: p.transferCorrelationId,
				});
			}
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);

			this.sendMessage(
				'agent.transfer_failed',
				{
					toAgent: p.toAgent,
					error: errorMsg,
					transferCorrelationId: p.transferCorrelationId,
				},
				this.sessionActorId,
			);

			if (this.hooks.onError) {
				this.hooks.onError({
					component: 'main-agent-actor',
					error: errorMsg,
					severity: 'error',
				});
			}
		}
	}
}
