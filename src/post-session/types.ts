// SPDX-License-Identifier: MIT

import type { ConversationItem } from '../types/conversation.js';
import type { MemoryStore } from '../types/memory.js';
import type { SessionEndReason } from '../types/session.js';

export type { SessionEndReason, KnownSessionEndReason } from '../types/session.js';

/**
 * Top-level contracts for the post-session processing pipeline.
 * See `dev_docs/framework/design-post-session-processor.md`.
 *
 * `ConversationSnapshot`, `SessionMetricsSnapshot`, and `PostSessionStores` are
 * intentionally minimal in v1 — they grow as concrete processors land.
 */

/** Finalized, read-only view of the conversation, frozen at close. */
export interface ConversationSnapshot {
	/** The conversation timeline (messages / tool calls / transfers), in order. */
	readonly items: readonly ConversationItem[];
}

/** Aggregated, read-only per-session metrics, frozen at close. */
export interface SessionMetricsSnapshot {
	readonly turnCount: number;
	readonly toolCallCount: number;
	readonly agentTransferCount: number;
}

/**
 * Durable, process-scoped capabilities processors may write through. Each member
 * is optional so a deployment only wires what its processors need. MUST stay
 * valid until `run.report` settles — do NOT expose session-disposed resources.
 */
export interface PostSessionStores {
	/** Per-user durable memory facts (e.g. for memory distillation). */
	readonly memory?: MemoryStore;
	/**
	 * Per-session memory-extraction capability, provided by the snapshot builder.
	 * v1 bridge: closes over the session's distiller so the process-scoped
	 * MemoryDistillationProcessor stays reentrant (it holds no session state; the
	 * capability arrives via ctx). A future stateless service will consume
	 * `conversation` + `memory` + a model directly and this can retire.
	 */
	readonly memoryExtraction?: () => Promise<void>;
	/** Optional sink for the AnalyticsProcessor's per-session summary (metrics, reason). */
	readonly analyticsSink?: (summary: Record<string, unknown>) => void | Promise<void>;
}

/**
 * IMMUTABLE per-session data — frozen at close. Processors MUST NOT mutate it.
 * This is *only* data: no live handles. It is what crosses the dispatch boundary
 * and what a future queue-backed pipeline could serialize.
 */
export interface PostSessionSnapshot {
	readonly sessionId: string;
	readonly userId: string;

	/** Agent the session opened with. */
	readonly initialAgentName: string;
	/** Agent active at close (differs after a transfer). */
	readonly finalAgentName: string;
	/** Ordered agent names the session passed through (transfers). */
	readonly transferPath: readonly string[];

	/** Caller-supplied close reason, preserved end-to-end. */
	readonly reason: SessionEndReason;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly durationMs: number;

	/** App correlation metadata (mirrors VoiceSessionConfig.sessionMetadata). */
	readonly metadata?: Readonly<Record<string, unknown>>;

	/** Finalized conversation view. Read-only. */
	readonly conversation: ConversationSnapshot;
	/** Aggregated per-session metrics. Read-only. */
	readonly metrics: SessionMetricsSnapshot;
}

/**
 * LIVE capabilities — never snapshot data. The snapshot builder supplies
 * `stores`; the pipeline supplies `signal` (it owns the AbortController, hence
 * owns the wall-clock budget). Kept separate so immutability is unambiguous.
 */
export interface PostSessionCapabilities {
	/** Durable stores processors may write to. */
	readonly stores: PostSessionStores;
	/** Cooperative cancellation — pipeline aborts on budget/drain timeout. */
	readonly signal: AbortSignal;
}

/** What each processor's `run()` receives: immutable data + live capabilities. */
export type PostSessionContext = PostSessionSnapshot & PostSessionCapabilities;

/**
 * Builds the per-session snapshot + live stores. A session creates one (closing
 * over its own state) and hands it to its close path; `closeWithReason` passes it
 * to `dispatch`, which invokes it once. Must be bounded in-memory work
 * (copy/freeze close-time data, no network or disk I/O); a throw → `failed_to_start`.
 */
export type PostSessionSnapshotBuilder = (reason: SessionEndReason) => {
	snapshot: PostSessionSnapshot;
	stores: PostSessionStores;
};

/** Outcome reported by a single processor (within an `accepted` run). */
export interface PostSessionResult {
	readonly processor: string;
	/**
	 * `skipped` covers `shouldRun()===false`, dependency-failed, and optional
	 * backpressure shedding — disambiguate via `detail.reason`
	 * (`dependency_failed` | `backpressure_optional_shed`). `failed` includes
	 * `run()`/`shouldRun()` throws and `drain_timeout`.
	 */
	readonly status: 'completed' | 'skipped' | 'failed';
	readonly durationMs: number;
	readonly error?: Error;
	/** Optional small, serializable summary / cause for logging/analytics. */
	readonly detail?: Record<string, unknown>;
}

/**
 * Abstract contract for one unit of post-session work.
 *
 * **Reentrancy:** a single processor INSTANCE is long-lived and may run for
 * several ended sessions concurrently. Implementations MUST be stateless /
 * reentrant — keep all per-session state in locals or in `ctx`, never on the
 * instance.
 */
export abstract class PostSessionProcessor {
	/** Stable identifier used for ordering, logging, and config. */
	abstract readonly name: string;

	/**
	 * If true, this processor is never *individually* shed under backpressure, and
	 * its run bounded-waits for admission instead of being dropped outright. The
	 * run can still fail as `required_capacity_timeout`. Default false.
	 */
	readonly required: boolean = false;

	/**
	 * Declared dependencies (processor names) that must run (successfully) before
	 * this one. Side-effect ordering only — a dependent does NOT receive its
	 * prerequisites' return values; cross-step data flows through `ctx.stores`.
	 * If a hard dependency ends `failed` or `skipped`, the dependent is itself
	 * marked `skipped` (`detail.reason: dependency_failed`) and `run()` is not called.
	 */
	readonly dependsOn: readonly string[] = [];

	/**
	 * Cheap gate — skip work when not applicable (e.g. errored session). The
	 * pipeline wraps this call: if it throws, the processor is recorded `failed`
	 * (it does not abort scheduling of others).
	 */
	shouldRun(_ctx: PostSessionContext): boolean {
		return true;
	}

	/**
	 * The async unit of work. Must be self-contained and idempotent-friendly.
	 * May return a small serializable object, placed in this processor's
	 * `PostSessionResult.detail`. Returning a value is for reporting ONLY — it is
	 * never passed to dependent processors (cross-step data flows via `ctx.stores`).
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: a processor may return a small detail object or nothing.
	abstract run(ctx: PostSessionContext): Promise<Record<string, unknown> | void>;
}

/**
 * Disposition of a whole run (distinct from a per-processor status):
 * - `accepted`        — admitted; `results` reflect the processors that ran.
 * - `dropped`         — admission rejected (no capacity, no required processor).
 * - `failed_to_start` — the `build` thunk threw; the snapshot never existed.
 */
export type RunOutcome = 'accepted' | 'dropped' | 'failed_to_start';

/** Run-level cause when `outcome !== 'accepted'`. */
export type RunFailureReason = 'queue_overflow' | 'required_capacity_timeout' | 'snapshot_failed';

/** Handle returned by dispatch — lets callers observe a run without blocking. */
export interface PostSessionRun {
	readonly sessionId: string;
	readonly outcome: RunOutcome;
	/**
	 * Resolves with the report; never rejects, never hangs — even `dropped` and
	 * `failed_to_start` resolve with a report carrying that outcome.
	 */
	readonly report: Promise<PostSessionReport>;
}

/**
 * The single process-scoped completion channel (outlives the per-session
 * EventBus). There is one completion mechanism: `onProcessed`.
 */
export interface PostSessionEvents {
	/**
	 * Fires once per finished run (any outcome). Returns an unsubscribe. Listener
	 * exceptions are caught/logged — they cannot reject `run.report` or block
	 * other listeners.
	 */
	onProcessed(listener: (report: PostSessionReport) => void): () => void;
}

/** Input to {@link PostSessionPipeline.dispatch}. */
export interface PostSessionDispatchInput {
	readonly sessionId: string;
	readonly reason: SessionEndReason;
	readonly build: PostSessionSnapshotBuilder;
}

/** Health snapshot for observability. */
export interface PostSessionStats {
	readonly queued: number;
	readonly running: number;
	readonly dropped: number;
	readonly completed: number;
	readonly failed: number;
}

/**
 * Orchestrates registered processors. Process-scoped and long-lived: processors
 * are registered once at startup, then dispatched once per ended session.
 */
export interface PostSessionPipeline {
	/** Register a processor. Names must be unique. Allowed only before `freeze()`. */
	register(processor: PostSessionProcessor): void;

	/**
	 * Validate (unique names, no missing deps, no cycles, no `required` processor
	 * depending on an optional one) and freeze the registry. Called ONCE at
	 * startup, before any session can close. After freeze, `dispatch()` never throws.
	 */
	freeze(): void;

	/**
	 * Run all applicable processors for one ended session. Returns a handle
	 * synchronously. The pipeline is the SOLE report emitter: it invokes the
	 * `build` thunk itself (a build throw → `failed_to_start`), assembles the
	 * `PostSessionContext`, and runs the processors.
	 */
	dispatch(input: PostSessionDispatchInput): PostSessionRun;

	/**
	 * Await all outstanding runs (e.g. on graceful process shutdown).
	 * `cancelOnTimeout` (default true): on deadline, abort each unfinished run's
	 * `signal`; timed-out processors appear as `failed` (`detail.reason: drain_timeout`).
	 */
	drain(
		timeoutMs?: number,
		opts?: { cancelOnTimeout?: boolean },
	): Promise<readonly PostSessionReport[]>;

	/** Process-scoped completion channel. */
	readonly events: PostSessionEvents;

	/** Health snapshot for observability. */
	stats(): PostSessionStats;
}

/** Aggregate outcome for one session's post-processing. */
export interface PostSessionReport {
	readonly sessionId: string;
	readonly outcome: RunOutcome;
	/** Run-level cause when `outcome !== 'accepted'` (no processors ran). */
	readonly failureReason?: RunFailureReason;
	/** Empty for `dropped` / `failed_to_start`. */
	readonly results: readonly PostSessionResult[];
	readonly totalDurationMs: number;
}
