import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPostSessionPipeline } from '../../src/post-session/pipeline.js';
import type {
	PostSessionContext,
	PostSessionReport,
	PostSessionRun,
	PostSessionSkip,
	PostSessionSnapshot,
	PostSessionSnapshotBuilder,
	PostSessionStores,
} from '../../src/post-session/types.js';
import {
	PostSessionProcessor,
	isPostSessionSkip,
	postSessionSkip,
} from '../../src/post-session/types.js';

function makeBuilder(
	sessionId: string,
	opts?: { throwOnBuild?: boolean; out?: { stores?: PostSessionStores } },
): PostSessionSnapshotBuilder {
	return (reason) => {
		if (opts?.throwOnBuild) throw new Error('snapshot build failed');
		const snapshot: PostSessionSnapshot = {
			sessionId,
			userId: `user-${sessionId}`,
			initialAgentName: 'a',
			finalAgentName: 'a',
			transferPath: ['a'],
			reason,
			startedAt: 0,
			endedAt: 1000,
			durationMs: 1000,
			conversation: { items: [] },
			metrics: { turnCount: 1, toolCallCount: 0, agentTransferCount: 0 },
		};
		const stores: PostSessionStores = {};
		if (opts?.out) opts.out.stores = stores;
		return { snapshot, stores };
	};
}

/** Mirrors PostSessionProcessor.run: a detail object, a skip or nothing. */
type ProcRun = (ctx: PostSessionContext) => ReturnType<PostSessionProcessor['run']>;

/** Test processor with inline behavior. */
class TestProcessor extends PostSessionProcessor {
	constructor(
		readonly name: string,
		private readonly fn: ProcRun,
		readonly dependsOn: readonly string[] = [],
		readonly required = false,
		private readonly gate: (ctx: PostSessionContext) => boolean = () => true,
	) {
		super();
	}
	override shouldRun(ctx: PostSessionContext): boolean {
		return this.gate(ctx);
	}
	run(ctx: PostSessionContext): ReturnType<ProcRun> {
		return this.fn(ctx);
	}
}

const result = (report: PostSessionReport | undefined, name: string) =>
	report?.results.find((r) => r.processor === name);

const SKIP_BRAND = Symbol.for('bodhi.post-session.skip');

/** Every object reachable through own properties, enumerable or not (e.g. Error.cause). */
function reachableFrom(root: unknown): Set<unknown> {
	const seen = new Set<unknown>();
	const walk = (value: unknown): void => {
		if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
		if (seen.has(value)) return;
		seen.add(value);
		for (const key of Reflect.ownKeys(value)) {
			const desc = Object.getOwnPropertyDescriptor(value, key);
			if (desc && 'value' in desc) walk(desc.value);
		}
	};
	walk(root);
	return seen;
}

/** Every own property key of every object reachable from `root`. */
function reachableKeys(root: unknown): PropertyKey[] {
	return [...reachableFrom(root)].flatMap((o) => Reflect.ownKeys(o as object));
}

/** Test processor with soft prerequisites (`after`) and the other members of TestProcessor. */
class SoftProcessor extends TestProcessor {
	override readonly after: readonly string[];
	override readonly afterWaitMs: number | undefined;
	constructor(
		name: string,
		fn: ProcRun,
		soft: {
			after: readonly string[];
			afterWaitMs?: number;
			dependsOn?: readonly string[];
			required?: boolean;
			gate?: (ctx: PostSessionContext) => boolean;
		},
	) {
		super(name, fn, soft.dependsOn ?? [], soft.required ?? false, soft.gate);
		this.after = soft.after;
		this.afterWaitMs = soft.afterWaitMs;
	}
}

/** Watch a run's report without awaiting it (for fake-timer tests). */
function watch(run: PostSessionRun): { report?: PostSessionReport } {
	const seen: { report?: PostSessionReport } = {};
	void run.report.then((r) => {
		seen.report = r;
	});
	return seen;
}

type MakeProcessor = (
	name: string,
	fn: ProcRun,
	dependsOn: readonly string[],
	gate: (ctx: PostSessionContext) => boolean,
) => PostSessionProcessor;

const plainProcessor: MakeProcessor = (name, fn, dependsOn, gate) =>
	new TestProcessor(name, fn, dependsOn, false, gate);

/**
 * Microtask trace of a fixed six-processor pipeline: completed, a hard dependent, a
 * non-promise return, a gate that says no, a throw and a dependent of the throw.
 */
async function tickTrace(
	make: MakeProcessor,
): Promise<{ trace: string[]; report: PostSessionReport }> {
	const trace: string[] = [];
	const gate =
		(name: string, open = true) =>
		() => {
			trace.push(`${name}:gate`);
			return open;
		};
	const p = new InMemoryPostSessionPipeline();
	p.register(
		make(
			'a',
			async () => {
				trace.push('a:run');
				await Promise.resolve();
				trace.push('a:end');
				return { a: 1 };
			},
			[],
			gate('a'),
		),
	);
	p.register(
		make(
			'b',
			async () => {
				trace.push('b:run');
			},
			['a'],
			gate('b'),
		),
	);
	p.register(
		make(
			'c',
			() => {
				trace.push('c:run');
				return Promise.resolve({ c: 1 });
			},
			[],
			gate('c'),
		),
	);
	p.register(make('d', async () => ({}), ['c'], gate('d', false)));
	p.register(
		make(
			'e',
			async () => {
				throw new Error('e');
			},
			[],
			gate('e'),
		),
	);
	p.register(make('f', async () => ({}), ['e'], gate('f')));
	p.events.onProcessed(() => trace.push('emitted'));
	p.freeze();
	const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
	trace.push('dispatched');
	void (async () => {
		for (let i = 0; i < 40; i++) {
			trace.push(`t${i}`);
			await null;
		}
	})();
	const report = await run.report;
	trace.push('report');
	// A copy: the ticker keeps writing to `trace` after the report resolves.
	return { trace: [...trace], report };
}

/** Recorded on the pipeline before `after` existed. */
// biome-ignore format: a packed trace reads in order
const NO_AFTER_TICK_TRACE = [
	'dispatched', 't0', 'a:gate', 'a:run', 'c:gate', 'c:run', 'e:gate', 't1', 'a:end',
	't2', 't3', 't4', 't5', 't6', 'd:gate', 't7', 'b:gate', 'b:run', 't8', 't9', 't10',
	't11', 't12', 't13', 't14', 't15', 't16', 'emitted', 't17', 't18', 't19', 't20',
	'report',
];

describe('InMemoryPostSessionPipeline', () => {
	describe('freeze() validation', () => {
		it('rejects duplicate names', () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('dup', async () => {}));
			p.register(new TestProcessor('dup', async () => {}));
			expect(() => p.freeze()).toThrow(/duplicate/);
		});

		it('rejects missing dependencies', () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('a', async () => {}, ['ghost']));
			expect(() => p.freeze()).toThrow(/unknown/);
		});

		it('rejects dependency cycles', () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('a', async () => {}, ['b']));
			p.register(new TestProcessor('b', async () => {}, ['a']));
			expect(() => p.freeze()).toThrow(/cycle/);
		});

		it('keeps its error messages, and a cycle error names a processor on the cycle', () => {
			const dup = new InMemoryPostSessionPipeline();
			dup.register(new TestProcessor('dup', async () => {}));
			dup.register(new TestProcessor('dup', async () => {}));
			expect(() => dup.freeze()).toThrow('duplicate post-session processor name: dup');

			const unknown = new InMemoryPostSessionPipeline();
			unknown.register(new TestProcessor('a', async () => {}, ['ghost']));
			expect(() => unknown.freeze()).toThrow(
				'post-session processor "a" depends on unknown "ghost"',
			);

			const pair = new InMemoryPostSessionPipeline();
			pair.register(new TestProcessor('a', async () => {}, ['b']));
			pair.register(new TestProcessor('b', async () => {}, ['a']));
			expect(() => pair.freeze()).toThrow('post-session dependency cycle at "a"');

			const self = new InMemoryPostSessionPipeline();
			self.register(new TestProcessor('ok', async () => {}));
			self.register(new TestProcessor('self', async () => {}, ['self']));
			expect(() => self.freeze()).toThrow('post-session dependency cycle at "self"');

			// `entry` only leads into the cycle; the error names a member of it.
			const tail = new InMemoryPostSessionPipeline();
			tail.register(new TestProcessor('entry', async () => {}, ['x']));
			tail.register(new TestProcessor('x', async () => {}, ['y']));
			tail.register(new TestProcessor('y', async () => {}, ['x']));
			expect(() => tail.freeze()).toThrow('post-session dependency cycle at "x"');

			const required = new InMemoryPostSessionPipeline();
			required.register(new TestProcessor('opt', async () => {}));
			required.register(new TestProcessor('req', async () => {}, ['opt'], true));
			expect(() => required.freeze()).toThrow(
				'required processor "req" must not depend on optional "opt"',
			);
		});

		it('a name listed twice in dependsOn is one prerequisite', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('dependent', async () => {}, ['base', 'base']));
			p.register(new TestProcessor('base', async () => {}));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(report.results.map((r) => [r.processor, r.status])).toEqual([
				['base', 'completed'],
				['dependent', 'completed'],
			]);
		});

		it('rejects required-depends-on-optional', () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('opt', async () => {}));
			p.register(new TestProcessor('req', async () => {}, ['opt'], true));
			expect(() => p.freeze()).toThrow(/required/);
		});

		it('register after freeze throws', () => {
			const p = new InMemoryPostSessionPipeline();
			p.freeze();
			expect(() => p.register(new TestProcessor('late', async () => {}))).toThrow(/after freeze/);
		});

		it('dispatch before freeze throws', () => {
			const p = new InMemoryPostSessionPipeline();
			expect(() =>
				p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
			).toThrow(/before freeze/);
		});
	});

	describe('execution', () => {
		it('runs a processor and reports completed with detail', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('summary', async () => ({ chars: 42 })));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(report.outcome).toBe('accepted');
			expect(result(report, 'summary')?.status).toBe('completed');
			expect(result(report, 'summary')?.detail).toEqual({ chars: 42 });
		});

		it('honors dependency ordering (dep runs before dependent)', async () => {
			const order: string[] = [];
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('summary', async () => {
					order.push('summary');
				}),
			);
			p.register(
				new TestProcessor(
					'analytics',
					async () => {
						order.push('analytics');
					},
					['summary'],
				),
			);
			p.freeze();
			await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }).report;
			expect(order).toEqual(['summary', 'analytics']);
		});

		it('orders prerequisites first and breaks ties by registration order (stable topological order)', async () => {
			// `dependent` is registered first but needs `late`; `earlier` is registered before
			// `late`. Among processors whose prerequisites are placed, the earliest registered
			// goes next, so `earlier` precedes `late` even though `dependent` reaches `late`
			// first.
			const started: string[] = [];
			const proc = (name: string, deps: readonly string[] = []) =>
				new TestProcessor(
					name,
					async () => {
						started.push(name);
					},
					deps,
				);
			const p = new InMemoryPostSessionPipeline();
			p.register(proc('dependent', ['late']));
			p.register(proc('earlier'));
			p.register(proc('late'));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(report.results.map((r) => r.processor)).toEqual(['earlier', 'late', 'dependent']);
			expect(started).toEqual(['earlier', 'late', 'dependent']);
		});

		it('ignores the order of names inside dependsOn and places a freed processor by its registration index', async () => {
			// Registered: d (needs a, b), b, a, e (needs b), f.
			// Ready at start: b, a, f → b; e is now ready, but a (index 2) precedes it; once a
			// is placed d (index 0) is ready and goes next; then e, then f.
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('d', async () => {}, ['a', 'b']));
			p.register(new TestProcessor('b', async () => {}));
			p.register(new TestProcessor('a', async () => {}));
			p.register(new TestProcessor('e', async () => {}, ['b']));
			p.register(new TestProcessor('f', async () => {}));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(report.results.map((r) => r.processor)).toEqual(['b', 'a', 'd', 'e', 'f']);
		});

		it('isolates failures — a throwing processor does not abort siblings', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('flaky', async () => {
					throw new Error('boom');
				}),
			);
			p.register(new TestProcessor('ok', async () => ({ ran: true })));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'flaky')?.status).toBe('failed');
			expect(result(report, 'flaky')?.error?.message).toBe('boom');
			expect(result(report, 'ok')?.status).toBe('completed');
		});

		it('skips dependents of a failed dependency (dependency_failed)', async () => {
			let dependentRan = false;
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('flaky', async () => {
					throw new Error('boom');
				}),
			);
			p.register(
				new TestProcessor(
					'dependent',
					async () => {
						dependentRan = true;
					},
					['flaky'],
				),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'dependent')?.status).toBe('skipped');
			expect(result(report, 'dependent')?.detail?.reason).toBe('dependency_failed');
			expect(dependentRan).toBe(false);
		});

		it('skips when shouldRun() returns false', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor(
					'gated',
					async () => {},
					[],
					false,
					() => false,
				),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'gated')?.status).toBe('skipped');
			expect(result(report, 'gated')?.detail?.reason).toBe('shouldRun_false');
		});

		it('records failed when shouldRun() throws (no abort)', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor(
					'boomGate',
					async () => {},
					[],
					false,
					() => {
						throw new Error('gate');
					},
				),
			);
			p.register(new TestProcessor('ok', async () => {}));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'boomGate')?.status).toBe('failed');
			expect(result(report, 'boomGate')?.detail?.reason).toBe('shouldRun_threw');
			expect(result(report, 'ok')?.status).toBe('completed');
		});

		it('runs independent processors concurrently', async () => {
			let running = 0;
			let maxConcurrent = 0;
			const work = async () => {
				running++;
				maxConcurrent = Math.max(maxConcurrent, running);
				await new Promise((r) => setTimeout(r, 10));
				running--;
			};
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('a', work));
			p.register(new TestProcessor('b', work));
			p.register(new TestProcessor('c', work));
			p.freeze();
			await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }).report;
			expect(maxConcurrent).toBeGreaterThan(1);
		});
	});

	describe('reason preservation + reporting', () => {
		it('threads the caller reason into the snapshot', async () => {
			let seen: string | undefined;
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('cap', async (ctx) => {
					seen = ctx.reason;
				}),
			);
			p.freeze();
			await p.dispatch({ sessionId: 's', reason: 'reconnect_failed', build: makeBuilder('s') })
				.report;
			expect(seen).toBe('reconnect_failed');
		});

		it('emits exactly one report per run on the events channel', async () => {
			const emitted: PostSessionReport[] = [];
			const p = new InMemoryPostSessionPipeline();
			p.events.onProcessed((r) => emitted.push(r));
			p.register(new TestProcessor('a', async () => {}));
			p.freeze();
			await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }).report;
			expect(emitted).toHaveLength(1);
			expect(emitted[0].outcome).toBe('accepted');
		});
	});

	describe('failure paths always produce a report', () => {
		it('failed_to_start when build throws', async () => {
			const emitted: PostSessionReport[] = [];
			const p = new InMemoryPostSessionPipeline();
			p.events.onProcessed((r) => emitted.push(r));
			p.register(new TestProcessor('a', async () => {}));
			p.freeze();
			const run = p.dispatch({
				sessionId: 's',
				reason: 'normal',
				build: makeBuilder('s', { throwOnBuild: true }),
			});
			const report = await run.report;
			expect(run.outcome).toBe('failed_to_start');
			expect(report.outcome).toBe('failed_to_start');
			expect(report.failureReason).toBe('snapshot_failed');
			expect(report.results).toHaveLength(0);
			expect(emitted).toHaveLength(1);
		});

		it('drops an optional-only run at capacity (queue_overflow), still emitting', async () => {
			const emitted: PostSessionReport[] = [];
			const p = new InMemoryPostSessionPipeline({ maxConcurrentRuns: 0 });
			p.events.onProcessed((r) => emitted.push(r));
			p.register(new TestProcessor('a', async () => {}));
			p.freeze();
			const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
			const report = await run.report;
			expect(run.outcome).toBe('dropped');
			expect(report.failureReason).toBe('queue_overflow');
			expect(emitted).toHaveLength(1);
			expect(p.stats().dropped).toBe(1);
		});

		it('required run bounded-waits for a slot, then runs when one frees', async () => {
			// Capacity 1: an occupying run holds the only slot; a second required run
			// must wait, then run once the first completes.
			const p = new InMemoryPostSessionPipeline({ maxConcurrentRuns: 1, requiredWaitMs: 1000 });
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			p.register(new TestProcessor('memory', () => gate, [], true));
			p.freeze();

			const first = p.dispatch({ sessionId: 's1', reason: 'normal', build: makeBuilder('s1') });
			const second = p.dispatch({ sessionId: 's2', reason: 'normal', build: makeBuilder('s2') });
			expect(second.outcome).toBe('accepted'); // admitted to the wait queue
			expect(p.stats().queued).toBe(1); // waiting for a slot

			release(); // free the first run's slot
			const [r1, r2] = await Promise.all([first.report, second.report]);
			expect(r1.outcome).toBe('accepted');
			expect(r2.outcome).toBe('accepted');
			expect(p.stats().queued).toBe(0);
		});

		it('required run times out waiting for a slot → required_capacity_timeout', async () => {
			// Capacity 0 with a short wait budget: no slot ever frees.
			const p = new InMemoryPostSessionPipeline({ maxConcurrentRuns: 0, requiredWaitMs: 20 });
			p.register(new TestProcessor('memory', async () => {}, [], true));
			p.freeze();
			const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
			const report = await run.report;
			expect(report.outcome).toBe('dropped');
			expect(report.failureReason).toBe('required_capacity_timeout');
			expect(report.results).toHaveLength(0);
		});
	});

	describe('budget / drain_timeout', () => {
		it('resolves run.report with drain_timeout for an uncooperative processor', async () => {
			const p = new InMemoryPostSessionPipeline({ runBudgetMs: 20 });
			// Never resolves, ignores the abort signal — must still be cut off.
			p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(report.outcome).toBe('accepted');
			expect(result(report, 'hang')?.status).toBe('failed');
			expect(result(report, 'hang')?.detail?.reason).toBe('drain_timeout');
		});

		it('drain(timeout) cancels outstanding runs and resolves their reports', async () => {
			const p = new InMemoryPostSessionPipeline({ runBudgetMs: 60_000 });
			p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
			p.freeze();
			const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
			const reports = await p.drain(20);
			expect(reports).toHaveLength(1);
			const report = await run.report;
			expect(result(report, 'hang')?.detail?.reason).toBe('drain_timeout');
		});

		it('drain awaits AND cancels a still-queued required run (not just executing ones)', async () => {
			// Capacity 1: first run occupies the slot forever; a second REQUIRED run is
			// stuck waiting. drain(timeout) must include the waiter, cancel its wait, and
			// resolve its report — otherwise shutdown returns with a run still queued.
			const p = new InMemoryPostSessionPipeline({
				maxConcurrentRuns: 1,
				runBudgetMs: 60_000,
				requiredWaitMs: 60_000,
			});
			p.register(new TestProcessor('memory', () => new Promise<void>(() => {}), [], true));
			p.freeze();
			const first = p.dispatch({ sessionId: 's1', reason: 'normal', build: makeBuilder('s1') });
			const second = p.dispatch({ sessionId: 's2', reason: 'normal', build: makeBuilder('s2') });
			expect(p.stats().queued).toBe(1); // second is waiting for a slot

			const reports = await p.drain(20);
			expect(reports).toHaveLength(2); // both the executing and the queued run
			const r1 = await first.report;
			const r2 = await second.report;
			expect(result(r1, 'memory')?.detail?.reason).toBe('drain_timeout'); // executing → aborted
			expect(r2.failureReason).toBe('required_capacity_timeout'); // queued → wait cancelled
		});

		it('drain(timeout, {cancelOnTimeout:false}) returns partial reports and leaves work running', async () => {
			const p = new InMemoryPostSessionPipeline({ runBudgetMs: 60_000 });
			let resolveHang!: () => void;
			p.register(
				new TestProcessor(
					'hang',
					() =>
						new Promise<void>((r) => {
							resolveHang = () => r();
						}),
				),
			);
			p.freeze();
			const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });

			const reports = await p.drain(20, { cancelOnTimeout: false });
			expect(reports).toHaveLength(0); // nothing settled by the deadline

			// The run was NOT aborted — it's still running and completes normally once unblocked.
			let settled = false;
			void run.report.then(() => {
				settled = true;
			});
			await new Promise((r) => setTimeout(r, 5));
			expect(settled).toBe(false); // still running after drain returned
			resolveHang();
			const report = await run.report;
			expect(result(report, 'hang')?.status).toBe('completed'); // finished cleanly, never drain_timeout
		});
	});

	describe('public contract: robustness and characterization', () => {
		it('reports exactly the shapes it always has for completed, failed, gated and dependency-skipped processors', async () => {
			// Characterization: a pipeline that uses none of the newer features must report
			// the same objects, keys and order as before the post-session API was exported.
			const returned = { n: 1 };
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('done', async () => returned));
			p.register(
				new TestProcessor('boom', async () => {
					throw new Error('boom');
				}),
			);
			p.register(new TestProcessor('after-boom', async () => ({ never: true }), ['boom']));
			p.register(
				new TestProcessor(
					'gated',
					async () => {},
					[],
					false,
					() => false,
				),
			);
			p.register(new TestProcessor('empty', async () => {}));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(report).toStrictEqual({
				sessionId: 's',
				outcome: 'accepted',
				results: [
					{
						processor: 'done',
						status: 'completed',
						durationMs: expect.any(Number),
						detail: { n: 1 },
					},
					{
						processor: 'boom',
						status: 'failed',
						durationMs: expect.any(Number),
						error: expect.any(Error),
					},
					{
						processor: 'after-boom',
						status: 'skipped',
						durationMs: 0,
						detail: { reason: 'dependency_failed', dependency: 'boom' },
					},
					{
						processor: 'gated',
						status: 'skipped',
						durationMs: 0,
						detail: { reason: 'shouldRun_false' },
					},
					{
						processor: 'empty',
						status: 'completed',
						durationMs: expect.any(Number),
						detail: undefined,
					},
				],
				totalDurationMs: expect.any(Number),
			});
			// The returned value is the detail itself, not a copy.
			expect(result(report, 'done')?.detail).toBe(returned);
			expect(p.stats()).toEqual({ queued: 0, running: 0, dropped: 0, completed: 4, failed: 1 });
		});

		it('a synchronous throw from run() is failed: the report resolves, onProcessed fires once, nothing rejects unhandled', async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on('unhandledRejection', onUnhandled);
			try {
				const emitted: PostSessionReport[] = [];
				const p = new InMemoryPostSessionPipeline();
				p.events.onProcessed((r) => emitted.push(r));
				p.register(
					new TestProcessor('sync-throw', () => {
						throw new Error('sync boom');
					}),
				);
				p.register(new TestProcessor('ok', async () => ({ ran: true })));
				p.freeze();
				const report = await p.dispatch({
					sessionId: 's',
					reason: 'normal',
					build: makeBuilder('s'),
				}).report;
				expect(report.outcome).toBe('accepted');
				expect(result(report, 'sync-throw')?.status).toBe('failed');
				expect(result(report, 'sync-throw')?.error?.message).toBe('sync boom');
				expect(result(report, 'ok')?.status).toBe('completed');
				expect(emitted).toEqual([report]);
				expect(p.stats()).toMatchObject({ running: 0, completed: 1, failed: 1 });
				await new Promise((r) => setTimeout(r, 10));
				expect(unhandled).toEqual([]);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});

		it('a run() that returns a plain value instead of a promise reports that value as its detail', async () => {
			// A JavaScript host can skip `async`; the pipeline treats the value as resolved.
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('sync-value', (() => ({ sync: true })) as unknown as ProcRun));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'sync-value')?.status).toBe('completed');
			expect(result(report, 'sync-value')?.detail).toEqual({ sync: true });
		});

		it('an onError that throws cannot reject the report or stop later listeners', async () => {
			const p = new InMemoryPostSessionPipeline({
				onError: () => {
					throw new Error('error sink down');
				},
			});
			const seen: string[] = [];
			p.events.onProcessed(() => {
				throw new Error('listener down');
			});
			p.events.onProcessed((r) => seen.push(r.outcome));
			p.register(new TestProcessor('a', async () => {}));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(report.outcome).toBe('accepted');
			expect(seen).toEqual(['accepted']);
		});

		it('an onError that throws cannot make dispatch() throw on the build or overflow paths', async () => {
			const onError = () => {
				throw new Error('error sink down');
			};
			const built = new InMemoryPostSessionPipeline({ onError });
			built.register(new TestProcessor('a', async () => {}));
			built.freeze();
			let run!: PostSessionRun;
			expect(() => {
				run = built.dispatch({
					sessionId: 's',
					reason: 'normal',
					build: makeBuilder('s', { throwOnBuild: true }),
				});
			}).not.toThrow();
			expect((await run.report).failureReason).toBe('snapshot_failed');

			const full = new InMemoryPostSessionPipeline({ onError, maxConcurrentRuns: 0 });
			full.events.onProcessed(() => {
				throw new Error('listener down');
			});
			full.register(new TestProcessor('a', async () => {}));
			full.freeze();
			let dropped!: PostSessionRun;
			expect(() => {
				dropped = full.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
			}).not.toThrow();
			expect((await dropped.report).failureReason).toBe('queue_overflow');
		});

		it('on budget expiry a running processor is failed (drain_timeout) and its waiting dependent is skipped (dependency_failed)', async () => {
			let dependentRan = false;
			const p = new InMemoryPostSessionPipeline({ runBudgetMs: 20 });
			p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
			p.register(
				new TestProcessor(
					'next',
					async () => {
						dependentRan = true;
					},
					['hang'],
				),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'hang')).toMatchObject({
				status: 'failed',
				detail: { reason: 'drain_timeout' },
			});
			expect(result(report, 'next')).toMatchObject({
				status: 'skipped',
				detail: { reason: 'dependency_failed', dependency: 'hang' },
			});
			expect(dependentRan).toBe(false);
		});

		it('run.outcome is the admission decision; report.outcome is the final disposition', async () => {
			const p = new InMemoryPostSessionPipeline({ maxConcurrentRuns: 0, requiredWaitMs: 10 });
			p.register(new TestProcessor('needed', async () => {}, [], true));
			p.freeze();
			const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
			expect(run.outcome).toBe('accepted');
			const report = await run.report;
			expect(report.outcome).toBe('dropped');
			expect(report.failureReason).toBe('required_capacity_timeout');
		});

		it('a pipeline with no `after` calls every gate and run() on the same microtask ticks as before', async () => {
			// Characterization at tick level, recorded before soft ordering existed: a
			// microtask ticker interleaves with the pipeline's own continuations, so any
			// added or removed await on the no-`after` path changes this trace.
			const { trace, report } = await tickTrace(plainProcessor);
			expect(trace).toEqual(NO_AFTER_TICK_TRACE);
			expect(report.results.map((r) => `${r.processor}:${r.status}`)).toEqual([
				'a:completed',
				'b:completed',
				'c:completed',
				'd:skipped',
				'e:failed',
				'f:skipped',
			]);
		});
	});

	describe('soft order (after / afterWaitMs)', () => {
		const noop = async () => {};

		describe('freeze() validation', () => {
			it('rejects an `after` name that is not registered', () => {
				const p = new InMemoryPostSessionPipeline();
				p.register(new SoftProcessor('a', noop, { after: ['ghost'], afterWaitMs: 10 }));
				expect(() => p.freeze()).toThrow(/"a" runs after unknown "ghost"/);
			});

			it('rejects a name listed in both dependsOn and after', () => {
				const p = new InMemoryPostSessionPipeline();
				p.register(new TestProcessor('x', noop));
				p.register(
					new SoftProcessor('a', noop, { dependsOn: ['x'], after: ['x'], afterWaitMs: 10 }),
				);
				expect(() => p.freeze()).toThrow(/"a" lists "x" in both dependsOn and after/);
			});

			it('rejects a cycle over dependsOn and after together, and a processor that runs after itself', () => {
				const mixed = new InMemoryPostSessionPipeline();
				mixed.register(new TestProcessor('a', noop, ['b']));
				mixed.register(new SoftProcessor('b', noop, { after: ['a'], afterWaitMs: 10 }));
				expect(() => mixed.freeze()).toThrow('post-session dependency cycle at "a"');

				const self = new InMemoryPostSessionPipeline();
				self.register(new TestProcessor('ok', noop));
				self.register(new SoftProcessor('a', noop, { after: ['a'], afterWaitMs: 10 }));
				expect(() => self.freeze()).toThrow('post-session dependency cycle at "a"');

				// A cycle made of `after` edges only.
				const soft = new InMemoryPostSessionPipeline();
				soft.register(new SoftProcessor('a', noop, { after: ['b'], afterWaitMs: 10 }));
				soft.register(new SoftProcessor('b', noop, { after: ['a'], afterWaitMs: 10 }));
				expect(() => soft.freeze()).toThrow('post-session dependency cycle at "a"');

				// `entry` only leads into a cycle that alternates the two kinds of edge; the
				// error names a member of the cycle, found by walking both kinds.
				const tail = new InMemoryPostSessionPipeline();
				tail.register(new SoftProcessor('entry', noop, { after: ['x'], afterWaitMs: 10 }));
				tail.register(new TestProcessor('x', noop, ['y']));
				tail.register(new SoftProcessor('y', noop, { after: ['x'], afterWaitMs: 10 }));
				expect(() => tail.freeze()).toThrow('post-session dependency cycle at "x"');
			});

			it('requires a finite afterWaitMs of at least 0 when after is non-empty', () => {
				for (const afterWaitMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, '5']) {
					const p = new InMemoryPostSessionPipeline();
					p.register(new TestProcessor('x', noop));
					p.register(
						new SoftProcessor('a', noop, { after: ['x'], afterWaitMs: afterWaitMs as number }),
					);
					expect(() => p.freeze(), String(afterWaitMs)).toThrow(
						/"a" declares after but afterWaitMs .* is not a finite number >= 0/,
					);
				}
			});

			it('rejects a required processor whose afterWaitMs is not below runBudgetMs; an optional one may wait the whole budget', () => {
				const make = (required: boolean, afterWaitMs: number) => {
					const p = new InMemoryPostSessionPipeline({ runBudgetMs: 1_000 });
					p.register(new TestProcessor('x', noop));
					p.register(new SoftProcessor('a', noop, { after: ['x'], afterWaitMs, required }));
					return p;
				};
				expect(() => make(true, 1_000).freeze()).toThrow(
					/required processor "a" has afterWaitMs 1000, not below runBudgetMs 1000/,
				);
				expect(() => make(true, 5_000).freeze()).toThrow(/runBudgetMs/);
				expect(() => make(true, 999).freeze()).not.toThrow();
				expect(() => make(false, 1_000).freeze()).not.toThrow();
				expect(() => make(false, 5_000).freeze()).not.toThrow();
			});

			it('allows a required processor to run after an optional one', () => {
				const p = new InMemoryPostSessionPipeline();
				p.register(new TestProcessor('optional', noop));
				p.register(
					new SoftProcessor('needed', noop, {
						after: ['optional'],
						afterWaitMs: 10,
						required: true,
					}),
				);
				expect(() => p.freeze()).not.toThrow();
			});

			it('rejects an after that is not an array', () => {
				const p = new InMemoryPostSessionPipeline();
				p.register(new TestProcessor('x', noop));
				p.register(
					new SoftProcessor('a', noop, {
						after: 'x' as unknown as readonly string[],
						afterWaitMs: 10,
					}),
				);
				expect(() => p.freeze()).toThrow(/"a" has an after that is not an array/);
			});

			it('reads afterWaitMs only when after is non-empty, and treats a missing after as empty', async () => {
				const p = new InMemoryPostSessionPipeline();
				p.register(
					new SoftProcessor('ignored-wait', async () => ({ ran: 1 }), {
						after: [],
						afterWaitMs: -1,
					}),
				);
				const missing = new TestProcessor('missing-after', async () => ({ ran: 2 }));
				Object.defineProperty(missing, 'after', { value: undefined });
				p.register(missing);
				expect(() => p.freeze()).not.toThrow();
				const report = await p.dispatch({
					sessionId: 's',
					reason: 'normal',
					build: makeBuilder('s'),
				}).report;
				expect(report.results.map((r) => `${r.processor}:${r.status}`)).toEqual([
					'ignored-wait:completed',
					'missing-after:completed',
				]);
			});
		});

		describe('execution', () => {
			beforeEach(() => {
				vi.useFakeTimers();
			});
			afterEach(() => {
				vi.useRealTimers();
			});

			const outcomes: ReadonlyArray<{
				outcome: string;
				status: string;
				reason?: string;
				log: readonly string[];
				register: (p: InMemoryPostSessionPipeline, log: string[]) => void;
			}> = [
				{
					outcome: 'completed',
					status: 'completed',
					log: ['prereq:settled', 'next:run'],
					register: (p, log) =>
						p.register(
							new TestProcessor('prereq', async () => {
								await Promise.resolve();
								log.push('prereq:settled');
								return { wrote: 1 };
							}),
						),
				},
				{
					outcome: 'skipped by its gate',
					status: 'skipped',
					reason: 'shouldRun_false',
					log: ['next:run'],
					register: (p) => p.register(new TestProcessor('prereq', noop, [], false, () => false)),
				},
				{
					outcome: 'skipped from run()',
					status: 'skipped',
					reason: 'run_skipped',
					log: ['prereq:settled', 'next:run'],
					register: (p, log) =>
						p.register(
							new TestProcessor('prereq', async () => {
								await Promise.resolve();
								log.push('prereq:settled');
								return postSessionSkip('nothing to do');
							}),
						),
				},
				{
					outcome: 'skipped for a failed hard dependency',
					status: 'skipped',
					reason: 'dependency_failed',
					log: ['next:run'],
					register: (p) => {
						p.register(
							new TestProcessor('boom', async () => {
								throw new Error('boom');
							}),
						);
						p.register(new TestProcessor('prereq', noop, ['boom']));
					},
				},
				{
					outcome: 'failed by a throw',
					status: 'failed',
					log: ['prereq:settled', 'next:run'],
					register: (p, log) =>
						p.register(
							new TestProcessor('prereq', async () => {
								await Promise.resolve();
								log.push('prereq:settled');
								throw new Error('prereq failed');
							}),
						),
				},
				{
					outcome: 'failed by a throwing gate',
					status: 'failed',
					reason: 'shouldRun_threw',
					log: ['next:run'],
					register: (p) =>
						p.register(
							new TestProcessor('prereq', noop, [], false, () => {
								throw new Error('gate failed');
							}),
						),
				},
			];

			it.each(outcomes)(
				'a required dependent runs as soon as its optional prerequisite settles ($outcome), without waiting for the bound',
				async ({ status, reason, log: expectedLog, register }) => {
					const log: string[] = [];
					const p = new InMemoryPostSessionPipeline();
					register(p, log);
					p.register(
						new SoftProcessor(
							'next',
							async () => {
								log.push('next:run');
								return { own: true };
							},
							{ after: ['prereq'], afterWaitMs: 10_000, required: true },
						),
					);
					p.freeze();
					const run = watch(
						p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
					);
					await vi.advanceTimersByTimeAsync(0);
					expect(run.report).toBeDefined();
					expect(log).toEqual(expectedLog);
					expect(result(run.report, 'prereq')?.status).toBe(status);
					expect(result(run.report, 'prereq')?.detail?.reason).toBe(reason);
					// The dependent gets nothing of its prerequisite's result.
					expect(result(run.report, 'next')).toStrictEqual({
						processor: 'next',
						status: 'completed',
						durationMs: 0,
						detail: { own: true },
					});
					// The bound's timer was cleared when the wait ended.
					expect(vi.getTimerCount()).toBe(0);
				},
			);

			it('waits at most afterWaitMs from the start of execution, then runs while the prerequisite still runs; the prerequisite is reported as normal', async () => {
				const log: string[] = [];
				let release!: () => void;
				const emitted: PostSessionReport[] = [];
				const p = new InMemoryPostSessionPipeline({ runBudgetMs: 1_000 });
				p.events.onProcessed((r) => emitted.push(r));
				p.register(
					new TestProcessor(
						'prereq',
						() =>
							new Promise<Record<string, unknown>>((resolve) => {
								release = () => {
									log.push('prereq:settled');
									resolve({ late: true });
								};
							}),
					),
				);
				p.register(
					new SoftProcessor(
						'next',
						async (ctx) => {
							log.push(`next:run aborted=${ctx.signal.aborted}`);
							return { own: true };
						},
						{ after: ['prereq'], afterWaitMs: 50, required: true },
					),
				);
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(49);
				expect(log).toEqual([]);
				await vi.advanceTimersByTimeAsync(1);
				expect(log).toEqual(['next:run aborted=false']);
				expect(run.report).toBeUndefined();

				await vi.advanceTimersByTimeAsync(50);
				release();
				await vi.advanceTimersByTimeAsync(0);
				expect(log).toEqual(['next:run aborted=false', 'prereq:settled']);
				// durationMs is each processor's own time: the dependent's excludes its wait.
				expect(run.report?.results).toStrictEqual([
					{ processor: 'prereq', status: 'completed', durationMs: 100, detail: { late: true } },
					{ processor: 'next', status: 'completed', durationMs: 0, detail: { own: true } },
				]);
				expect(emitted).toHaveLength(1);
				expect(vi.getTimerCount()).toBe(0);
			});

			it('the bound is absolute, so it overlaps the wait for hard dependencies', async () => {
				// `hang` never settles, so only the 20 ms bound ends each soft wait. `early`'s
				// hard prerequisite completes at 10 ms, so it runs at 20: a scheduler that
				// ignored `after` runs it at 10, and one that counted the bound from the end of
				// the hard wait, at 30. `late`'s completes at 40 ms, so it runs at 40, not 60.
				// Dependents are registered before their prerequisites, so neither
				// registration order nor a sort that ignored `after` can order them.
				const log: string[] = [];
				const begin = Date.now();
				const logRun = (name: string) => async () => {
					log.push(`${name}@${Date.now() - begin}`);
					return { own: name };
				};
				const doneAt = (ms: number) => () =>
					new Promise<Record<string, unknown>>((r) => setTimeout(() => r({}), ms));
				const p = new InMemoryPostSessionPipeline({ runBudgetMs: 1_000 });
				p.register(
					new SoftProcessor('early', logRun('early'), {
						dependsOn: ['fast'],
						after: ['hang'],
						afterWaitMs: 20,
					}),
				);
				p.register(
					new SoftProcessor('late', logRun('late'), {
						dependsOn: ['slow'],
						after: ['hang'],
						afterWaitMs: 20,
					}),
				);
				p.register(new TestProcessor('fast', doneAt(10)));
				p.register(new TestProcessor('slow', doneAt(40)));
				p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(1_000);
				expect(log).toEqual(['early@20', 'late@40']);
				expect(run.report?.results.map((r) => `${r.processor}:${r.status}`)).toEqual([
					'fast:completed',
					'slow:completed',
					'hang:failed',
					'early:completed',
					'late:completed',
				]);
			});

			it.each([Number.MAX_SAFE_INTEGER, 2 ** 31])(
				'an afterWaitMs of %d, past the longest setTimeout delay, waits until the run budget, not about 1 ms',
				async (afterWaitMs) => {
					const calls: string[] = [];
					const p = new InMemoryPostSessionPipeline({ runBudgetMs: 1_000 });
					p.register(
						new SoftProcessor(
							'next',
							async () => {
								calls.push('run');
							},
							{
								after: ['hang'],
								afterWaitMs,
								gate: () => {
									calls.push('gate');
									return true;
								},
							},
						),
					);
					p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
					p.freeze();
					const run = watch(
						p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
					);
					await vi.advanceTimersByTimeAsync(999);
					expect(calls).toEqual([]);
					expect(run.report).toBeUndefined();
					await vi.advanceTimersByTimeAsync(1);
					expect(run.report?.results).toStrictEqual([
						{
							processor: 'hang',
							status: 'failed',
							durationMs: 1_000,
							detail: { reason: 'drain_timeout' },
						},
						{
							processor: 'next',
							status: 'failed',
							durationMs: 0,
							detail: { reason: 'drain_timeout' },
						},
					]);
					expect(calls).toEqual([]);
					expect(vi.getTimerCount()).toBe(0);
				},
			);

			it('a bound and a run budget past the longest setTimeout delay are both honoured', async () => {
				const longestDelay = 2 ** 31 - 1;
				const bound = longestDelay + 10;
				const budget = 2 ** 32;
				const log: string[] = [];
				const p = new InMemoryPostSessionPipeline({ runBudgetMs: budget });
				p.register(
					new SoftProcessor(
						'next',
						async (ctx) => {
							log.push(`next:run aborted=${ctx.signal.aborted}`);
							return { own: true };
						},
						{ after: ['hang'], afterWaitMs: bound },
					),
				);
				p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(bound - 1);
				expect(log).toEqual([]);
				expect(run.report).toBeUndefined();
				await vi.advanceTimersByTimeAsync(1);
				expect(log).toEqual(['next:run aborted=false']);
				await vi.advanceTimersByTimeAsync(budget - bound - 1);
				expect(run.report).toBeUndefined();
				await vi.advanceTimersByTimeAsync(1);
				expect(run.report?.results).toStrictEqual([
					{
						processor: 'hang',
						status: 'failed',
						durationMs: budget,
						detail: { reason: 'drain_timeout' },
					},
					{ processor: 'next', status: 'completed', durationMs: 0, detail: { own: true } },
				]);
				expect(vi.getTimerCount()).toBe(0);
			});

			it('afterWaitMs 0 sets the order of results only: the dependent does not wait', async () => {
				const log: string[] = [];
				const p = new InMemoryPostSessionPipeline({ runBudgetMs: 100 });
				p.register(
					new SoftProcessor(
						'next',
						async () => {
							log.push('next:run');
						},
						{ after: ['hang'], afterWaitMs: 0 },
					),
				);
				p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(log).toEqual(['next:run']);
				await vi.advanceTimersByTimeAsync(100);
				expect(run.report?.results.map((r) => `${r.processor}:${r.status}`)).toEqual([
					'hang:failed',
					'next:completed',
				]);
			});

			it('when the run budget expires during the wait, the dependent is failed (drain_timeout) without shouldRun() or run(), and the report does not wait for the bound', async () => {
				const calls: string[] = [];
				const p = new InMemoryPostSessionPipeline({ runBudgetMs: 100 });
				p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
				p.register(
					new SoftProcessor(
						'next',
						async () => {
							calls.push('run');
						},
						{
							after: ['hang'],
							afterWaitMs: 5_000,
							gate: () => {
								calls.push('gate');
								return true;
							},
						},
					),
				);
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(99);
				expect(run.report).toBeUndefined();
				await vi.advanceTimersByTimeAsync(1);
				expect(run.report?.results).toStrictEqual([
					{
						processor: 'hang',
						status: 'failed',
						durationMs: 100,
						detail: { reason: 'drain_timeout' },
					},
					{
						processor: 'next',
						status: 'failed',
						durationMs: 0,
						detail: { reason: 'drain_timeout' },
					},
				]);
				expect(calls).toEqual([]);
				expect(vi.getTimerCount()).toBe(0);
				expect(p.stats()).toMatchObject({ completed: 0, failed: 2 });
			});

			it('drain() cancelling the run ends the wait the same way', async () => {
				const calls: string[] = [];
				const p = new InMemoryPostSessionPipeline({ runBudgetMs: 60_000 });
				p.register(new TestProcessor('hang', () => new Promise<void>(() => {})));
				p.register(
					new SoftProcessor(
						'next',
						async () => {
							calls.push('run');
						},
						{
							after: ['hang'],
							afterWaitMs: 10_000,
							required: true,
							gate: () => {
								calls.push('gate');
								return true;
							},
						},
					),
				);
				p.freeze();
				const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
				const drained = p.drain(20);
				await vi.advanceTimersByTimeAsync(20);
				expect(await drained).toHaveLength(1);
				expect(result(await run.report, 'next')).toStrictEqual({
					processor: 'next',
					status: 'failed',
					durationMs: 0,
					detail: { reason: 'drain_timeout' },
				});
				expect(calls).toEqual([]);
			});

			it('a hard dependency that did not complete skips the dependent first (dependency_failed), before the soft wait and the abort guard', async () => {
				// `after-boom`'s hard prerequisite fails at once and its soft one never settles.
				// Its result must settle at once, not when its 500 ms bound or the 1_000 ms
				// budget ends the soft wait. `watcher` runs after `after-boom` and a 30 ms
				// `slow`, so it runs at 30 only when `after-boom` settled by then: a scheduler
				// that ignored `after` runs it at 0, and one that waited on the soft edge before
				// checking the hard one, at 500. Dependents are registered before their
				// prerequisites, so neither registration order nor a sort that ignored `after`
				// can order them.
				const log: string[] = [];
				const begin = Date.now();
				const gate = (name: string) => () => {
					log.push(`${name}:gate`);
					return true;
				};
				const p = new InMemoryPostSessionPipeline({ runBudgetMs: 1_000 });
				p.register(
					new SoftProcessor(
						'watcher',
						async () => {
							log.push(`watcher@${Date.now() - begin}`);
							return { own: true };
						},
						{ after: ['after-boom', 'slow'], afterWaitMs: 900 },
					),
				);
				p.register(
					new SoftProcessor('after-boom', noop, {
						dependsOn: ['boom'],
						after: ['hang-soft'],
						afterWaitMs: 500,
						gate: gate('after-boom'),
					}),
				);
				p.register(
					new SoftProcessor('after-hang', noop, {
						dependsOn: ['hang-hard'],
						after: ['hang-soft'],
						afterWaitMs: 500,
						gate: gate('after-hang'),
					}),
				);
				p.register(
					new TestProcessor('boom', async () => {
						throw new Error('boom');
					}),
				);
				p.register(
					new TestProcessor(
						'slow',
						() => new Promise<Record<string, unknown>>((r) => setTimeout(() => r({}), 30)),
					),
				);
				p.register(new TestProcessor('hang-hard', () => new Promise<void>(() => {})));
				p.register(new TestProcessor('hang-soft', () => new Promise<void>(() => {})));
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(999);
				expect(log).toEqual(['watcher@30']);
				expect(run.report).toBeUndefined();
				await vi.advanceTimersByTimeAsync(1);
				expect(result(run.report, 'after-boom')).toStrictEqual({
					processor: 'after-boom',
					status: 'skipped',
					durationMs: 0,
					detail: { reason: 'dependency_failed', dependency: 'boom' },
				});
				// The budget aborted the run while `after-hang` waited on both edges: the
				// unfinished hard dependency wins over the abort guard.
				expect(result(run.report, 'after-hang')).toStrictEqual({
					processor: 'after-hang',
					status: 'skipped',
					durationMs: 0,
					detail: { reason: 'dependency_failed', dependency: 'hang-hard' },
				});
				expect(result(run.report, 'watcher')?.status).toBe('completed');
				expect(log).toEqual(['watcher@30']);
			});

			it('results are in topological order over both kinds of edge: an `after` edge puts a later-registered prerequisite first', async () => {
				// Without the soft edge in the sort, results would follow registration order
				// (other, next, first). Every tie here resolves the same way under any
				// registration-order tie-break.
				const p = new InMemoryPostSessionPipeline();
				p.register(new TestProcessor('other', noop));
				p.register(new SoftProcessor('next', noop, { after: ['first'], afterWaitMs: 10 }));
				p.register(new TestProcessor('first', noop));
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(run.report?.results.map((r) => r.processor)).toEqual(['other', 'first', 'next']);
			});

			it('places an `after` dependent by its registration index once its prerequisites are placed (stable Kahn order)', async () => {
				// `dependent` is registered first but runs after `late`; `earlier` is registered
				// before `late`. Among processors whose prerequisites are placed, the earliest
				// registered goes next: earlier, late, dependent. (A depth-first sort would give
				// late, dependent, earlier; a sort that ignored `after`, registration order.)
				const p = new InMemoryPostSessionPipeline();
				p.register(new SoftProcessor('dependent', noop, { after: ['late'], afterWaitMs: 10 }));
				p.register(new TestProcessor('earlier', noop));
				p.register(new TestProcessor('late', noop));
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(run.report?.results.map((r) => r.processor)).toEqual([
					'earlier',
					'late',
					'dependent',
				]);
			});

			it('counts dependsOn and after edges together, whatever the order of names and whichever kind each edge is', async () => {
				// Registered: d (needs a and b), b, a, e (runs after b), f. Ready at start: b, a,
				// f. After b, e is ready, but a (index 2) precedes it; once a is placed d
				// (index 0) is ready and goes next; then e, then f. d reaches a and b through
				// any mix of the two kinds of edge and in either name order.
				const variants: ReadonlyArray<{ dependsOn?: readonly string[]; after: readonly string[] }> =
					[
						{ after: ['a', 'b'] },
						{ after: ['b', 'a'] },
						{ dependsOn: ['a'], after: ['b'] },
						{ dependsOn: ['b'], after: ['a'] },
					];
				for (const edges of variants) {
					const p = new InMemoryPostSessionPipeline();
					p.register(new SoftProcessor('d', noop, { ...edges, afterWaitMs: 10 }));
					p.register(new TestProcessor('b', noop));
					p.register(new TestProcessor('a', noop));
					p.register(new SoftProcessor('e', noop, { after: ['b'], afterWaitMs: 10 }));
					p.register(new TestProcessor('f', noop));
					p.freeze();
					const run = watch(
						p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
					);
					await vi.advanceTimersByTimeAsync(0);
					expect(
						run.report?.results.map((r) => r.processor),
						JSON.stringify(edges),
					).toEqual(['b', 'a', 'd', 'e', 'f']);
				}
			});

			it('a name listed twice in after is one prerequisite for the order', async () => {
				const p = new InMemoryPostSessionPipeline();
				p.register(new SoftProcessor('next', noop, { after: ['first', 'first'], afterWaitMs: 10 }));
				p.register(new TestProcessor('first', noop));
				p.freeze();
				const run = watch(
					p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') }),
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(run.report?.results.map((r) => `${r.processor}:${r.status}`)).toEqual([
					'first:completed',
					'next:completed',
				]);
			});
		});

		it('a processor that declares `after: []` runs on the same ticks as one that declares nothing', async () => {
			const { trace } = await tickTrace(
				(name, fn, dependsOn, gate) =>
					new SoftProcessor(name, fn, { after: [], afterWaitMs: 5, dependsOn, gate }),
			);
			expect(trace).toEqual(NO_AFTER_TICK_TRACE);
		});
	});

	describe('skip from run() (postSessionSkip)', () => {
		it('a returned skip reports skipped with run_skipped, the skip reason, the host detail and the real duration', async () => {
			const emitted: PostSessionReport[] = [];
			const p = new InMemoryPostSessionPipeline();
			p.events.onProcessed((r) => emitted.push(r));
			p.register(
				new TestProcessor('opt-out', async () => {
					await new Promise((r) => setTimeout(r, 15));
					return postSessionSkip('user opted out', { checkedBy: 'consent lookup' });
				}),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			const skipped = result(report, 'opt-out');
			expect(skipped).toStrictEqual({
				processor: 'opt-out',
				status: 'skipped',
				durationMs: expect.any(Number),
				detail: {
					checkedBy: 'consent lookup',
					reason: 'run_skipped',
					skipReason: 'user opted out',
				},
			});
			expect(skipped?.durationMs).toBeGreaterThanOrEqual(10);
			expect(emitted).toEqual([report]);
			// The report stays plain data: the branded value never enters it.
			expect(Object.getOwnPropertySymbols(skipped?.detail ?? {})).toEqual([]);
			expect(isPostSessionSkip(skipped?.detail)).toBe(false);
			expect(JSON.parse(JSON.stringify(skipped))).toEqual(skipped);
			expect(p.stats()).toMatchObject({ completed: 1, failed: 0 });
		});

		it('a skip without detail reports only reason and skipReason', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('nothing-to-do', async () => postSessionSkip('nothing to do')));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'nothing-to-do')?.detail).toStrictEqual({
				reason: 'run_skipped',
				skipReason: 'nothing to do',
			});
		});

		it("bodhi's reason and skipReason override host detail keys of the same name", async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('lookup', async () =>
					postSessionSkip('consent lookup failed', {
						reason: 'host reason',
						skipReason: 'host skip reason',
						attempt: 2,
					}),
				),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'lookup')?.detail).toStrictEqual({
				reason: 'run_skipped',
				skipReason: 'consent lookup failed',
				attempt: 2,
			});
		});

		it('a mutation of the detail after postSessionSkip() cannot change the report', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('mutating', async () => {
					const detail: Record<string, unknown> = { attempt: 1 };
					const skip = postSessionSkip('user opted out', detail);
					detail.attempt = 2;
					detail.extra = true;
					return skip;
				}),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'mutating')?.detail).toStrictEqual({
				attempt: 1,
				reason: 'run_skipped',
				skipReason: 'user opted out',
			});
		});

		it('dependents of a skipped processor are skipped with dependency_failed', async () => {
			let dependentRan = false;
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('opt-out', async () => postSessionSkip('user opted out')));
			p.register(
				new TestProcessor(
					'after-opt-out',
					async () => {
						dependentRan = true;
					},
					['opt-out'],
				),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'after-opt-out')).toMatchObject({
				status: 'skipped',
				detail: { reason: 'dependency_failed', dependency: 'opt-out' },
			});
			expect(dependentRan).toBe(false);
		});

		it('a thrown skip is failed with an Error, not skipped, and the skip never enters the report', async () => {
			const thrown = postSessionSkip('user opted out', { checked: 'consent' });
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('thrower', async () => {
					throw thrown;
				}),
			);
			p.register(
				new TestProcessor('sync-thrower', () => {
					throw thrown;
				}),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			for (const name of ['thrower', 'sync-thrower']) {
				const r = result(report, name);
				expect(r?.status).toBe('failed');
				expect(r?.error).toBeInstanceOf(Error);
				expect(r?.error?.message).toMatch(/postSessionSkip/);
				expect(r?.detail).toBeUndefined();
			}
			// Neither the branded value nor its brand is reachable from the report, even
			// through non-enumerable properties such as Error.cause.
			expect(reachableFrom(report).has(thrown)).toBe(false);
			expect(reachableKeys(report)).not.toContain(SKIP_BRAND);
			expect(JSON.stringify(report)).not.toContain('consent');
		});

		it('a thrown non-Error value is failed with an Error that keeps the value as its cause', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('string-rejection', async () => {
					throw 'boom';
				}),
			);
			p.register(new TestProcessor('object-rejection', () => Promise.reject({ code: 42 })));
			p.register(
				new TestProcessor('null-prototype', async () => {
					throw Object.create(null);
				}),
			);
			p.register(
				new TestProcessor(
					'gate-throws-string',
					async () => {},
					[],
					false,
					() => {
						throw 'gate boom';
					},
				),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			const stringErr = result(report, 'string-rejection')?.error;
			expect(result(report, 'string-rejection')?.status).toBe('failed');
			expect(stringErr).toBeInstanceOf(Error);
			expect(stringErr?.message).toMatch(/"boom"/);
			expect(stringErr?.cause).toBe('boom');
			const objectErr = result(report, 'object-rejection')?.error;
			expect(result(report, 'object-rejection')?.status).toBe('failed');
			expect(objectErr).toBeInstanceOf(Error);
			expect(objectErr?.cause).toEqual({ code: 42 });
			expect(result(report, 'null-prototype')?.status).toBe('failed');
			expect(result(report, 'null-prototype')?.error).toBeInstanceOf(Error);
			expect(result(report, 'gate-throws-string')).toMatchObject({
				status: 'failed',
				detail: { reason: 'shouldRun_threw' },
			});
			expect(result(report, 'gate-throws-string')?.error).toBeInstanceOf(Error);
			expect(result(report, 'gate-throws-string')?.error?.cause).toBe('gate boom');
		});

		it('a thrown value that throws when inspected is failed with a causeless Error: the report resolves, onProcessed fires once, nothing rejects unhandled', async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on('unhandledRejection', onUnhandled);
			try {
				// `instanceof` asks a Proxy for its prototype; the skip check reads the brand
				// and `reason`. Each of these values throws from one of those reads.
				const hostileProxy = new Proxy(
					{},
					{
						get() {
							throw new Error('get trap boom');
						},
						getPrototypeOf() {
							throw new Error('getPrototypeOf trap boom');
						},
					},
				);
				const brandGetter = {
					get [SKIP_BRAND]() {
						throw new Error('brand getter boom');
					},
				};
				const reasonGetter = {
					[SKIP_BRAND]: true,
					get reason() {
						throw new Error('reason getter boom');
					},
				};
				const emitted: PostSessionReport[] = [];
				const p = new InMemoryPostSessionPipeline();
				p.events.onProcessed((r) => emitted.push(r));
				p.register(
					new TestProcessor('proxy-rejection', async () => {
						throw hostileProxy;
					}),
				);
				p.register(
					new TestProcessor('proxy-sync-throw', () => {
						throw hostileProxy;
					}),
				);
				p.register(new TestProcessor('brand-getter', () => Promise.reject(brandGetter)));
				p.register(new TestProcessor('reason-getter', () => Promise.reject(reasonGetter)));
				p.register(
					new TestProcessor(
						'gate-throws-proxy',
						async () => {},
						[],
						false,
						() => {
							throw hostileProxy;
						},
					),
				);
				p.register(new TestProcessor('ok', async () => ({ ran: true })));
				p.freeze();
				const report = await p.dispatch({
					sessionId: 's',
					reason: 'normal',
					build: makeBuilder('s'),
				}).report;

				expect(report.outcome).toBe('accepted');
				for (const name of [
					'proxy-rejection',
					'proxy-sync-throw',
					'brand-getter',
					'reason-getter',
				]) {
					const r = result(report, name);
					expect(r?.status).toBe('failed');
					expect(r?.error).toBeInstanceOf(Error);
					expect(r?.error?.message).toBe('run() threw a value that could not be inspected');
					expect(r?.detail).toBeUndefined();
					// No `cause`: a reference to the value would re-run its traps or getters
					// in every host that logs the error.
					expect(Object.hasOwn(r?.error as Error, 'cause')).toBe(false);
				}
				const gate = result(report, 'gate-throws-proxy');
				expect(gate).toMatchObject({ status: 'failed', detail: { reason: 'shouldRun_threw' } });
				expect(gate?.error).toBeInstanceOf(Error);
				expect(gate?.error?.message).toBe('shouldRun() threw a value that could not be inspected');
				expect(Object.hasOwn(gate?.error as Error, 'cause')).toBe(false);
				expect(result(report, 'ok')?.status).toBe('completed');

				const reachable = reachableFrom(report);
				for (const hostile of [hostileProxy, brandGetter, reasonGetter]) {
					expect(reachable.has(hostile)).toBe(false);
				}
				expect(emitted).toHaveLength(1);
				expect(emitted[0]).toBe(report);
				expect(p.stats()).toMatchObject({ running: 0, completed: 1, failed: 5 });
				await new Promise((r) => setTimeout(r, 10));
				expect(unhandled).toEqual([]);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});

		it('the pending-report cleanup adds no rejection of its own when a report rejects', async () => {
			// White-box: no processor can make a report reject any more, so drive the private
			// tracker directly. A cleanup chained with finally() would reject unhandled here.
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on('unhandledRejection', onUnhandled);
			try {
				const p = new InMemoryPostSessionPipeline();
				const internals = p as unknown as {
					track(report: Promise<PostSessionReport>): Promise<PostSessionReport>;
					pendingReports: Set<Promise<PostSessionReport>>;
				};
				const rejected = Promise.reject(new Error('report boom'));
				const tracked = internals.track(rejected);
				expect(tracked).toBe(rejected);
				expect(internals.pendingReports.has(rejected)).toBe(true);
				await expect(tracked).rejects.toThrow('report boom');
				await new Promise((r) => setTimeout(r, 10));
				expect(internals.pendingReports.size).toBe(0);
				expect(unhandled).toEqual([]);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});

		it('a returned value whose skip check throws is not a skip: it is the detail of a completed result', async () => {
			// bodhi reads nothing of a returned detail but the skip check, so a value whose
			// brand getter throws is reported as is, like any other detail.
			const returned = {
				get [SKIP_BRAND]() {
					throw new Error('brand getter boom');
				},
			};
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('hostile-detail', async () => returned as Record<string, unknown>),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'hostile-detail')?.status).toBe('completed');
			expect(result(report, 'hostile-detail')?.detail).toBe(returned);
		});

		it('a returned skip whose reason or detail throws while bodhi copies it is failed with a causeless Error: the report resolves, onProcessed fires once, nothing rejects unhandled', async () => {
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => {
				unhandled.push(reason);
			};
			process.on('unhandledRejection', onUnhandled);
			try {
				// Each value passes the skip check (the brand and a string `reason`), then throws
				// when bodhi reads `detail`, reads `reason` again, or copies `detail`'s keys.
				const detailGetter = {
					[SKIP_BRAND]: true,
					reason: 'opted out',
					get detail() {
						throw new Error('detail getter boom');
					},
				};
				let reasonReads = 0;
				const reasonGetter = {
					[SKIP_BRAND]: true,
					get reason() {
						reasonReads++;
						if (reasonReads > 1) throw new Error('reason getter boom');
						return 'opted out';
					},
				};
				const detailKeyGetter = {
					[SKIP_BRAND]: true,
					reason: 'opted out',
					detail: {
						get checked() {
							throw new Error('detail key getter boom');
						},
					},
				};
				const emitted: PostSessionReport[] = [];
				const p = new InMemoryPostSessionPipeline();
				p.events.onProcessed((r) => emitted.push(r));
				p.register(
					new TestProcessor(
						'detail-getter',
						async () => detailGetter as unknown as PostSessionSkip,
					),
				);
				p.register(
					new TestProcessor(
						'reason-getter',
						async () => reasonGetter as unknown as PostSessionSkip,
					),
				);
				p.register(
					new TestProcessor(
						'detail-key-getter',
						async () => detailKeyGetter as unknown as PostSessionSkip,
					),
				);
				p.register(new TestProcessor('dependent', async () => ({ ran: true }), ['detail-getter']));
				p.register(new TestProcessor('ok', async () => ({ ran: true })));
				p.freeze();
				const report = await p.dispatch({
					sessionId: 's',
					reason: 'normal',
					build: makeBuilder('s'),
				}).report;

				expect(report.outcome).toBe('accepted');
				for (const name of ['detail-getter', 'reason-getter', 'detail-key-getter']) {
					const r = result(report, name);
					expect(r?.status).toBe('failed');
					expect(r?.error).toBeInstanceOf(Error);
					expect(r?.error?.message).toBe(
						'run() returned a postSessionSkip() value that could not be inspected',
					);
					expect(r?.detail).toBeUndefined();
					// No `cause`: a reference to the value would re-run its getters in every
					// host that logs the error.
					expect(Object.hasOwn(r?.error as Error, 'cause')).toBe(false);
				}
				expect(result(report, 'dependent')).toMatchObject({
					status: 'skipped',
					detail: { reason: 'dependency_failed', dependency: 'detail-getter' },
				});
				expect(result(report, 'ok')?.status).toBe('completed');

				const reachable = reachableFrom(report);
				for (const hostile of [detailGetter, reasonGetter, detailKeyGetter]) {
					expect(reachable.has(hostile)).toBe(false);
				}
				expect(reachable.has(detailKeyGetter.detail)).toBe(false);
				expect(emitted).toHaveLength(1);
				expect(emitted[0]).toBe(report);
				expect(p.stats()).toMatchObject({ running: 0, completed: 2, failed: 3 });
				await new Promise((r) => setTimeout(r, 10));
				expect(unhandled).toEqual([]);
			} finally {
				process.off('unhandledRejection', onUnhandled);
			}
		});

		it('a thrown Error is reported as that same Error', async () => {
			const thrown = new RangeError('out of range');
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('thrower', async () => {
					throw thrown;
				}),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'thrower')?.error).toBe(thrown);
		});

		it('a skip that settles after the run budget stays failed with drain_timeout', async () => {
			const p = new InMemoryPostSessionPipeline({ runBudgetMs: 10 });
			p.register(
				new TestProcessor('late', async () => {
					await new Promise((r) => setTimeout(r, 40));
					return postSessionSkip('user opted out');
				}),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'late')).toMatchObject({
				status: 'failed',
				detail: { reason: 'drain_timeout' },
			});
		});

		it('an empty reason throws a TypeError inside run(), which reports failed', async () => {
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('bad-skip', async () => postSessionSkip('')));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'bad-skip')?.status).toBe('failed');
			expect(result(report, 'bad-skip')?.error).toBeInstanceOf(TypeError);
		});

		it('a plain object shaped like a skip is an ordinary detail and reports completed', async () => {
			const plain = { reason: 'user opted out' };
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('plain', async () => plain));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'plain')?.status).toBe('completed');
			expect(result(report, 'plain')?.detail).toBe(plain);
		});

		it('recognizes a skip made by another copy of the package (the brand is Symbol.for)', async () => {
			const foreign = {
				[Symbol.for('bodhi.post-session.skip')]: true,
				reason: 'user opted out',
			} as unknown as PostSessionSkip;
			expect(isPostSessionSkip(foreign)).toBe(true);
			const p = new InMemoryPostSessionPipeline();
			p.register(new TestProcessor('foreign', async () => foreign));
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'foreign')?.detail).toStrictEqual({
				reason: 'run_skipped',
				skipReason: 'user opted out',
			});
		});
	});

	describe('postSessionSkip() and isPostSessionSkip()', () => {
		it('returns a frozen value holding a frozen shallow copy of detail', () => {
			const nested = { a: 1 };
			const detail = { attempt: 1, nested };
			const skip = postSessionSkip('user opted out', detail);
			expect(Object.isFrozen(skip)).toBe(true);
			expect(Object.isFrozen(skip.detail)).toBe(true);
			expect(skip.detail).not.toBe(detail);
			expect(skip.detail?.nested).toBe(nested); // shallow
			expect(skip.reason).toBe('user opted out');
			expect('detail' in postSessionSkip('no detail')).toBe(false);
		});

		it('accepts a detail whose prototype is Object.prototype or null', () => {
			expect(postSessionSkip('x', { a: 1 }).detail).toEqual({ a: 1 });
			const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2 });
			expect(postSessionSkip('x', bare).detail).toEqual({ b: 2 });
		});

		it('throws TypeError for a detail that is a Date, a Map, a class instance or an array', () => {
			class Detail {
				readonly a = 1;
			}
			const notPlain: unknown[] = [new Date(0), new Map([['a', 1]]), new Detail(), [1, 2]];
			for (const detail of notPlain) {
				const make = () => postSessionSkip('x', detail as Record<string, unknown>);
				expect(make).toThrow(TypeError);
				expect(make).toThrow('postSessionSkip: detail must be a plain object when given');
			}
		});

		it('throws TypeError for an empty or non-string reason and for a detail that is not an object', () => {
			expect(() => postSessionSkip('')).toThrow(TypeError);
			expect(() => postSessionSkip(42 as unknown as string)).toThrow(TypeError);
			expect(() => postSessionSkip('x', 'detail' as unknown as Record<string, unknown>)).toThrow(
				TypeError,
			);
			expect(() => postSessionSkip('x', null as unknown as Record<string, unknown>)).toThrow(
				TypeError,
			);
			expect(() => postSessionSkip('x', [] as unknown as Record<string, unknown>)).toThrow(
				TypeError,
			);
		});

		it('isPostSessionSkip is true only for branded values with a string reason', () => {
			expect(isPostSessionSkip(postSessionSkip('x'))).toBe(true);
			expect(isPostSessionSkip({ reason: 'x' })).toBe(false);
			expect(isPostSessionSkip({ [Symbol.for('bodhi.post-session.skip')]: true })).toBe(false);
			expect(isPostSessionSkip({ [Symbol('bodhi.post-session.skip')]: true, reason: 'x' })).toBe(
				false,
			);
			for (const value of [undefined, null, 'x', 1, true]) {
				expect(isPostSessionSkip(value)).toBe(false);
			}
		});

		it('isPostSessionSkip never throws: a value whose inspection throws is not a skip', () => {
			const throwingProxy = new Proxy(
				{},
				{
					get() {
						throw new Error('get trap boom');
					},
				},
			);
			const revoked = Proxy.revocable({}, {});
			revoked.revoke();
			const brandGetter = {
				get [SKIP_BRAND]() {
					throw new Error('brand getter boom');
				},
			};
			const reasonGetter = {
				[SKIP_BRAND]: true,
				get reason() {
					throw new Error('reason getter boom');
				},
			};
			for (const value of [throwingProxy, revoked.proxy, brandGetter, reasonGetter]) {
				expect(() => isPostSessionSkip(value)).not.toThrow();
				expect(isPostSessionSkip(value)).toBe(false);
			}
		});
	});
});
