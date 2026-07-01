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
	/** Optional error sink for build/listener failures (defaults to console.error). */
	onError?: (error: unknown, where: string) => void;
}

/** Internal sentinel for the deadline branch of a processor race. */
const TIMED_OUT: unique symbol = Symbol('post-session-timed-out');

type RegistryState = 0 | 1 | 2; // unvisited | visiting | done

/**
 * Single-process, in-memory implementation of {@link PostSessionPipeline}.
 *
 * - Snapshot building happens INSIDE `dispatch` (a throw → `failed_to_start`), so
 *   the pipeline is the sole report emitter.
 * - Processors run concurrently, respecting `dependsOn` (a dependency-aware
 *   scheduler, not a serial loop), each isolated.
 * - A run-level wall-clock budget guarantees `run.report` resolves even if a
 *   processor ignores cancellation (cooperative; see the design's budget caveat).
 */
export class InMemoryPostSessionPipeline implements PostSessionPipeline {
	private readonly processors: PostSessionProcessor[] = [];
	private ordered: PostSessionProcessor[] = [];
	private frozen = false;
	private readonly hasRequired = (): boolean => this.processors.some((p) => p.required);

	private running = 0;
	/** Required runs waiting for a slot at capacity (FIFO). */
	private readonly waiters: Array<() => void> = [];
	private readonly counters = { dropped: 0, completed: 0, failed: 0 };
	private readonly listeners = new Set<(r: PostSessionReport) => void>();
	private readonly inFlight = new Set<{
		report: Promise<PostSessionReport>;
		controller: AbortController;
	}>();

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
		this.ordered = topoSort(this.processors, byName);
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
			this.onError(error, `snapshot build for ${sessionId}`);
			return this.terminalRun(sessionId, 'failed_to_start', 'snapshot_failed', () => {
				this.counters.failed++;
			});
		}

		// (b) admission.
		if (this.running < this.maxConcurrentRuns) {
			// Slot available → run immediately.
			this.running++;
			return { sessionId, outcome: 'accepted', report: this.runReserved(built) };
		}
		if (!this.hasRequired()) {
			// At capacity, optional-only → drop.
			return this.terminalRun(sessionId, 'dropped', 'queue_overflow', () => {
				this.counters.dropped++;
			});
		}
		// At capacity, has a required processor → bounded-wait for a slot. Reported
		// `accepted` (admitted to the wait queue); if the wait budget expires before
		// a slot frees, `report` resolves `dropped` / `required_capacity_timeout`.
		const report = (async (): Promise<PostSessionReport> => {
			const acquired = await this.reserveOrWait(this.requiredWaitMs);
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
		return { sessionId, outcome: 'accepted', report };
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
		const entry = { report: Promise.resolve<PostSessionReport>(undefined as never), controller };
		entry.report = this.execute(ctx, controller).finally(() => {
			this.inFlight.delete(entry);
			this.releaseSlot();
		});
		this.inFlight.add(entry);
		return entry.report;
	}

	/** Reserve a slot now, or wait up to `timeoutMs` for one. Resolves false on timeout. */
	private reserveOrWait(timeoutMs: number): Promise<boolean> {
		if (this.running < this.maxConcurrentRuns) {
			this.running++;
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			const waiter = () => {
				clearTimeout(timer);
				this.running++; // take the slot handed off by releaseSlot()
				resolve(true);
			};
			const timer = setTimeout(() => {
				const i = this.waiters.indexOf(waiter);
				if (i >= 0) this.waiters.splice(i, 1);
				resolve(false);
			}, timeoutMs);
			this.waiters.push(waiter);
		});
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
		const entries = [...this.inFlight];
		const reports = entries.map((e) => e.report);
		if (timeoutMs == null) return Promise.all(reports);
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (cancelOnTimeout) {
			timer = setTimeout(() => {
				for (const e of entries) e.controller.abort();
			}, timeoutMs);
		}
		try {
			// Every run resolves its report even when aborted (budget/abort → drain_timeout),
			// so awaiting all is bounded once the timer has fired.
			return await Promise.all(reports);
		} finally {
			if (timer) clearTimeout(timer);
		}
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
				this.onError(error, 'onProcessed listener');
			}
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
					error: error as Error,
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
				p
					.run(ctx)
					.then((detail) => ({ ok: true as const, detail: detail ?? undefined }))
					.catch((error) => ({ ok: false as const, error: error as Error })),
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
				return {
					processor: p.name,
					status: 'completed',
					durationMs: Date.now() - t0,
					detail: settled.detail,
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

/** Stable topological order; registration order is the tie-break. */
function topoSort(
	processors: PostSessionProcessor[],
	byName: Map<string, PostSessionProcessor>,
): PostSessionProcessor[] {
	const out: PostSessionProcessor[] = [];
	const state = new Map<string, RegistryState>();
	const visit = (p: PostSessionProcessor): void => {
		const s = state.get(p.name);
		if (s === 2) return;
		if (s === 1) throw new Error(`post-session dependency cycle at "${p.name}"`);
		state.set(p.name, 1);
		for (const dep of p.dependsOn) {
			const target = byName.get(dep);
			if (target) visit(target);
		}
		state.set(p.name, 2);
		out.push(p);
	};
	for (const p of processors) visit(p);
	return out;
}
