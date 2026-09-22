/**
 * BackgroundAgentHostActor — hosts user-defined `BackgroundAgent`s.
 *
 * Named "Host" rather than "Supervisor" to avoid confusion with the
 * runtime-level `Supervisor` (`src/runtime/supervisor.ts`), which is the
 * fault-policy decider. This actor is just an OOP host: it owns the
 * `BackgroundAgent` instances, builds their per-session contexts, and
 * drives their lifecycle hooks. Failure handling for the host itself is
 * delegated to the runtime `Supervisor` via the `'background-agents': resume`
 * policy (see `supervisor.ts` DEFAULT_POLICIES).
 *
 * Drives the BackgroundAgent lifecycle from session-level envelopes that
 * SessionActor fans out to `'background-agents'`:
 *   - `session.connected`        → first-time `agent.onStart(ctx)` (deferred from
 *                                  the actor's own onStart; see lifecycle below).
 *   - `session.reconnected`      → `agent.onReconnect()` for every running agent.
 *   - `agent.transfer_completed` → `agent.onAgentTransfer({fromAgent,toAgent})`,
 *                                  plus `agent.onStop('transfer')` + abort signal
 *                                  when `cancelOnTransfer === true`.
 *   - `session.close_requested`  → `agent.onStop(reason)` + abort signal.
 *   - `transport.closed`         → same as close_requested (transport-driven close).
 *
 * Internal `cache: { phase, activeAgent }` is updated on every lifecycle
 * envelope; `BackgroundAgentContext.session` reads via getter from this
 * cache so agents observe live state without reaching across actor
 * boundaries (per the actor invariant "actor state is private").
 *
 * Throws inside any hook are caught and logged; per the
 * `'background-agents': resume` supervision policy, a misbehaving agent
 * does not bring down the session.
 */

import { randomUUID } from 'node:crypto';
import type {
	BackgroundAgent,
	BackgroundAgentContext,
	PublishNotification,
} from '../../agent/background-agent.js';
import type { Actor } from '../actor-runtime.js';
import type { ActorSendFn } from '../actor-send-fn.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { RuntimeMessage } from '../messages.js';

/** Mutable internal state, exposed read-only to BackgroundAgents via the session view. */
interface HostCache {
	phase: 'created' | 'connecting' | 'active' | 'reconnecting' | 'transferring' | 'closed';
	activeAgent: string;
}

/** Tracks one BackgroundAgent through its lifecycle. */
interface AgentState {
	agent: BackgroundAgent;
	ctx: BackgroundAgentContext;
	abortController: AbortController;
	started: boolean;
	stopped: boolean;
	failed: boolean;
}

export interface BackgroundAgentHostOptions {
	sessionId: string;
	userId: string;
	/** Initial active main-agent name; usually `OrchestratorConfig.initialAgent`. */
	initialAgent?: string;
	/** Optional debug logger. */
	log?: (msg: string) => void;
}

export class BackgroundAgentHostActor implements Actor {
	readonly id: ActorId;

	private readonly cache: HostCache;
	private readonly states = new Map<string, AgentState>();
	private readonly sessionId: string;
	private readonly userId: string;
	private readonly log: (msg: string) => void;

	constructor(
		id: ActorId,
		private sendMessage: ActorSendFn,
		private notificationActorId: ActorId,
		agents: BackgroundAgent[],
		options: BackgroundAgentHostOptions,
	) {
		this.id = id;
		this.sessionId = options.sessionId;
		this.userId = options.userId;
		this.log = options.log ?? (() => {});
		this.cache = {
			phase: 'created',
			activeAgent: options.initialAgent ?? '',
		};

		// Register every supplied agent and pre-build its context. We do NOT
		// call agent.onStart yet — that is deferred to the first
		// session.connected envelope so the first publish lands on a live
		// wire (the design's first-publish-vs-live-transport invariant).
		for (const agent of agents) {
			const abortController = new AbortController();
			const ctx = this.buildContext(agent, abortController);
			this.states.set(agent.name, {
				agent,
				ctx,
				abortController,
				started: false,
				stopped: false,
				failed: false,
			});
		}
	}

	async onMessage(envelope: Envelope): Promise<void> {
		const msg = envelope as Envelope<RuntimeMessage['type']>;
		switch (msg.type) {
			case 'session.connected': {
				this.cache.phase = 'active';
				await this.runFirstStart();
				break;
			}
			case 'session.reconnected': {
				this.cache.phase = 'active';
				this.runOnReconnect();
				break;
			}
			case 'agent.transfer_completed': {
				// Drop the transferCorrelationId (internal); agents only see
				// the user-visible {fromAgent, toAgent} pair.
				const p = msg.payload as {
					fromAgent: string;
					toAgent: string;
					transferCorrelationId?: string;
				};
				this.cache.activeAgent = p.toAgent;
				this.runOnAgentTransfer({ fromAgent: p.fromAgent, toAgent: p.toAgent });
				break;
			}
			case 'session.close_requested': {
				const p = msg.payload as { reason?: string };
				this.cache.phase = 'closed';
				await this.stopAll(p.reason ?? 'session_close_requested');
				break;
			}
			case 'transport.closed': {
				const p = msg.payload as { reason?: string };
				this.cache.phase = 'closed';
				await this.stopAll(p.reason ?? 'transport_closed');
				break;
			}
			default:
				break;
		}
	}

	async onStop(reason: string): Promise<void> {
		// Final safety net: ensure no agent leaks an active interval / timer
		// past actor shutdown if it never received a close envelope.
		await this.stopAll(reason);
	}

	// -- Internals -----------------------------------------------------------

	private buildContext(
		agent: BackgroundAgent,
		abortController: AbortController,
	): BackgroundAgentContext {
		const sessionId = this.sessionId;
		const userId = this.userId;
		const cache = this.cache;
		const sendMessage = this.sendMessage;
		const notificationActorId = this.notificationActorId;
		const log = this.log;

		return {
			sessionId,
			userId,
			publish(n: PublishNotification): void {
				// correlationId precedence: caller-supplied wins; otherwise
				// synthesize a stable, traceable id of the form
				// `${sessionId}-${agent.name}-${randomId}`.
				const { correlationId, ...payload } = n;
				sendMessage('notification.publish', payload, notificationActorId, {
					correlationId: correlationId ?? `${sessionId}-${agent.name}-${randomUUID().slice(0, 8)}`,
				});
			},
			signal: abortController.signal,
			session: {
				get phase() {
					return cache.phase;
				},
				get activeAgent() {
					return cache.activeAgent;
				},
			},
			log(msg: string): void {
				log(`[BgAgent:${agent.name}] ${msg}`);
			},
		};
	}

	private async runFirstStart(): Promise<void> {
		for (const state of this.states.values()) {
			if (state.started || state.stopped || state.failed) continue;
			try {
				await state.agent.onStart(state.ctx);
				state.started = true;
			} catch (err) {
				state.failed = true;
				this.log(
					`agent "${state.agent.name}" onStart threw: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	private runOnReconnect(): void {
		for (const state of this.states.values()) {
			if (!state.started || state.stopped || state.failed) continue;
			if (!state.agent.onReconnect) continue;
			try {
				state.agent.onReconnect();
			} catch (err) {
				this.log(
					`agent "${state.agent.name}" onReconnect threw: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	private runOnAgentTransfer(event: { fromAgent: string; toAgent: string }): void {
		for (const state of this.states.values()) {
			if (!state.started || state.stopped || state.failed) continue;

			// onAgentTransfer is invoked regardless of cancelOnTransfer, so the
			// agent can observe the transition (e.g. log it) before being
			// cancelled.
			if (state.agent.onAgentTransfer) {
				try {
					state.agent.onAgentTransfer(event);
				} catch (err) {
					this.log(
						`agent "${state.agent.name}" onAgentTransfer threw: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// Then, if cancelOnTransfer is true, abort + onStop('transfer').
			if (state.agent.cancelOnTransfer) {
				state.abortController.abort();
				if (state.agent.onStop) {
					try {
						const result = state.agent.onStop('transfer');
						// Allow async onStop, but don't block the host.
						if (result instanceof Promise) {
							result.catch((err) => {
								this.log(
									`agent "${state.agent.name}" onStop(transfer) threw: ${err instanceof Error ? err.message : String(err)}`,
								);
							});
						}
					} catch (err) {
						this.log(
							`agent "${state.agent.name}" onStop(transfer) threw: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				state.stopped = true;
			}
		}
	}

	private async stopAll(reason: string): Promise<void> {
		for (const state of this.states.values()) {
			if (state.stopped) continue;
			state.abortController.abort();
			if (state.agent.onStop) {
				try {
					await state.agent.onStop(reason);
				} catch (err) {
					this.log(
						`agent "${state.agent.name}" onStop(${reason}) threw: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			state.stopped = true;
		}
	}
}
