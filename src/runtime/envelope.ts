// SPDX-License-Identifier: MIT

/**
 * Typed envelope for actor-to-actor messaging.
 *
 * All control-plane communication flows through envelopes. Audio data
 * stays on the direct-callback fast path (see audio-fast-path-contract.md).
 */

/** Actor identity — opaque string. */
export type ActorId = string;

/** Correlation identifier for linking related messages across a workflow. */
export type CorrelationId = string;

/**
 * Typed envelope carrying a message between actors.
 *
 * @template TType - Message type string (discriminant).
 * @template TPayload - Message-specific payload.
 */
export interface Envelope<TType extends string = string, TPayload = unknown> {
	/** Message type string following `domain.action` naming convention. */
	readonly type: TType;
	/** Message-specific data payload. */
	readonly payload: TPayload;
	/** Links related messages in a workflow (e.g., all messages for one tool call). */
	readonly correlationId?: CorrelationId;
	/** ID of the message that caused this one (causal chain). */
	readonly causationId?: CorrelationId;
	/** Timestamp (ms since epoch) when the envelope was created. */
	readonly at: number;
	/** Sender actor ID. Omitted for external/system-originated messages. */
	readonly from?: ActorId;
	/** Recipient actor ID. */
	readonly to: ActorId;
}

/** Create an envelope with default timestamp. */
export function createEnvelope<TType extends string, TPayload>(
	type: TType,
	payload: TPayload,
	to: ActorId,
	options?: {
		from?: ActorId;
		correlationId?: CorrelationId;
		causationId?: CorrelationId;
	},
): Envelope<TType, TPayload> {
	return {
		type,
		payload,
		to,
		at: Date.now(),
		from: options?.from,
		correlationId: options?.correlationId,
		causationId: options?.causationId,
	};
}
