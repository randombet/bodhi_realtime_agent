// SPDX-License-Identifier: MIT

/**
 * Observability contract for the actor runtime.
 *
 * Provides structured logging, metrics, and tracing primitives for
 * workflow transitions, message processing, and actor lifecycle events.
 *
 * Required fields on every observable event:
 * - correlationId: ties related messages together
 * - causationId: identifies the direct cause
 * - actorId: which actor processed/emitted the event
 * - workflowId: (optional) workflow context
 * - toolCallId: (optional) tool call context
 */

import type { ActorId, Envelope } from './envelope.js';

/** A structured observability event. */
export interface ObservableEvent {
	/** Event category. */
	category: 'message' | 'lifecycle' | 'workflow' | 'error' | 'dead_letter';
	/** Actor that produced or processed this event. */
	actorId: ActorId;
	/** The message type being observed. */
	messageType: string;
	/** Correlation ID for tracing. */
	correlationId?: string;
	/** Causation ID (the message that caused this one). */
	causationId?: string;
	/** Workflow ID if applicable. */
	workflowId?: string;
	/** Tool call ID if applicable. */
	toolCallId?: string;
	/** Timestamp in ms. */
	timestamp: number;
	/** Additional metadata. */
	metadata?: Record<string, unknown>;
}

/** Metrics collected by the observability layer. */
export interface RuntimeMetrics {
	/** Current mailbox depth per actor. */
	mailboxDepth: Map<ActorId, number>;
	/** Total messages processed per actor. */
	messagesProcessed: Map<ActorId, number>;
	/** Total failures per actor. */
	failureCount: Map<ActorId, number>;
	/** Dead letters total count. */
	deadLetterCount: number;
	/** Active workflow count. */
	activeWorkflowCount: number;
}

/** Callback for observability events. */
export type ObservabilityListener = (event: ObservableEvent) => void;

/**
 * RuntimeObserver collects observability data from the actor runtime.
 *
 * Designed to be zero-overhead when no listener is attached.
 */
export class RuntimeObserver {
	private listener: ObservabilityListener | undefined;
	private _messagesProcessed = new Map<ActorId, number>();
	private _failureCount = new Map<ActorId, number>();
	private _deadLetterCount = 0;

	/** Set the observability listener. */
	setListener(listener: ObservabilityListener): void {
		this.listener = listener;
	}

	/** Record a message being processed by an actor. */
	recordMessageProcessed(actorId: ActorId, envelope: Envelope): void {
		const count = this._messagesProcessed.get(actorId) ?? 0;
		this._messagesProcessed.set(actorId, count + 1);

		if (this.listener) {
			this.listener({
				category: 'message',
				actorId,
				messageType: envelope.type,
				correlationId: envelope.correlationId,
				causationId: envelope.causationId,
				timestamp: Date.now(),
			});
		}
	}

	/** Record an actor failure. */
	recordFailure(actorId: ActorId, error: unknown, envelope: Envelope): void {
		const count = this._failureCount.get(actorId) ?? 0;
		this._failureCount.set(actorId, count + 1);

		if (this.listener) {
			this.listener({
				category: 'error',
				actorId,
				messageType: envelope.type,
				correlationId: envelope.correlationId,
				causationId: envelope.causationId,
				timestamp: Date.now(),
				metadata: {
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	/** Record a dead letter. */
	recordDeadLetter(envelope: Envelope): void {
		this._deadLetterCount++;

		if (this.listener) {
			this.listener({
				category: 'dead_letter',
				actorId: envelope.to,
				messageType: envelope.type,
				correlationId: envelope.correlationId,
				timestamp: Date.now(),
			});
		}
	}

	/** Record a workflow transition. */
	recordWorkflowTransition(
		actorId: ActorId,
		workflowId: string,
		fromState: string,
		toState: string,
		toolCallId?: string,
	): void {
		if (this.listener) {
			this.listener({
				category: 'workflow',
				actorId,
				messageType: `workflow.${fromState}_to_${toState}`,
				workflowId,
				toolCallId,
				timestamp: Date.now(),
			});
		}
	}

	/** Record an actor lifecycle event. */
	recordLifecycle(actorId: ActorId, event: 'started' | 'stopped' | 'restarted'): void {
		if (this.listener) {
			this.listener({
				category: 'lifecycle',
				actorId,
				messageType: `actor.${event}`,
				timestamp: Date.now(),
			});
		}
	}

	/** Get current metrics snapshot. */
	getMetrics(getMailboxDepth: (actorId: ActorId) => number, actorIds: ActorId[]): RuntimeMetrics {
		const mailboxDepth = new Map<ActorId, number>();
		for (const id of actorIds) {
			mailboxDepth.set(id, getMailboxDepth(id));
		}

		return {
			mailboxDepth,
			messagesProcessed: new Map(this._messagesProcessed),
			failureCount: new Map(this._failureCount),
			deadLetterCount: this._deadLetterCount,
			activeWorkflowCount: 0, // filled by caller
		};
	}

	/** Get total messages processed by an actor. */
	getMessagesProcessed(actorId: ActorId): number {
		return this._messagesProcessed.get(actorId) ?? 0;
	}

	/** Get total failure count for an actor. */
	getFailureCount(actorId: ActorId): number {
		return this._failureCount.get(actorId) ?? 0;
	}

	/** Get total dead letter count. */
	get deadLetterCount(): number {
		return this._deadLetterCount;
	}

	/** Reset all counters. */
	reset(): void {
		this._messagesProcessed.clear();
		this._failureCount.clear();
		this._deadLetterCount = 0;
	}
}
