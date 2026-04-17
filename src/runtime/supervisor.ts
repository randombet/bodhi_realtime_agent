// SPDX-License-Identifier: MIT

/**
 * Supervision policies for the actor runtime.
 *
 * Each actor has a supervision policy that determines what happens when
 * it fails during message processing. Policies follow the per-actor matrix
 * from dev_docs/framework/actor-supervision-policy.md.
 */

import type { ActorId } from './envelope.js';
import type { Envelope } from './envelope.js';

// ---------------------------------------------------------------------------
// Supervision decisions
// ---------------------------------------------------------------------------

export type SupervisionAction = 'restart' | 'stop' | 'escalate' | 'resume';

export interface SupervisionDecision {
	action: SupervisionAction;
	/** For 'escalate': which actor receives the escalation. */
	escalateTo?: ActorId;
}

// ---------------------------------------------------------------------------
// Supervision policy
// ---------------------------------------------------------------------------

/** Per-actor policy determining fault handling behavior. */
export interface SupervisionPolicy {
	/** Default action on failure. */
	defaultAction: SupervisionAction;
	/** Actor to escalate to (when action is 'escalate'). */
	escalateTo?: ActorId;
	/** Max restarts within the window before escalating. */
	maxRestarts?: number;
	/** Time window (ms) for max restart counting. */
	restartWindow?: number;
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/** Tracks restart history for an actor. */
interface RestartRecord {
	timestamps: number[];
}

/**
 * Supervisor applies per-actor supervision policies to determine
 * how to handle failures.
 *
 * Supervision matrix (from execution plan):
 * - SessionActor: escalate on fatal orchestration inconsistency.
 * - TransportActor: restart/reconnect on recoverable transport failures.
 * - ToolRouterActor: resume (dead-letter invalid messages, continue session).
 * - SubagentSupervisorActor: resume (fail workflow, preserve session).
 * - SubagentActor: resume (fail workflow, preserve session).
 * - MainAgentActor: resume (emit transfer failure event, preserve session).
 * - ClientGatewayActor: resume (log error, continue session).
 */
export class Supervisor {
	private policies = new Map<ActorId, SupervisionPolicy>();
	private restartHistory = new Map<ActorId, RestartRecord>();

	/** Register a supervision policy for an actor. */
	registerPolicy(actorId: ActorId, policy: SupervisionPolicy): void {
		this.policies.set(actorId, policy);
	}

	/** Determine what to do when an actor fails. */
	handleFailure(actorId: ActorId, _error: unknown, _envelope: Envelope): SupervisionDecision {
		const policy = this.policies.get(actorId);
		if (!policy) {
			// No policy registered — resume by default (don't crash the session)
			return { action: 'resume' };
		}

		switch (policy.defaultAction) {
			case 'restart':
				return this.handleRestart(actorId, policy);
			case 'escalate':
				return { action: 'escalate', escalateTo: policy.escalateTo };
			case 'stop':
				return { action: 'stop' };
			case 'resume':
				return { action: 'resume' };
		}
	}

	private handleRestart(actorId: ActorId, policy: SupervisionPolicy): SupervisionDecision {
		const maxRestarts = policy.maxRestarts ?? 3;
		const window = policy.restartWindow ?? 60_000;
		const now = Date.now();

		let record = this.restartHistory.get(actorId);
		if (!record) {
			record = { timestamps: [] };
			this.restartHistory.set(actorId, record);
		}

		// Prune old timestamps outside the window
		record.timestamps = record.timestamps.filter((t) => now - t < window);

		if (record.timestamps.length >= maxRestarts) {
			// Exceeded restart limit — escalate instead
			return { action: 'escalate', escalateTo: policy.escalateTo };
		}

		record.timestamps.push(now);
		return { action: 'restart' };
	}
}

// ---------------------------------------------------------------------------
// Default policy presets
// ---------------------------------------------------------------------------

/** Default supervision policies per actor type (from execution plan). */
export const DEFAULT_POLICIES: Record<string, SupervisionPolicy> = {
	session: {
		defaultAction: 'escalate',
	},
	transport: {
		defaultAction: 'restart',
		maxRestarts: 3,
		restartWindow: 60_000,
	},
	'tool-router': {
		defaultAction: 'resume',
	},
	'subagent-supervisor': {
		defaultAction: 'resume',
	},
	subagent: {
		defaultAction: 'resume',
	},
	'main-agent': {
		defaultAction: 'resume',
	},
	'client-gateway': {
		defaultAction: 'resume',
	},
};
