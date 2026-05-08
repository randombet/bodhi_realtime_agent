// SPDX-License-Identifier: MIT

/**
 * BackgroundAgent — user-facing interface for always-on producers in actor mode.
 *
 * BackgroundAgents inject synthetic user turns into the live LLM via
 * `NotificationActor`. They run in their own lifecycle (independent of any
 * tool call) and are hosted by `BackgroundAgentHostActor`. Typical use
 * cases: wall-clock reminders (e.g. "5 minutes left in this interview"),
 * external-channel alerts that should be spoken by the live agent, polling
 * for changes in an external system.
 *
 * Distinction from subagents:
 *   - A subagent is a Vercel AI SDK `generateText` loop spawned per tool call
 *     (or reused as `persistent_session`). It produces text that the live LLM
 *     speaks via the tool-result protocol or the `[SYSTEM: …]` notification
 *     path.
 *   - A BackgroundAgent has its OWN lifecycle: started once on
 *     `session.connected`, observed by `agent.transfer_completed` and
 *     `session.reconnected`, stopped on `session.close_requested` /
 *     `transport.closed`. It produces notifications proactively, without
 *     being invoked by the live LLM.
 *
 * See `dev_docs/framework/design-background-notification-actor.md` —
 * "BackgroundAgent and BackgroundAgentHostActor" section.
 */

import type { KnownNotificationLabel } from '../runtime/messages.js';

/**
 * Producer-facing notification payload. Published via `BackgroundAgentContext.publish`.
 *
 * Shape mirrors the inbound `notification.publish` actor message minus
 * caller-side conveniences:
 *   - `id` is auto-assigned by NotificationActor when omitted.
 *   - `correlationId` is destructured by the host actor and forwarded as the
 *     envelope's correlationId — it is NOT a payload field on the wire.
 */
export interface PublishNotification {
	/**
	 * Label that NotificationActor wraps as `[label]: text` at TransportActor's
	 * wire-out boundary. Normalized on ingest (uppercase + sanitize to
	 * `[A-Z0-9 _-]`, max 32 chars, fallback to `'SYSTEM'` if empty).
	 */
	label: KnownNotificationLabel | (string & {});

	/** Body text the LLM will speak (after normalization through synthetic user turn). */
	text: string;

	/** Default `'normal'`. `'high'` triggers cancel-and-deliver on truncation-capable transports. */
	priority?: 'normal' | 'high';

	/** Default `true`. Forwarded as `transport.send_content.turnComplete`. */
	turnComplete?: boolean;

	/**
	 * When set, NotificationActor replaces any pending entry with the same key
	 * (latest-wins). Useful for periodic reminders where only the freshest
	 * value matters (e.g. `'time-reminder'`).
	 */
	dedupKey?: string;

	/**
	 * Optional caller-supplied envelope correlation id. Caller ergonomics only —
	 * the host actor strips this off the publish payload before sending and
	 * forwards it as the envelope's correlationId. If omitted, the host
	 * synthesizes `${sessionId}-${agent.name}-${randomId}` for trace
	 * continuity.
	 */
	correlationId?: string;
}

/**
 * Read-only view of the live session state, threaded into BackgroundAgents
 * via `BackgroundAgentContext.session`. The host actor maintains an internal
 * cache (mailbox-serialized) updated on every lifecycle envelope; agents read
 * the current values via these getters without reaching across actor
 * boundaries.
 */
export interface BackgroundAgentSessionView {
	/**
	 * One of the SessionActor phases. Most agents only care about whether the
	 * session is `'active'`, `'reconnecting'`, or `'closed'`.
	 */
	readonly phase: 'created' | 'connecting' | 'active' | 'reconnecting' | 'transferring' | 'closed';

	/** Name of the currently active main agent (updates on `agent.transfer_completed`). */
	readonly activeAgent: string;
}

/**
 * Runtime context passed to each BackgroundAgent's lifecycle hooks. Built
 * fresh per session by the host actor.
 */
export interface BackgroundAgentContext {
	readonly sessionId: string;
	readonly userId: string;

	/**
	 * Publish a synthetic user turn through NotificationActor. Equivalent to
	 * sending `notification.publish` with the producer-supplied label, text,
	 * priority, etc. The host actor handles correlationId routing — it is
	 * stripped from the payload and forwarded as envelope metadata.
	 */
	publish(notification: PublishNotification): void;

	/**
	 * Aborts when the session closes (always) and on agent transfer when
	 * `cancelOnTransfer === true`. Use this to interrupt long-running
	 * `setInterval` / `setTimeout` / external-fetch loops cleanly.
	 */
	readonly signal: AbortSignal;

	/**
	 * Live read-only view of session state. Backed by the host actor's cache,
	 * not by direct cross-actor reads.
	 */
	readonly session: BackgroundAgentSessionView;

	/** Convenience logger that prefixes the agent name. */
	log(msg: string): void;
}

/**
 * Lifecycle hooks for a user-defined background producer.
 *
 * Lifecycle:
 *   1. `onStart(ctx)` fires exactly ONCE — on the first `session.connected`
 *      envelope (NOT on construction; deferred until the live transport is
 *      ready, so the first publish lands on a live wire).
 *   2. `onAgentTransfer(event)` fires on every `agent.transfer_completed`.
 *   3. `onReconnect()` fires on every `session.reconnected` (after the
 *      initial `onStart`). Implement only if you need to resync external
 *      state.
 *   4. `onStop(reason)` fires on `session.close_requested` / `transport.closed`,
 *      or on `agent.transfer_completed` when `cancelOnTransfer === true`.
 *
 * Throws inside any hook are caught by the host actor and logged — a
 * misbehaving agent does not bring down the session (per the
 * `'background-agents': resume` supervision policy).
 */
export interface BackgroundAgent {
	/** Stable name; used for logging and as the publish correlationId prefix. */
	readonly name: string;

	/**
	 * If `true`, `ctx.signal` is aborted and `onStop('transfer')` is invoked
	 * when an `agent.transfer_completed` envelope is observed. Default
	 * `false` — reminder-style producers usually survive transfer; flow-
	 * specific producers opt in.
	 */
	readonly cancelOnTransfer?: boolean;

	/** Called exactly once, on the first `session.connected` envelope. */
	onStart(ctx: BackgroundAgentContext): Promise<void> | void;

	/** Called when the agent is removed, the session closes, or `cancelOnTransfer` triggers. */
	onStop?(reason: string): Promise<void> | void;

	/**
	 * Called after `agent.transfer_completed`. Invoked regardless of
	 * `cancelOnTransfer` (so the agent can observe the transition); when
	 * `cancelOnTransfer === true`, `onStop('transfer')` runs after this hook
	 * returns.
	 */
	onAgentTransfer?(event: { fromAgent: string; toAgent: string }): void;

	/**
	 * Called on every transport reconnect (after the initial `onStart`).
	 * Optional — most agents don't need it because the host preserves their
	 * state across reconnect. Implement only when you need to resync state
	 * with external systems.
	 */
	onReconnect?(): void;
}
