// SPDX-License-Identifier: MIT

/**
 * RuntimeOrchestrator — convenience wiring for the full actor graph.
 *
 * Creates and starts all actors, wires their message routing through the
 * ActorRuntime, and provides a clean start/stop lifecycle.
 *
 * This is the canonical entry point for the actor-based orchestration layer.
 * Legacy orchestration (ToolCallRouter, AgentRouter.transfer/handoff) is
 * deprecated in favor of this runtime.
 */

import { ActorRuntime } from './actor-runtime.js';
import { ClientGatewayActor } from './actors/client-gateway-actor.js';
import type { ClientSendFn } from './actors/client-gateway-actor.js';
import { MainAgentActor } from './actors/main-agent-actor.js';
import type { AgentDefinition, MainAgentHooks } from './actors/main-agent-actor.js';
import { SessionActor } from './actors/session-actor.js';
import type { ReconnectPolicy } from './actors/session-actor.js';
import { SubagentSupervisorActor } from './actors/subagent-supervisor-actor.js';
import type { SubagentExecutionHandler } from './actors/subagent-supervisor-actor.js';
import { ToolRouterActor } from './actors/tool-router-actor.js';
import type { InlineToolExecutor, ToolRoutingInfo } from './actors/tool-router-actor.js';
import { TransportActor } from './actors/transport-actor.js';
import type { TransportAdapter } from './adapters/transport-adapter.js';
import { DeadLetterQueue } from './dead-letter-queue.js';
import type { ActorId } from './envelope.js';
import type { RuntimeMessage } from './messages.js';
import { RuntimeObserver } from './observability.js';
import { DEFAULT_POLICIES, Supervisor } from './supervisor.js';

/** Configuration for RuntimeOrchestrator. */
export interface OrchestratorConfig {
	/** Transport adapter (Gemini or OpenAI). */
	adapter: TransportAdapter;
	/** Tool routing registry. */
	tools: Map<string, ToolRoutingInfo>;
	/** Inline tool executor callback. */
	inlineExecutor: InlineToolExecutor;
	/** Client WebSocket send function. */
	clientSend: ClientSendFn;
	/** Agent definitions for transfer support. */
	agents?: AgentDefinition[];
	/** Initial active agent name. */
	initialAgent?: string;
	/** Reconnect backoff policy. */
	reconnectPolicy?: Partial<ReconnectPolicy>;
	/** Agent lifecycle hooks. */
	hooks?: MainAgentHooks;
	/** Optional transfer callback used by ToolRouterActor for transfer_to_agent. */
	onTransferRequested?: (toAgent: string) => Promise<void> | void;
	/** Optional execution bridge for background subagent workflows. */
	backgroundExecutor?: SubagentExecutionHandler;
}

/**
 * Wires and manages the full actor graph.
 *
 * Usage:
 * ```typescript
 * const orchestrator = new RuntimeOrchestrator(config);
 * await orchestrator.start();
 * // ... runtime operates via adapter callbacks ...
 * await orchestrator.stop();
 * ```
 */
export class RuntimeOrchestrator {
	readonly runtime: ActorRuntime;
	readonly supervisor: Supervisor;
	readonly observer: RuntimeObserver;
	readonly deadLetterQueue: DeadLetterQueue;

	// Actors (exposed for testing/inspection)
	readonly transportActor: TransportActor;
	readonly sessionActor: SessionActor;
	readonly toolRouterActor: ToolRouterActor;
	readonly subagentSupervisor: SubagentSupervisorActor;
	readonly mainAgentActor: MainAgentActor;
	readonly clientGatewayActor: ClientGatewayActor;

	private started = false;

	constructor(config: OrchestratorConfig) {
		this.runtime = new ActorRuntime();
		this.supervisor = new Supervisor();
		this.observer = new RuntimeObserver();
		this.deadLetterQueue = new DeadLetterQueue();

		// Register default supervision policies
		for (const [actorId, policy] of Object.entries(DEFAULT_POLICIES)) {
			this.supervisor.registerPolicy(actorId, policy);
		}
		this.runtime.setSupervisor(this.supervisor);

		// Message routing: all actor sends go through the runtime
		const sendFn = (type: RuntimeMessage['type'], payload: unknown, to: ActorId) => {
			this.runtime.tell(type, payload, to);
		};

		// Create actors
		this.transportActor = new TransportActor(
			'transport',
			config.adapter,
			sendFn,
			'session',
			'tool-router',
		);
		this.sessionActor = new SessionActor('session', sendFn, 'transport', config.reconnectPolicy);
		this.toolRouterActor = new ToolRouterActor(
			'tool-router',
			config.tools,
			config.inlineExecutor,
			sendFn,
			'transport',
			'subagent-supervisor',
			'main-agent',
			config.onTransferRequested,
		);
		this.subagentSupervisor = new SubagentSupervisorActor(
			'subagent-supervisor',
			sendFn,
			'transport',
			'session',
			config.backgroundExecutor,
		);
		this.mainAgentActor = new MainAgentActor(
			'main-agent',
			sendFn,
			'transport',
			'session',
			config.hooks,
		);
		this.clientGatewayActor = new ClientGatewayActor(
			'client-gateway',
			sendFn,
			config.clientSend,
			'session',
		);

		// Register agents if provided
		if (config.agents) {
			this.mainAgentActor.registerAgents(config.agents);
		}
		if (config.initialAgent) {
			this.mainAgentActor.setActiveAgent(config.initialAgent);
		}
	}

	/** Start all actors in dependency order. */
	async start(): Promise<void> {
		if (this.started) {
			throw new Error('RuntimeOrchestrator already started');
		}

		await this.runtime.startActor(this.sessionActor);
		await this.runtime.startActor(this.transportActor);
		await this.runtime.startActor(this.toolRouterActor);
		await this.runtime.startActor(this.subagentSupervisor);
		await this.runtime.startActor(this.mainAgentActor);
		await this.runtime.startActor(this.clientGatewayActor);

		this.started = true;
	}

	/** Stop all actors in reverse order. */
	async stop(): Promise<void> {
		if (!this.started) return;
		await this.runtime.stopAll('orchestrator shutdown');
		this.started = false;
	}

	/** Whether the orchestrator is running. */
	get isRunning(): boolean {
		return this.started;
	}
}
