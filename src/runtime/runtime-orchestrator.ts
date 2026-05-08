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

import type { BackgroundAgent } from '../agent/background-agent.js';
import { ActorRuntime } from './actor-runtime.js';
import type { ActorSendFn } from './actor-send-fn.js';
import { BackgroundAgentHostActor } from './actors/background-agent-host-actor.js';
import { ClientGatewayActor } from './actors/client-gateway-actor.js';
import type { ClientSendFn } from './actors/client-gateway-actor.js';
import { MainAgentActor } from './actors/main-agent-actor.js';
import type { AgentDefinition, MainAgentHooks } from './actors/main-agent-actor.js';
import { NotificationActor } from './actors/notification-actor.js';
import { NotificationHooksObserverActor } from './actors/notification-hooks-observer-actor.js';
import type { OnBackgroundNotificationCallback } from './actors/notification-hooks-observer-actor.js';
import { SessionActor } from './actors/session-actor.js';
import type { ReconnectPolicy } from './actors/session-actor.js';
import { SubagentSupervisorActor } from './actors/subagent-supervisor-actor.js';
import type { SubagentExecutionHandler } from './actors/subagent-supervisor-actor.js';
import { ToolRouterActor } from './actors/tool-router-actor.js';
import type { InlineToolExecutor, ToolRoutingInfo } from './actors/tool-router-actor.js';
import { TransportActor } from './actors/transport-actor.js';
import type { TransportAdapter } from './adapters/transport-adapter.js';
import { DeadLetterQueue } from './dead-letter-queue.js';
import type { NotificationFilter } from './messages.js';
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
	/** Required so `BackgroundAgentContext.sessionId` and the `onBackgroundNotification` event payload carry a stable session id. */
	sessionId?: string;
	/** User id threaded into BackgroundAgentContext.userId. Defaults to `''`. */
	userId?: string;
	/**
	 * User-defined BackgroundAgents to host. Each is started by
	 * BackgroundAgentHostActor on the first session.connected envelope
	 * (deferred so the first publish lands on a live wire).
	 */
	backgroundAgents?: BackgroundAgent[];
	/** Optional notification subsystem configuration (NotificationActor + subscribers). */
	notification?: {
		/**
		 * Subscription filter for `TransportActor` (the default subscriber that
		 * wraps `notification.delivered` into `[label]: text` and writes via
		 * `adapter.sendContent`). Omit to subscribe to all labels.
		 */
		transportSubscriptionFilter?: NotificationFilter;
		/**
		 * Callback invoked by `NotificationHooksObserverActor` on every
		 * delivered notification. Wired by VoiceSession to forward
		 * `FrameworkHooks.onBackgroundNotification`. Omit to disable the
		 * observer (orchestrator skips constructing it — zero-overhead).
		 */
		onBackgroundNotification?: OnBackgroundNotificationCallback;
	};
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
	readonly notificationActor: NotificationActor;
	/** Built-in observability subscriber. Constructed only when an
	 *  onBackgroundNotification callback is configured. */
	readonly notificationHooksObserver: NotificationHooksObserverActor | null;
	/** Hosts user-defined BackgroundAgents. Always constructed (even when
	 *  no agents are registered) so SessionActor's fan-out envelopes have
	 *  a live recipient and don't dead-letter. */
	readonly backgroundAgentHost: BackgroundAgentHostActor;
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

		// Message routing: all actor sends go through the runtime.
		// Forwards the optional 4th `options` argument so envelope metadata
		// (correlation id, causation id, sender id) propagates end-to-end.
		const sendFn: ActorSendFn = (type, payload, to, options) => {
			this.runtime.tell(type, payload, to, options);
		};

		// Create actors
		this.transportActor = new TransportActor(
			'transport',
			config.adapter,
			sendFn,
			'session',
			'tool-router',
			'notification',
			config.notification?.transportSubscriptionFilter,
		);
		// SessionActor fan-out target: the BackgroundAgentHostActor below is
		// addressed via id 'background-agents'. SessionActor sends lifecycle
		// envelopes (session.connected, session.reconnected,
		// session.close_requested, transport.closed) to that address; the host
		// invokes onStart / onReconnect / onStop on each registered
		// BackgroundAgent. See
		// dev_docs/framework/design-background-notification-actor.md.
		this.sessionActor = new SessionActor(
			'session',
			sendFn,
			'transport',
			config.reconnectPolicy,
			'background-agents',
		);
		// NotificationActor: actor-mode home of the legacy
		// BackgroundNotificationQueue. Started immediately after SessionActor so
		// any subsequent subscriber's onStart can register without dead-lettering.
		this.notificationActor = new NotificationActor('notification', sendFn, {
			messageTruncation: config.adapter.capabilities.messageTruncation,
		});
		// NotificationHooksObserverActor: built-in subscriber. Construct only
		// when a callback is configured (zero-overhead when unattached).
		this.notificationHooksObserver = config.notification?.onBackgroundNotification
			? new NotificationHooksObserverActor(
					'notification-hooks-observer',
					sendFn,
					'notification',
					config.notification.onBackgroundNotification,
					config.sessionId ?? '',
				)
			: null;
		// BackgroundAgentHostActor: hosts user-defined BackgroundAgents AND
		// receives SessionActor's lifecycle fan-out envelopes. Always
		// constructed, even with zero agents, so SessionActor's sends to
		// 'background-agents' have a live recipient.
		this.backgroundAgentHost = new BackgroundAgentHostActor(
			'background-agents',
			sendFn,
			'notification',
			config.backgroundAgents ?? [],
			{
				sessionId: config.sessionId ?? '',
				userId: config.userId ?? '',
				initialAgent: config.initialAgent,
			},
		);
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

		// Order constraints:
		//   1. NotificationActor before any subscriber (TransportActor,
		//      NotificationHooksObserverActor) so notification.subscribe
		//      envelopes don't dead-letter.
		//   2. BackgroundAgentHostActor before TransportActor so the first
		//      session.connected envelope (emitted indirectly by the adapter's
		//      onSessionReady → SessionActor) doesn't race ahead of the host's
		//      onStart and dead-letter at 'background-agents'.
		await this.runtime.startActor(this.sessionActor);
		await this.runtime.startActor(this.notificationActor);
		if (this.notificationHooksObserver) {
			await this.runtime.startActor(this.notificationHooksObserver);
		}
		await this.runtime.startActor(this.backgroundAgentHost);
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
