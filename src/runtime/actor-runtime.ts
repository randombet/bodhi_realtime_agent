// SPDX-License-Identifier: MIT

/**
 * In-process actor runtime with per-actor serialized mailbox processing.
 *
 * The runtime manages actor lifecycle (start/stop), message delivery,
 * and integrates with the Supervisor for fault handling.
 *
 * Invariants:
 * - Per-actor message handling is serial (single mailbox consumer).
 * - Actor state is private; cross-actor access only via messages.
 * - Failures are supervised (restart/stop/escalate policy).
 * - Timers are explicit messages (`*.timeout`), not hidden callbacks.
 * - Audio data never flows through actor mailboxes (fast-path contract).
 */

import type { ActorId, Envelope } from './envelope.js';
import { createEnvelope } from './envelope.js';
import type { SupervisionDecision, Supervisor } from './supervisor.js';

// ---------------------------------------------------------------------------
// Actor interface
// ---------------------------------------------------------------------------

/** Lifecycle hooks + message handler for an actor. */
export interface Actor {
	/** Unique actor identity. */
	readonly id: ActorId;

	/** Called once when the actor is started (before any messages). */
	onStart?(): Promise<void>;

	/** Handle one envelope. Called serially — no concurrent invocations. */
	onMessage(envelope: Envelope): Promise<void>;

	/** Called when the actor is stopped. */
	onStop?(reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

/**
 * Per-actor mailbox with serial drain.
 * Guarantees exactly one concurrent onMessage processing per actor.
 */
class Mailbox {
	private queue: Envelope[] = [];
	private draining = false;

	constructor(
		private actor: Actor,
		private onError: (actor: Actor, error: unknown, envelope: Envelope) => void,
	) {}

	/** Enqueue an envelope and start draining if not already. */
	enqueue(envelope: Envelope): void {
		this.queue.push(envelope);
		if (!this.draining) {
			this.drain();
		}
	}

	/** Number of messages waiting to be processed. */
	get depth(): number {
		return this.queue.length;
	}

	private drain(): void {
		this.draining = true;

		const processNext = () => {
			if (this.queue.length === 0) {
				this.draining = false;
				return;
			}

			const envelope = this.queue.shift();
			if (!envelope) {
				this.draining = false;
				return;
			}
			this.actor
				.onMessage(envelope)
				.then(() => processNext())
				.catch((err) => {
					this.onError(this.actor, err, envelope);
					processNext();
				});
		};

		processNext();
	}
}

// ---------------------------------------------------------------------------
// Actor Runtime
// ---------------------------------------------------------------------------

/** Actor registration entry. */
interface ActorEntry {
	actor: Actor;
	mailbox: Mailbox;
	running: boolean;
}

/**
 * In-process actor runtime.
 *
 * Manages actor lifecycle, message routing, and mailbox serialization.
 * Integrates with a Supervisor for fault handling (restart/stop/escalate).
 */
export class ActorRuntime {
	private actors = new Map<ActorId, ActorEntry>();
	private supervisor: Supervisor | null = null;

	/** Register a supervisor for fault handling. */
	setSupervisor(supervisor: Supervisor): void {
		this.supervisor = supervisor;
	}

	/** Register and start an actor. */
	async startActor(actor: Actor): Promise<void> {
		if (this.actors.has(actor.id)) {
			throw new Error(`Actor "${actor.id}" is already registered`);
		}

		const mailbox = new Mailbox(actor, (a, err, env) => this.handleActorError(a, err, env));
		const entry: ActorEntry = { actor, mailbox, running: true };
		this.actors.set(actor.id, entry);

		await actor.onStart?.();
	}

	/** Stop an actor and remove it from the runtime. */
	async stopActor(actorId: ActorId, reason = 'stopped'): Promise<void> {
		const entry = this.actors.get(actorId);
		if (!entry) return;

		entry.running = false;
		this.actors.delete(actorId);
		await entry.actor.onStop?.(reason);
	}

	/** Send a message to an actor's mailbox. */
	send(envelope: Envelope): void {
		const entry = this.actors.get(envelope.to);
		if (!entry) {
			this.handleDeadLetter(envelope);
			return;
		}
		if (!entry.running) {
			this.handleDeadLetter(envelope);
			return;
		}
		entry.mailbox.enqueue(envelope);
	}

	/** Convenience: create an envelope and send it. */
	tell<TType extends string, TPayload>(
		type: TType,
		payload: TPayload,
		to: ActorId,
		options?: {
			from?: ActorId;
			correlationId?: string;
			causationId?: string;
		},
	): void {
		this.send(createEnvelope(type, payload, to, options));
	}

	/** Check if an actor is registered and running. */
	hasActor(actorId: ActorId): boolean {
		const entry = this.actors.get(actorId);
		return !!entry?.running;
	}

	/** Get the mailbox depth for an actor (for observability). */
	getMailboxDepth(actorId: ActorId): number {
		return this.actors.get(actorId)?.mailbox.depth ?? 0;
	}

	/** Stop all actors in reverse registration order. */
	async stopAll(reason = 'shutdown'): Promise<void> {
		const ids = [...this.actors.keys()].reverse();
		for (const id of ids) {
			await this.stopActor(id, reason);
		}
	}

	// -- Fault handling ------------------------------------------------------

	private handleActorError(actor: Actor, error: unknown, envelope: Envelope): void {
		if (!this.supervisor) {
			console.error(`[ActorRuntime] Unhandled error in actor "${actor.id}":`, error);
			return;
		}

		const decision = this.supervisor.handleFailure(actor.id, error, envelope);
		this.applyDecision(actor, decision, error);
	}

	private applyDecision(actor: Actor, decision: SupervisionDecision, error: unknown): void {
		switch (decision.action) {
			case 'restart':
				this.restartActor(actor).catch((restartErr) => {
					console.error(`[ActorRuntime] Restart failed for "${actor.id}":`, restartErr);
				});
				break;
			case 'stop':
				this.stopActor(actor.id, `supervised stop: ${error}`).catch((stopErr) => {
					console.error(`[ActorRuntime] Stop failed for "${actor.id}":`, stopErr);
				});
				break;
			case 'escalate':
				console.error(`[ActorRuntime] Escalating failure from "${actor.id}":`, error);
				if (decision.escalateTo) {
					this.tell(
						'supervisor.escalation',
						{
							fromActor: actor.id,
							error: error instanceof Error ? error.message : String(error),
						},
						decision.escalateTo,
					);
				}
				break;
			case 'resume':
				// Do nothing — actor continues processing next message
				break;
		}
	}

	private async restartActor(actor: Actor): Promise<void> {
		const entry = this.actors.get(actor.id);
		if (!entry) return;

		await actor.onStop?.('restart');
		await actor.onStart?.();
	}

	private handleDeadLetter(envelope: Envelope): void {
		console.warn(
			`[ActorRuntime] Dead letter: no actor "${envelope.to}" for message "${envelope.type}"`,
		);
	}
}
