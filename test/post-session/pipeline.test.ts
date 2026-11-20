import { describe, expect, it } from 'vitest';
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

		it('a thrown skip is failed, not skipped: throw always means failed', async () => {
			const thrown = postSessionSkip('user opted out');
			const p = new InMemoryPostSessionPipeline();
			p.register(
				new TestProcessor('thrower', async () => {
					throw thrown;
				}),
			);
			p.freeze();
			const report = await p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') })
				.report;
			expect(result(report, 'thrower')?.status).toBe('failed');
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
	});
});
