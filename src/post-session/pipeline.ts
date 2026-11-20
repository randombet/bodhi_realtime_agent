import type {
	PostSessionContext,
	PostSessionDispatchInput,
	PostSessionEvents,
	PostSessionPipeline,
	PostSessionProcessor,
	PostSessionReport,
	PostSessionResult,
	PostSessionRun,
	PostSessionSnapshot,
	PostSessionStats,
	PostSessionStores,
} from './types.js';
import { isPostSessionSkip, isPostSessionSkipUnguarded } from './types.js';

/** Tuning knobs for {@link InMemoryPostSessionPipeline}. */
export interface PostSessionPipelineOptions {
	/**
	 * Cap on concurrent in-flight runs. When at capacity, an optional-only run is
	 * `dropped` (`queue_overflow`); a run with a `required` processor instead
	 * bounded-waits for a slot (see `requiredWaitMs`). Default 16.
	 */
	maxConcurrentRuns?: number;
	/**
	 * How long a required run waits for a slot when at capacity before failing with
	 * `dropped` / `required_capacity_timeout` (never silent, never unbounded).
	 * Default 30_000.
	 */
	requiredWaitMs?: number;
	/**
	 * Per-run wall-clock budget (ms). On expiry the run's `signal` is aborted and
	 * any still-pending processor is recorded `failed` (`detail.reason: drain_timeout`).
	 * Default 30_000.
	 */
	runBudgetMs?: number;
	/**
	 * Optional error sink for build and `onProcessed` listener failures (defaults to
	 * console.error). A throw from the sink itself is swallowed: it cannot make
	 * `dispatch()` throw, reject `run.report` or stop later listeners.
	 */
	onError?: (error: unknown, where: string) => void;
}

/** Internal sentinel for the deadline branch of a processor race. */
const TIMED_OUT: unique symbol = Symbol('post-session-timed-out');

/**
 * Single-process, in-memory implementation of {@link PostSessionPipeline}.
 *
 * - Snapshot building happens INSIDE `dispatch` (a throw → `failed_to_start`), so
 *   the pipeline is the sole report emitter.
 * - Processors run concurrently, respecting `dependsOn` (a dependency-aware
 *   scheduler, not a serial loop), each isolated. They start, and `results` list
 *   them, in a stable topological order fixed at `freeze()`: prerequisites first and,
 *   among processors whose prerequisites are placed, the earliest registered first.
 * - A run-level wall-clock budget guarantees `run.report` resolves even if a
 *   processor ignores cancellation (cooperative; see the design's budget caveat).
 */
export class InMemoryPostSessionPipeline implements PostSessionPipeline {
	private readonly processors: PostSessionProcessor[] = [];
	private ordered: PostSessionProcessor[] = [];
	private frozen = false;
	private readonly hasRequired = (): boolean => this.processors.some((p) => p.required);

	private running = 0;
	/** Slot-handoff callbacks for required runs waiting at capacity (FIFO). */
	private readonly waiters: Array<() => void> = [];
	private readonly counters = { dropped: 0, completed: 0, failed: 0 };
	private readonly listeners = new Set<(r: PostSessionReport) => void>();
	/** Every still-pending run report (immediate AND waiting) — what drain() awaits. */
	private readonly pendingReports = new Set<Promise<PostSessionReport>>();
	/** AbortControllers of runs whose processors are executing (drain cancels these). */
	private readonly activeControllers = new Set<AbortController>();
	/** Cancel hooks for runs still waiting for a slot (drain cancels these too). */
	private readonly waitCancels = new Set<() => void>();

	private readonly maxConcurrentRuns: number;
	private readonly requiredWaitMs: number;
	private readonly runBudgetMs: number;
	private readonly onError: (error: unknown, where: string) => void;

	constructor(options: PostSessionPipelineOptions = {}) {
		this.maxConcurrentRuns = options.maxConcurrentRuns ?? 16;
		this.requiredWaitMs = options.requiredWaitMs ?? 30_000;
		this.runBudgetMs = options.runBudgetMs ?? 30_000;
		this.onError =
			options.onError ?? ((error, where) => console.error(`[post-session] ${where}:`, error));
	}

	readonly events: PostSessionEvents = {
		onProcessed: (listener) => {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		},
	};

	register(processor: PostSessionProcessor): void {
		if (this.frozen) throw new Error(`register() after freeze(): ${processor.name}`);
		this.processors.push(processor);
	}

	freeze(): void {
		if (this.frozen) return;
		const byName = new Map<string, PostSessionProcessor>();
		for (const p of this.processors) {
			if (byName.has(p.name)) throw new Error(`duplicate post-session processor name: ${p.name}`);
			byName.set(p.name, p);
		}
		for (const p of this.processors) {
			for (const dep of p.dependsOn) {
				const target = byName.get(dep);
				if (!target) {
					throw new Error(`post-session processor "${p.name}" depends on unknown "${dep}"`);
				}
				if (p.required && !target.required) {
					throw new Error(`required processor "${p.name}" must not depend on optional "${dep}"`);
				}
			}
		}
		this.ordered = topoSort(this.processors);
		this.frozen = true;
	}

	dispatch(input: PostSessionDispatchInput): PostSessionRun {
		if (!this.frozen) throw new Error('PostSessionPipeline.dispatch() called before freeze()');
		const { sessionId, reason, build } = input;

		// (a) snapshot build is inline + bounded; a throw → failed_to_start.
		let built: ReturnType<typeof build>;
		try {
			built = build(reason);
		} catch (error) {
			this.reportError(error, `snapshot build for ${sessionId}`);
			return this.terminalRun(sessionId, 'failed_to_start', 'snapshot_failed', () => {
				this.counters.failed++;
			});
		}

		// (b) admission.
		if (this.running < this.maxConcurrentRuns) {
			// Slot available → run immediately.
			this.running++;
			return { sessionId, outcome: 'accepted', report: this.track(this.runReserved(built)) };
		}
		if (!this.hasRequired()) {
			// At capacity, optional-only → drop.
			return this.terminalRun(sessionId, 'dropped', 'queue_overflow', () => {
				this.counters.dropped++;
			});
		}
		// At capacity, has a required processor → bounded-wait for a slot. Reported
		// `accepted` (admitted to the wait queue); if the wait budget expires (or drain
		// cancels the wait) before a slot frees, `report` resolves
		// `dropped` / `required_capacity_timeout`.
		const wait = this.reserveOrWait(this.requiredWaitMs);
		this.waitCancels.add(wait.cancel);
		const report = (async (): Promise<PostSessionReport> => {
			const acquired = await wait.acquired;
			this.waitCancels.delete(wait.cancel);
			if (!acquired) {
				this.counters.dropped++;
				const timedOut: PostSessionReport = {
					sessionId,
					outcome: 'dropped',
					failureReason: 'required_capacity_timeout',
					results: [],
					totalDurationMs: 0,
				};
				this.emit(timedOut);
				return timedOut;
			}
			return this.runReserved(built);
		})();
		return { sessionId, outcome: 'accepted', report: this.track(report) };
	}

	/**
	 * Add a run's report to the pending set (for drain) until it settles. The cleanup
	 * handles both outcomes: a `finally()` chain here would be a second promise that
	 * nobody awaits, and it would reject unhandled whenever the report rejects.
	 */
	private track(report: Promise<PostSessionReport>): Promise<PostSessionReport> {
		this.pendingReports.add(report);
		const forget = (): void => {
			this.pendingReports.delete(report);
		};
		report.then(forget, forget);
		return report;
	}

	/** Execute a run for which a slot is already reserved; release it on completion. */
	private runReserved(built: {
		snapshot: PostSessionSnapshot;
		stores: PostSessionStores;
	}): Promise<PostSessionReport> {
		const controller = new AbortController();
		const ctx: PostSessionContext = {
			...built.snapshot,
			stores: built.stores,
			signal: controller.signal,
		};
		this.activeControllers.add(controller);
		return this.execute(ctx, controller).finally(() => {
			this.activeControllers.delete(controller);
			this.releaseSlot();
		});
	}

	/**
	 * Reserve a slot now, or wait up to `timeoutMs` for one. Returns the acquisition
	 * promise plus a `cancel()` that forces the wait to resolve `false` early (used
	 * by drain). `acquired` resolves `true` (slot taken, `running` incremented) or
	 * `false` (timeout/cancel).
	 */
	private reserveOrWait(timeoutMs: number): { acquired: Promise<boolean>; cancel: () => void } {
		if (this.running < this.maxConcurrentRuns) {
			this.running++;
			return { acquired: Promise.resolve(true), cancel: () => {} };
		}
		let settle!: (ok: boolean) => void;
		const acquired = new Promise<boolean>((resolve) => {
			settle = resolve;
		});
		const drop = () => {
			const i = this.waiters.indexOf(waiter);
			if (i >= 0) this.waiters.splice(i, 1);
		};
		const waiter = () => {
			clearTimeout(timer);
			this.running++; // take the slot handed off by releaseSlot()
			settle(true);
		};
		const timer = setTimeout(() => {
			drop();
			settle(false); // no-op if already settled true
		}, timeoutMs);
		this.waiters.push(waiter);
		const cancel = () => {
			clearTimeout(timer);
			drop();
			settle(false); // no-op if the slot was already handed off
		};
		return { acquired, cancel };
	}

	/** Free a slot and hand it to the next waiting required run, if any. */
	private releaseSlot(): void {
		this.running--;
		const next = this.waiters.shift();
		if (next) next();
	}

	async drain(
		timeoutMs?: number,
		opts?: { cancelOnTimeout?: boolean },
	): Promise<readonly PostSessionReport[]> {
		const cancelOnTimeout = opts?.cancelOnTimeout ?? true;
		// Snapshot ALL outstanding runs — both executing and still-waiting for a slot.
		const reports = [...this.pendingReports];

		if (timeoutMs == null) return Promise.all(reports);

		if (cancelOnTimeout) {
			// On the deadline, cancel everything (abort executing runs; cancel waits) so
			// every report resolves (→ drain_timeout / required_capacity_timeout), then
			// await them all.
			const timer = setTimeout(() => {
				for (const c of this.activeControllers) c.abort();
				for (const cancel of [...this.waitCancels]) cancel();
			}, timeoutMs);
			try {
				return await Promise.all(reports);
			} finally {
				clearTimeout(timer);
			}
		}

		// cancelOnTimeout === false: wait only until the deadline, leave unfinished work
		// running, and return the reports that settled in time (partial).
		const settled: PostSessionReport[] = [];
		const tracked = reports.map((p) => p.then((r) => settled.push(r)));
		const timedOut = Symbol('drain-timeout');
		const deadline = new Promise<typeof timedOut>((resolve) =>
			setTimeout(() => resolve(timedOut), timeoutMs),
		);
		await Promise.race([Promise.all(tracked), deadline]);
		return [...settled];
	}

	stats(): PostSessionStats {
		return { queued: this.waiters.length, running: this.running, ...this.counters };
	}

	// ── internals ────────────────────────────────────────────────────────────

	private terminalRun(
		sessionId: string,
		outcome: 'dropped' | 'failed_to_start',
		failureReason: 'queue_overflow' | 'snapshot_failed',
		tally: () => void,
	): PostSessionRun {
		tally();
		const report: PostSessionReport = {
			sessionId,
			outcome,
			failureReason,
			results: [],
			totalDurationMs: 0,
		};
		this.emit(report);
		return { sessionId, outcome, report: Promise.resolve(report) };
	}

	private emit(report: PostSessionReport): void {
		for (const listener of this.listeners) {
			try {
				listener(report);
			} catch (error) {
				this.reportError(error, 'onProcessed listener');
			}
		}
	}

	/** Hand an error to the host's sink; a sink that throws cannot break dispatch or a report. */
	private reportError(error: unknown, where: string): void {
		try {
			this.onError(error, where);
		} catch {
			// The sink is the last resort: there is nowhere left to report its own failure.
		}
	}

	/** Run all processors concurrently, respecting dependsOn, each isolated. */
	private async execute(
		ctx: PostSessionContext,
		controller: AbortController,
	): Promise<PostSessionReport> {
		const start = Date.now();
		const results: PostSessionResult[] = [];

		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
			const onAbort = () => resolve(TIMED_OUT);
			controller.signal.addEventListener('abort', onAbort, { once: true });
			deadlineTimer = setTimeout(() => controller.abort(), this.runBudgetMs);
		});

		const promiseByName = new Map<string, Promise<PostSessionResult>>();
		const runProc = async (p: PostSessionProcessor): Promise<PostSessionResult> => {
			const deps = await Promise.all(
				p.dependsOn.map((d) => promiseByName.get(d) as Promise<PostSessionResult>),
			);
			const t0 = Date.now();
			const failedDep = deps.find((r) => r.status !== 'completed');
			if (failedDep) {
				return {
					processor: p.name,
					status: 'skipped',
					durationMs: 0,
					detail: { reason: 'dependency_failed', dependency: failedDep.processor },
				};
			}
			let gate: boolean;
			try {
				gate = p.shouldRun(ctx);
			} catch (error) {
				return {
					processor: p.name,
					status: 'failed',
					durationMs: Date.now() - t0,
					error: toError(error, 'shouldRun()'),
					detail: { reason: 'shouldRun_threw' },
				};
			}
			if (!gate) {
				return {
					processor: p.name,
					status: 'skipped',
					durationMs: 0,
					detail: { reason: 'shouldRun_false' },
				};
			}
			const settled = await Promise.race([
				invokeRun(p, ctx)
					.then((detail) => ({ ok: true as const, detail: detail ?? undefined }))
					.catch((error: unknown) => ({ ok: false as const, error: toError(error, 'run()') })),
				deadline,
			]);
			if (settled === TIMED_OUT) {
				return {
					processor: p.name,
					status: 'failed',
					durationMs: Date.now() - t0,
					detail: { reason: 'drain_timeout' },
				};
			}
			if (settled.ok) {
				const value = settled.detail;
				if (isPostSessionSkip(value)) {
					// A returned skip: report plain data, never the branded value.
					return {
						processor: p.name,
						status: 'skipped',
						durationMs: Date.now() - t0,
						detail: { ...value.detail, reason: 'run_skipped', skipReason: value.reason },
					};
				}
				return {
					processor: p.name,
					status: 'completed',
					durationMs: Date.now() - t0,
					detail: value,
				};
			}
			return {
				processor: p.name,
				status: 'failed',
				durationMs: Date.now() - t0,
				error: settled.error,
			};
		};

		// Kick off every processor; each awaits its deps internally (topo order
		// guarantees a dep's promise exists before its dependent reads it).
		for (const p of this.ordered) {
			promiseByName.set(p.name, runProc(p));
		}
		for (const p of this.ordered) {
			results.push(await (promiseByName.get(p.name) as Promise<PostSessionResult>));
		}

		if (deadlineTimer) clearTimeout(deadlineTimer);
		for (const r of results) {
			if (r.status === 'failed') this.counters.failed++;
			else this.counters.completed++;
		}
		const report: PostSessionReport = {
			sessionId: ctx.sessionId,
			outcome: 'accepted',
			results,
			totalDurationMs: Date.now() - start,
		};
		this.emit(report);
		return report;
	}
}

/**
 * Call `run()` so that a synchronous throw becomes a rejection and a non-promise return
 * becomes a resolved value. A native promise is returned as is, so an async processor
 * settles on exactly the ticks it always has.
 */
function invokeRun(
	p: PostSessionProcessor,
	ctx: PostSessionContext,
): ReturnType<PostSessionProcessor['run']> {
	try {
		return Promise.resolve(p.run(ctx));
	} catch (error) {
		return Promise.reject(error);
	}
}

/**
 * What a processor threw, as the `Error` that `PostSessionResult.error` promises. An
 * `Error` is kept as is. A `PostSessionSkip` is replaced by a new `Error` that says
 * a skip was thrown: the branded value never enters a report. Any other value is wrapped
 * in a new `Error` whose `cause` is that value. A value is never converted to a string
 * (no `toString()`), so a null-prototype object cannot throw here.
 *
 * Never throws: it runs inside the processor's catch handler, so a throw here would
 * reject `run.report`. Sorting the value inspects it (`instanceof` asks a `Proxy` for
 * its prototype; the skip check reads the brand and `reason`), and a hostile value can
 * throw from any of those reads. Then the result is a new `Error` that says the value
 * could not be inspected, with no `cause`: a reference to the value would hand its
 * throwing traps or getters to every host that logs the error.
 */
function toError(thrown: unknown, where: string): Error {
	try {
		if (thrown instanceof Error) return thrown;
		if (isPostSessionSkipUnguarded(thrown)) {
			return new Error(
				`${where} threw a postSessionSkip() value (skip reason: ${JSON.stringify(thrown.reason)}); only a skip that run() returns reports skipped`,
			);
		}
	} catch {
		return new Error(`${where} threw a value that could not be inspected`);
	}
	// describeThrown() uses only `typeof` on an object, and `new Error()` reads nothing
	// of its cause, so this line cannot throw.
	return new Error(`${where} threw a non-Error value: ${describeThrown(thrown)}`, {
		cause: thrown,
	});
}

/** A short description of a thrown non-Error value, without converting an object to a string. */
function describeThrown(value: unknown): string {
	if (typeof value === 'string') return JSON.stringify(value);
	if (value === null) return 'null';
	if (typeof value === 'object' || typeof value === 'function') return `(${typeof value})`;
	return String(value); // number, bigint, boolean, undefined, symbol
}

/**
 * Stable topological order (Kahn's algorithm keyed by registration index): every
 * processor comes after its `dependsOn` prerequisites, and among the processors whose
 * prerequisites are all placed, the earliest registered goes next. So registration
 * order breaks every tie, and the order of names inside `dependsOn` never matters.
 * `freeze()` has already rejected duplicate names and unknown dependencies.
 *
 * @throws Error `post-session dependency cycle at "<name>"`, naming a processor on a cycle.
 */
function topoSort(processors: readonly PostSessionProcessor[]): PostSessionProcessor[] {
	const indexOf = new Map<string, number>();
	processors.forEach((p, i) => indexOf.set(p.name, i));
	// Unplaced prerequisites per processor, counted per `dependsOn` entry (a name listed
	// twice is counted, and released, twice), and each processor's dependents.
	const unplaced = processors.map((p) => p.dependsOn.length);
	const dependents = processors.map((): number[] => []);
	processors.forEach((p, i) => {
		for (const dep of p.dependsOn) dependents[indexOf.get(dep) ?? -1]?.push(i);
	});

	// Registration indices whose prerequisites are all placed, kept ascending.
	const ready: number[] = [];
	unplaced.forEach((n, i) => {
		if (n === 0) ready.push(i);
	});
	const out: PostSessionProcessor[] = [];
	const placed = new Set<number>();
	for (let next = ready.shift(); next !== undefined; next = ready.shift()) {
		out.push(processors[next]);
		placed.add(next);
		for (const d of dependents[next]) {
			unplaced[d]--;
			if (unplaced[d] === 0) insertAscending(ready, d);
		}
	}
	if (out.length < processors.length) {
		throw new Error(
			`post-session dependency cycle at "${cycleMember(processors, indexOf, placed)}"`,
		);
	}
	return out;
}

/** Insert `value` into the ascending array `sorted`, keeping it ascending. */
function insertAscending(sorted: number[], value: number): void {
	let at = sorted.findIndex((v) => v > value);
	if (at < 0) at = sorted.length;
	sorted.splice(at, 0, value);
}

/**
 * The name of a processor on a dependency cycle, given what Kahn's algorithm could not
 * place. Every unplaced processor has an unplaced prerequisite, so walking from the
 * earliest-registered unplaced one along its first unplaced prerequisite must revisit a
 * processor; the first one revisited is on a cycle.
 */
function cycleMember(
	processors: readonly PostSessionProcessor[],
	indexOf: ReadonlyMap<string, number>,
	placed: ReadonlySet<number>,
): string {
	const seen = new Set<number>();
	let at = processors.findIndex((_, i) => !placed.has(i));
	while (!seen.has(at)) {
		seen.add(at);
		const deps = processors[at]?.dependsOn ?? [];
		at = deps.map((d) => indexOf.get(d) ?? -1).find((i) => i >= 0 && !placed.has(i)) ?? -1;
	}
	return processors[at]?.name ?? '';
}
