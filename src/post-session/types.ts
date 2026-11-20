import type { ConversationItem } from '../types/conversation.js';
import type { MemoryStore } from '../types/memory.js';
import type { SessionEndReason } from '../types/session.js';

export type { SessionEndReason, KnownSessionEndReason } from '../types/session.js';

/**
 * Top-level contracts for the post-session processing pipeline, exported from the
 * package root.
 *
 * Stability (semver, from the release that exports them):
 * - Types a host IMPLEMENTS or SUPPLIES may gain only optional members, with
 *   defaults, in a minor release: {@link PostSessionPipeline},
 *   {@link PostSessionProcessor}, {@link PostSessionSnapshotBuilder} and the
 *   {@link PostSessionSnapshot} / {@link PostSessionStores} it returns, and
 *   `PostSessionPipelineOptions`.
 * - Types a host only READS may gain members in a minor release:
 *   {@link PostSessionContext}, {@link PostSessionCapabilities},
 *   {@link PostSessionRun}, {@link PostSessionReport}, {@link PostSessionResult},
 *   {@link PostSessionEvents}, {@link PostSessionStats},
 *   {@link ConversationSnapshot} and {@link SessionMetricsSnapshot}.
 * - `PostSessionResult.status` and {@link RunOutcome} are closed sets.
 * - {@link RunFailureReason} and `PostSessionResult.detail.reason` are open: handle
 *   values you do not know.
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
	 * INTERNAL to VoiceSession's own memory fallback: hosts must not call or supply
	 * it, and it may be removed in a minor release.
	 *
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
 * IMMUTABLE per-session data, taken at close after the session's pre-close
 * finalizers. Processors MUST NOT mutate it; bodhi never does, but it is not
 * deep-frozen. This is *only* data: no live handles. It is what crosses the
 * dispatch boundary and what a future queue-backed pipeline could serialize.
 *
 * `conversation.items` is a shallow copy of the session's items. `metadata` is the
 * host's `sessionMetadata` by reference: keep it small, serializable and constant
 * after the session starts, with no credentials and no live handles.
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
	 * A closed set. `detail.reason` (an open set) says why, when bodhi decided:
	 * - `completed`: `run()` resolved; `detail` is its return value, if any.
	 * - `skipped`: `shouldRun_false` (the gate returned false) or `dependency_failed`
	 *   (a `dependsOn` prerequisite did not complete; `detail.dependency` names it),
	 *   and `run()` was not called; or `run_skipped`, when `run()` returned a
	 *   {@link postSessionSkip} value (`detail.skipReason` holds its reason).
	 * - `failed`: `shouldRun_threw`; `drain_timeout` (the run budget expired or
	 *   `drain()` cancelled the run while `run()` was pending); or no `detail`, with
	 *   `error` set, when `run()` threw or rejected.
	 *
	 * `backpressure_optional_shed` is reserved and never produced: admission
	 * decides per run, and no single processor is shed.
	 */
	readonly status: 'completed' | 'skipped' | 'failed';
	readonly durationMs: number;
	/**
	 * Set when `shouldRun()` or `run()` threw (`failed`). Always an `Error`: a thrown
	 * `Error` is kept as is; any other thrown value is wrapped in a new `Error` whose
	 * `cause` is that value, except a thrown {@link PostSessionSkip}, which is replaced
	 * by an `Error` that says so and never enters the report. A thrown value that throws
	 * while bodhi inspects it (a `Proxy` trap, or a getter on the skip brand or `reason`)
	 * is replaced by an `Error` whose message says it could not be inspected, with no
	 * `cause`, so the value never enters the report.
	 */
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
 *
 * `name`, `required` and `dependsOn` must not change after `register()`.
 * Idempotency is the processor's job: bodhi never retries a run and does not
 * persist unfinished runs across a process exit.
 */
export abstract class PostSessionProcessor {
	/** Stable identifier, unique within a pipeline; used for ordering, logging, and config. */
	abstract readonly name: string;

	/**
	 * Admission, decided per pipeline: when ANY registered processor is required,
	 * every run that finds the pipeline at capacity waits (FIFO) for a slot instead
	 * of being dropped with `queue_overflow`. The run can still be `dropped` with
	 * `required_capacity_timeout`. No single processor is ever shed. A required
	 * processor must not depend on an optional one. Default false.
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
	 * Cheap synchronous gate — skip work when not applicable (e.g. errored
	 * session). The pipeline wraps this call: if it throws, the processor is
	 * recorded `failed` (it does not abort scheduling of others).
	 */
	shouldRun(_ctx: PostSessionContext): boolean {
		return true;
	}

	/**
	 * The async unit of work. Must be self-contained and idempotent-friendly.
	 * May return a small serializable object, placed in this processor's
	 * `PostSessionResult.detail`. Returning a value is for reporting ONLY — it is
	 * never passed to dependent processors (cross-step data flows via `ctx.stores`).
	 *
	 * To end the work as skipped after deciding inside `run()` (an opt-out or a lookup
	 * that found nothing to do), RETURN `postSessionSkip(reason, detail?)`: the
	 * result is `skipped` with `detail.reason: 'run_skipped'`, and hard dependents
	 * skip with `dependency_failed`. Only a returned skip counts.
	 *
	 * A throw (synchronous or a rejection) records `failed` with `error`, even when
	 * the thrown value is a skip; `error` is always an `Error` (see
	 * `PostSessionResult.error`). Cancellation is cooperative: when the run budget
	 * expires or `drain()` cancels, the pipeline aborts `ctx.signal` and stops
	 * waiting, but the work may continue. `run()` may be called with `ctx.signal`
	 * already aborted, so check `signal.aborted` before side effects.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: a processor may return a small detail object, a skip or nothing.
	abstract run(ctx: PostSessionContext): Promise<Record<string, unknown> | PostSessionSkip | void>;
}

/**
 * The brand of a {@link PostSessionSkip}. `Symbol.for`, so two copies of this
 * package loaded in one process recognize each other's skips. Not exported from the
 * package root: create skips with {@link postSessionSkip}.
 */
export const POST_SESSION_SKIP: unique symbol = Symbol.for('bodhi.post-session.skip');

/**
 * A value `run()` may RETURN to end its processor's work as `skipped`. The pipeline
 * reports `detail: { ...detail, reason: 'run_skipped', skipReason: reason }`; the
 * branded value itself never enters the report. Create it with
 * {@link postSessionSkip}: the brand keeps a plain `{ reason }` object from passing
 * as a skip.
 */
export interface PostSessionSkip {
	readonly [POST_SESSION_SKIP]: true;
	/**
	 * Why the work was skipped. Free text that bodhi never interprets or truncates;
	 * keep it short, with no credentials or personal data (it is logged like `detail`).
	 */
	readonly reason: string;
	/**
	 * Optional small, serializable detail, copied into the result's `detail`. bodhi's
	 * `reason` and `skipReason` keys override host keys of the same name.
	 */
	readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Create a {@link PostSessionSkip} for `run()` to return. The value is frozen, and
 * `detail` is copied (shallow, own enumerable keys) and frozen now, so a later change
 * to the object passed in cannot change the report. `detail` follows the rule for
 * `PostSessionResult.detail` (small, plain, serializable); bodhi checks only that it is
 * a plain object, not what it holds.
 *
 * @throws TypeError when `reason` is not a non-empty string, or `detail` is given
 *   and is not a plain object (its prototype must be `Object.prototype` or `null`, so
 *   an array, a `Date`, a `Map` or a class instance throws). Inside `run()` that
 *   records `failed`.
 */
export function postSessionSkip(reason: string, detail?: Record<string, unknown>): PostSessionSkip {
	if (typeof reason !== 'string' || reason.length === 0) {
		throw new TypeError('postSessionSkip: reason must be a non-empty string');
	}
	if (detail === undefined) return Object.freeze({ [POST_SESSION_SKIP]: true as const, reason });
	if (!isPlainObject(detail)) {
		throw new TypeError('postSessionSkip: detail must be a plain object when given');
	}
	return Object.freeze({
		[POST_SESSION_SKIP]: true as const,
		reason,
		detail: Object.freeze({ ...detail }),
	});
}

/** An object whose prototype is `Object.prototype` or `null`: not an array, `Date`, `Map` or class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * True when `value` is a {@link PostSessionSkip}: it carries the brand and a string
 * `reason`. For hosts that implement {@link PostSessionPipeline} themselves.
 *
 * Never throws. The check reads the brand and `reason`, and a `Proxy` trap or a getter
 * can throw from either read; a value whose inspection throws is not a skip, so the
 * answer is `false`.
 */
export function isPostSessionSkip(value: unknown): value is PostSessionSkip {
	try {
		return isPostSessionSkipUnguarded(value);
	} catch {
		return false;
	}
}

/**
 * {@link isPostSessionSkip} without its guard: a throw from a `Proxy` trap or a getter
 * reaches the caller. Not exported from the package root. The pipeline uses it on a
 * thrown value, where "could not be inspected" and "not a skip" are reported differently.
 */
export function isPostSessionSkipUnguarded(value: unknown): value is PostSessionSkip {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { readonly [POST_SESSION_SKIP]?: unknown })[POST_SESSION_SKIP] === true &&
		typeof (value as { readonly reason?: unknown }).reason === 'string'
	);
}

/**
 * Disposition of a whole run (distinct from a per-processor status):
 * - `accepted`        — admitted; `results` reflect the processors that ran.
 * - `dropped`         — admission rejected (no capacity, no required processor).
 * - `failed_to_start` — the `build` thunk threw; the snapshot never existed.
 */
export type RunOutcome = 'accepted' | 'dropped' | 'failed_to_start';

/**
 * Run-level cause when `outcome !== 'accepted'`. Open: a later release may add
 * reasons, so handle values you do not know. `(string & {})` keeps the known
 * literals for narrowing and completion.
 */
export type RunFailureReason =
	| 'queue_overflow'
	| 'required_capacity_timeout'
	| 'snapshot_failed'
	| (string & {});

/** Handle returned by dispatch — lets callers observe a run without blocking. */
export interface PostSessionRun {
	readonly sessionId: string;
	/**
	 * The admission decision at dispatch time. A required run that waits for a
	 * slot is `accepted` here even when its report ends `dropped`
	 * (`required_capacity_timeout`); `report.outcome` is the final disposition.
	 */
	readonly outcome: RunOutcome;
	/**
	 * Resolves with the report; never rejects, never hangs — even `dropped` and
	 * `failed_to_start` resolve with a report carrying that outcome. For the
	 * in-memory pipeline it settles within `requiredWaitMs` + `runBudgetMs`.
	 */
	readonly report: Promise<PostSessionReport>;
}

/**
 * The single process-scoped completion channel (outlives the per-session
 * EventBus). There is one completion mechanism: `onProcessed`.
 */
export interface PostSessionEvents {
	/**
	 * Fires exactly once per dispatch, for every outcome. Returns an unsubscribe.
	 * Listener exceptions go to the pipeline's `onError` — they cannot reject
	 * `run.report` or block other listeners.
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
	 * depending on an optional one) and freeze the registry. Idempotent. Call it at
	 * startup, before any session can close: `dispatch()` throws before `freeze()`,
	 * which rejects a VoiceSession's `close()`. After freeze, `dispatch()` never throws.
	 */
	freeze(): void;

	/**
	 * Run all applicable processors for one ended session. Returns a handle
	 * synchronously. The pipeline is the SOLE report emitter: it invokes the
	 * `build` thunk itself (a build throw → `failed_to_start`), assembles the
	 * `PostSessionContext`, and runs the processors. A session calls it once per
	 * close; a host may also call it directly under the same contract.
	 */
	dispatch(input: PostSessionDispatchInput): PostSessionRun;

	/**
	 * Await all outstanding runs (e.g. on graceful process shutdown).
	 * `cancelOnTimeout` (default true): on deadline, abort each unfinished run's
	 * `signal`; timed-out processors appear as `failed` (`detail.reason: drain_timeout`),
	 * their waiting dependents as `skipped` (`dependency_failed`), and runs still
	 * waiting for a slot as `dropped` (`required_capacity_timeout`).
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
