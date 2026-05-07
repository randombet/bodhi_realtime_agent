// SPDX-License-Identifier: MIT

/**
 * Shared message-send callback type used by every actor in the runtime.
 *
 * The 4th `options` argument is optional — existing 3-arg call sites continue
 * to type-check unchanged. The runtime-orchestrator's `sendFn` now forwards
 * all four arguments to `ActorRuntime.tell`, so envelope metadata (correlation
 * id, causation id, sender id) propagates from any caller end-to-end.
 *
 * Motivated by `NotificationActor` needing to carry `Envelope.correlationId`
 * from a `notification.publish` envelope onto its `notification.delivered`
 * fan-out envelopes — see
 * `dev_docs/framework/design-background-notification-actor.md`.
 */

import type { ActorId, CorrelationId } from './envelope.js';
import type { RuntimeMessage } from './messages.js';

/** Optional envelope metadata accepted alongside type/payload/to. */
export interface ActorSendOptions {
	/** Sender actor id. Omit for system-originated sends. */
	from?: ActorId;
	/** Links related messages in a workflow (e.g. all messages for one tool call). */
	correlationId?: CorrelationId;
	/** Id of the message that caused this one (causal chain). */
	causationId?: CorrelationId;
}

/**
 * Canonical actor message-send signature. The 4th `options` argument is
 * optional so legacy 3-arg call sites continue to type-check.
 */
export type ActorSendFn = (
	type: RuntimeMessage['type'],
	payload: unknown,
	to: ActorId,
	options?: ActorSendOptions,
) => void;
