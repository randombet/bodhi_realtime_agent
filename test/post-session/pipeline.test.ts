// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { InMemoryPostSessionPipeline } from '../../src/post-session/pipeline.js';
import type {
	PostSessionContext,
	PostSessionReport,
	PostSessionSnapshot,
	PostSessionSnapshotBuilder,
	PostSessionStores,
} from '../../src/post-session/types.js';
import { PostSessionProcessor } from '../../src/post-session/types.js';

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

// biome-ignore lint/suspicious/noConfusingVoidType: mirrors PostSessionProcessor.run — returns a detail object or nothing.
type ProcRun = (ctx: PostSessionContext) => Promise<Record<string, unknown> | void>;

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

		it('admits a required run even at zero capacity', async () => {
			const p = new InMemoryPostSessionPipeline({ maxConcurrentRuns: 0 });
			p.register(new TestProcessor('memory', async () => {}, [], true));
			p.freeze();
			const run = p.dispatch({ sessionId: 's', reason: 'normal', build: makeBuilder('s') });
			const report = await run.report;
			expect(run.outcome).toBe('accepted');
			expect(report.outcome).toBe('accepted');
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
	});
});
