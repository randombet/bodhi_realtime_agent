// SPDX-License-Identifier: MIT
//
// Post-Session Processor — executable spec / verification demo.
//
// The pipeline described in `dev_docs/framework/design-post-session-processor.md`
// is not yet implemented in `src/`. This file is a SELF-CONTAINED reference
// implementation of the top-level contracts plus an assertion harness that
// verifies the design's headline invariants actually hold together:
//
//   1. exactly-once dispatch per ended session (re-entrant close → one run)
//   2. dependency ordering (dependsOn runs before dependents)
//   3. failure isolation (one processor throwing never aborts siblings)
//   4. dependency-failed skip
//   5. failed_to_start when the snapshot `build` thunk throws
//   6. reason preservation (caller reason reaches the snapshot)
//   7. an EmailProcessor sends the transcript + summary (via a pluggable sender)
//   8. backpressure: optional run dropped, required run admitted; both still emit
//
// It mirrors the *simplified* design: there is no coordinator and no event
// subscription — the single `closeWithReason` funnel calls `pipeline.dispatch()`
// directly with a `build` thunk, and the close guard provides exactly-once.
//
// Run:  pnpm tsx examples/post-session-processor/post-session-processor-demo.ts
// Exit code is non-zero if any invariant fails (CI-friendly). No keys/network.

// ───────────────────────────────────────────────────────────────────────────
// Contracts (mirrors the design doc — see "Core interfaces")
// ───────────────────────────────────────────────────────────────────────────

type SessionEndReason = 'normal' | 'reconnect_failed' | 'transfer_failed' | (string & {});

interface PostSessionSnapshot {
	readonly sessionId: string;
	readonly userId: string;
	readonly reason: SessionEndReason;
	readonly durationMs: number;
	readonly transcript: readonly { role: string; text: string }[];
}

/** A durable, process-scoped email capability. The demo uses a capturing fake;
 *  production would back this with SMTP / a provider (e.g. the Gmail tooling). */
interface EmailMessage {
	to: string;
	subject: string;
	body: string;
}
interface EmailSender {
	send(message: EmailMessage): Promise<void>;
}
class CapturingEmailSender implements EmailSender {
	readonly sent: EmailMessage[] = [];
	async send(message: EmailMessage): Promise<void> {
		this.sent.push(message);
	}
}

// Durable, process-scoped stores processors write through.
interface PostSessionStores {
	readonly memory: { written: string[] };
	readonly summaries: Map<string, string>;
	readonly email: EmailSender;
}

interface PostSessionCapabilities {
	readonly stores: PostSessionStores;
	readonly signal: AbortSignal;
}

type PostSessionContext = PostSessionSnapshot & PostSessionCapabilities;

// Just a function — no provider object/registry. A throw → failed_to_start.
type PostSessionSnapshotBuilder = (reason: SessionEndReason) => {
	snapshot: PostSessionSnapshot;
	stores: PostSessionStores;
};

interface PostSessionResult {
	readonly processor: string;
	readonly status: 'completed' | 'skipped' | 'failed';
	readonly durationMs: number;
	readonly error?: Error;
	readonly detail?: Record<string, unknown>;
}

abstract class PostSessionProcessor {
	abstract readonly name: string;
	readonly required: boolean = false;
	readonly dependsOn: readonly string[] = [];
	shouldRun(_ctx: PostSessionContext): boolean {
		return true;
	}
	// biome-ignore lint/suspicious/noConfusingVoidType: mirrors the design doc's run() contract — a processor may return a small detail object or nothing.
	abstract run(ctx: PostSessionContext): Promise<Record<string, unknown> | void>;
}

type RunOutcome = 'accepted' | 'dropped' | 'failed_to_start';

interface PostSessionReport {
	readonly sessionId: string;
	readonly outcome: RunOutcome;
	readonly failureReason?: 'queue_overflow' | 'required_capacity_timeout' | 'snapshot_failed';
	readonly results: readonly PostSessionResult[];
	readonly totalDurationMs: number;
}

interface PostSessionRun {
	readonly sessionId: string;
	readonly outcome: RunOutcome;
	readonly report: Promise<PostSessionReport>;
}

interface PostSessionEvents {
	onProcessed(listener: (report: PostSessionReport) => void): () => void;
}

interface PostSessionPipeline {
	register(processor: PostSessionProcessor): void;
	freeze(): void;
	dispatch(input: {
		sessionId: string;
		reason: SessionEndReason;
		build: PostSessionSnapshotBuilder;
	}): PostSessionRun;
	readonly events: PostSessionEvents;
	stats(): { running: number; dropped: number; completed: number; failed: number };
}

// ───────────────────────────────────────────────────────────────────────────
// Reference implementation (minimal, single-process — matches design semantics)
// ───────────────────────────────────────────────────────────────────────────

class InMemoryPipeline implements PostSessionPipeline {
	private readonly processors: PostSessionProcessor[] = [];
	private frozen = false;
	private running = 0;
	private readonly counters = { dropped: 0, completed: 0, failed: 0 };
	private readonly listeners = new Set<(r: PostSessionReport) => void>();

	constructor(private readonly maxConcurrent = 8) {}

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

	/** Validate (unique names, deps exist, no cycles, required ⊄ optional) and freeze. */
	freeze(): void {
		const byName = new Map<string, PostSessionProcessor>();
		for (const p of this.processors) {
			if (byName.has(p.name)) throw new Error(`duplicate processor name: ${p.name}`);
			byName.set(p.name, p);
		}
		for (const p of this.processors) {
			for (const dep of p.dependsOn) {
				const target = byName.get(dep);
				if (!target) throw new Error(`${p.name} depends on unknown processor: ${dep}`);
				if (p.required && !target.required) {
					throw new Error(`required ${p.name} must not depend on optional ${dep}`);
				}
			}
		}
		// cycle detection (DFS)
		const state = new Map<string, 0 | 1 | 2>();
		const visit = (name: string): void => {
			if (state.get(name) === 2) return;
			if (state.get(name) === 1) throw new Error(`dependency cycle at: ${name}`);
			state.set(name, 1);
			for (const dep of byName.get(name)?.dependsOn ?? []) visit(dep);
			state.set(name, 2);
		};
		for (const p of this.processors) visit(p.name);
		this.frozen = true;
	}

	dispatch(input: {
		sessionId: string;
		reason: SessionEndReason;
		build: PostSessionSnapshotBuilder;
	}): PostSessionRun {
		if (!this.frozen) throw new Error('dispatch() before freeze()');

		// (a) snapshot build is inline + bounded; a throw → failed_to_start.
		let built: { snapshot: PostSessionSnapshot; stores: PostSessionStores };
		try {
			built = input.build(input.reason);
		} catch {
			const report = this.terminal(input.sessionId, 'failed_to_start', 'snapshot_failed');
			this.counters.failed++;
			this.emit(report);
			return {
				sessionId: input.sessionId,
				outcome: 'failed_to_start',
				report: Promise.resolve(report),
			};
		}

		// (b) admission. Optional runs are dropped when full; required runs are admitted
		//     (the demo's bounded-wait degenerates to "always admit required").
		const hasRequired = this.processors.some((p) => p.required);
		if (this.running >= this.maxConcurrent && !hasRequired) {
			const report = this.terminal(input.sessionId, 'dropped', 'queue_overflow');
			this.counters.dropped++;
			this.emit(report);
			return { sessionId: input.sessionId, outcome: 'dropped', report: Promise.resolve(report) };
		}

		// (c) accepted — pipeline owns the cancellation signal (and thus the budget).
		const controller = new AbortController();
		const ctx: PostSessionContext = {
			...built.snapshot,
			stores: built.stores,
			signal: controller.signal,
		};
		this.running++;
		const report = this.execute(ctx).finally(() => {
			this.running--;
		});
		return { sessionId: input.sessionId, outcome: 'accepted', report };
	}

	stats() {
		return { running: this.running, ...this.counters };
	}

	private terminal(
		sessionId: string,
		outcome: RunOutcome,
		failureReason: PostSessionReport['failureReason'],
	): PostSessionReport {
		return { sessionId, outcome, failureReason, results: [], totalDurationMs: 0 };
	}

	private emit(report: PostSessionReport): void {
		for (const l of this.listeners) {
			try {
				l(report);
			} catch (err) {
				console.error('[pipeline] onProcessed listener threw (ignored):', err);
			}
		}
	}

	/**
	 * Run processors respecting `dependsOn`, each isolated. Simplified to a
	 * dependency-ordered sequential pass for deterministic logs; the real pipeline
	 * runs independent processors CONCURRENTLY (decided) — see the README.
	 */
	private async execute(ctx: PostSessionContext): Promise<PostSessionReport> {
		const start = Date.now();
		const ordered = this.topoOrder();
		const results: PostSessionResult[] = [];
		const statusByName = new Map<string, PostSessionResult['status']>();

		for (const p of ordered) {
			const t0 = Date.now();

			// dependency-failed skip
			const failedDep = p.dependsOn.find(
				(d) => statusByName.get(d) === 'failed' || statusByName.get(d) === 'skipped',
			);
			if (failedDep) {
				statusByName.set(p.name, 'skipped');
				results.push({
					processor: p.name,
					status: 'skipped',
					durationMs: 0,
					detail: { reason: 'dependency_failed', dependency: failedDep },
				});
				continue;
			}

			// shouldRun() gate (wrapped — a throw is a failure, not an abort)
			let gate = true;
			try {
				gate = p.shouldRun(ctx);
			} catch (err) {
				statusByName.set(p.name, 'failed');
				results.push({
					processor: p.name,
					status: 'failed',
					durationMs: Date.now() - t0,
					error: err as Error,
					detail: { reason: 'shouldRun_threw' },
				});
				continue;
			}
			if (!gate) {
				statusByName.set(p.name, 'skipped');
				results.push({
					processor: p.name,
					status: 'skipped',
					durationMs: 0,
					detail: { reason: 'shouldRun_false' },
				});
				continue;
			}

			// run() — isolated
			try {
				const detail = await p.run(ctx);
				statusByName.set(p.name, 'completed');
				results.push({
					processor: p.name,
					status: 'completed',
					durationMs: Date.now() - t0,
					detail: detail ?? undefined,
				});
			} catch (err) {
				statusByName.set(p.name, 'failed');
				results.push({
					processor: p.name,
					status: 'failed',
					durationMs: Date.now() - t0,
					error: err as Error,
				});
			}
		}

		for (const r of results)
			r.status === 'failed' ? this.counters.failed++ : this.counters.completed++;
		const report: PostSessionReport = {
			sessionId: ctx.sessionId,
			outcome: 'accepted',
			results,
			totalDurationMs: Date.now() - start,
		};
		this.emit(report);
		return report;
	}

	/** Stable topological order, registration order as the tie-break. */
	private topoOrder(): PostSessionProcessor[] {
		const byName = new Map(this.processors.map((p) => [p.name, p]));
		const out: PostSessionProcessor[] = [];
		const done = new Set<string>();
		const visit = (p: PostSessionProcessor): void => {
			if (done.has(p.name)) return;
			for (const d of p.dependsOn) {
				const dep = byName.get(d);
				if (dep) visit(dep);
			}
			done.add(p.name);
			out.push(p);
		};
		for (const p of this.processors) visit(p);
		return out;
	}
}

/**
 * Stand-in for `SessionManager.closeWithReason` — the single CLOSED funnel.
 * Idempotent per session (re-entrant close → one dispatch), and the only caller
 * of `pipeline.dispatch`. No coordinator, no `session.close` subscription.
 */
class SessionCloseDriver {
	private readonly closing = new Set<string>();
	private readonly runs = new Map<string, PostSessionRun>();

	constructor(private readonly pipeline: PostSessionPipeline) {}

	/** Phase 1 (guard) + phase 4 (dispatch). Finalizers (phase 2) and onSessionEnd
	 *  (phase 3) are elided in the demo. Returns the run handle. */
	closeWithReason(
		sessionId: string,
		reason: SessionEndReason,
		build: PostSessionSnapshotBuilder,
	): PostSessionRun | undefined {
		if (this.closing.has(sessionId)) return this.runs.get(sessionId); // idempotent no-op
		this.closing.add(sessionId);
		const run = this.pipeline.dispatch({ sessionId, reason, build });
		this.runs.set(sessionId, run);
		return run;
	}

	/** Drain bridge: await this session's run (drain mode awaits before exit). */
	async drainSession(sessionId: string): Promise<PostSessionReport | undefined> {
		return this.runs.get(sessionId)?.report;
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Sample processors
// ───────────────────────────────────────────────────────────────────────────

const trace: string[] = [];

class SummaryProcessor extends PostSessionProcessor {
	readonly name = 'summary';
	async run(ctx: PostSessionContext) {
		trace.push('summary');
		const text = ctx.transcript.map((t) => t.text).join(' | ');
		ctx.stores.summaries.set(ctx.sessionId, text);
		return { chars: text.length };
	}
}

// Reads the summary the SummaryProcessor wrote → ordering matters.
class AnalyticsProcessor extends PostSessionProcessor {
	readonly name = 'analytics';
	readonly dependsOn = ['summary'];
	async run(ctx: PostSessionContext) {
		trace.push('analytics');
		const summary = ctx.stores.summaries.get(ctx.sessionId) ?? '';
		return { summaryWasReady: summary.length > 0 };
	}
}

// Emails the transcript + summary. Depends on `summary` so the body has it.
class EmailProcessor extends PostSessionProcessor {
	readonly name = 'email';
	readonly dependsOn = ['summary'];
	async run(ctx: PostSessionContext) {
		trace.push('email');
		const summary = ctx.stores.summaries.get(ctx.sessionId) ?? '';
		const transcript = ctx.transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
		const to = `${ctx.userId}@example.com`;
		await ctx.stores.email.send({
			to,
			subject: `Your session summary (${ctx.reason})`,
			body: `Summary:\n${summary}\n\n--- Full transcript ---\n${transcript}`,
		});
		return { to, summaryChars: summary.length, transcriptLines: ctx.transcript.length };
	}
}

// Required: never optionally shed; preserves "memory attempted" under drain.
class MemoryProcessor extends PostSessionProcessor {
	readonly name = 'memory';
	readonly required = true;
	async run(ctx: PostSessionContext) {
		trace.push('memory');
		ctx.stores.memory.written.push(`facts:${ctx.userId}:${ctx.reason}`);
	}
}

class FlakyProcessor extends PostSessionProcessor {
	readonly name = 'flaky';
	async run() {
		trace.push('flaky');
		throw new Error('boom');
	}
}

// Depends on the flaky one → must be skipped (dependency_failed).
class DependentProcessor extends PostSessionProcessor {
	readonly name = 'dependent';
	readonly dependsOn = ['flaky'];
	async run() {
		trace.push('dependent'); // should never run
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Verification harness
// ───────────────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean): void {
	const mark = cond ? '✓' : '✗';
	if (!cond) failures++;
	console.log(`  ${mark} ${name}`);
}

// `out.stores` is populated on build() so a scenario can inspect what processors wrote.
function makeBuilder(
	sessionId: string,
	opts?: { throwOnBuild?: boolean; out?: { stores?: PostSessionStores } },
): PostSessionSnapshotBuilder {
	return (reason) => {
		if (opts?.throwOnBuild) throw new Error('snapshot build failed');
		const snapshot: PostSessionSnapshot = {
			sessionId,
			userId: `user-${sessionId}`,
			reason,
			durationMs: 1234,
			transcript: [
				{ role: 'user', text: 'hello' },
				{ role: 'assistant', text: 'hi there' },
			],
		};
		const stores: PostSessionStores = {
			memory: { written: [] },
			summaries: new Map(),
			email: new CapturingEmailSender(),
		};
		if (opts?.out) opts.out.stores = stores;
		return { snapshot, stores };
	};
}

async function main(): Promise<void> {
	const pipeline = new InMemoryPipeline();
	pipeline.register(new SummaryProcessor());
	pipeline.register(new AnalyticsProcessor());
	pipeline.register(new EmailProcessor());
	pipeline.register(new MemoryProcessor());
	pipeline.register(new FlakyProcessor());
	pipeline.register(new DependentProcessor());
	pipeline.freeze();

	const driver = new SessionCloseDriver(pipeline);

	// The single process-scoped completion channel. Every finished run emits here
	// exactly once — we tally to verify that at the end.
	const emitted: PostSessionReport[] = [];
	pipeline.events.onProcessed((r) => {
		emitted.push(r);
	});

	// ── Scenario 1: happy path + dedupe + ordering + isolation + EMAIL ──────
	console.log('\nScenario 1: end a session (ordering, isolation, email, dedupe)');
	{
		trace.length = 0;
		const out: { stores?: PostSessionStores } = {};
		// Re-entrant close (e.g. close() racing a reconnect-fail path) → one dispatch.
		driver.closeWithReason('s1', 'normal', makeBuilder('s1', { out }));
		driver.closeWithReason('s1', 'normal', makeBuilder('s1'));

		const report = await driver.drainSession('s1');
		check('report produced', !!report);
		check('outcome accepted', report?.outcome === 'accepted');
		check(
			'dispatched exactly once (memory ran once)',
			trace.filter((t) => t === 'memory').length === 1,
		);
		check('summary ran before analytics', trace.indexOf('summary') < trace.indexOf('analytics'));
		check('summary ran before email', trace.indexOf('summary') < trace.indexOf('email'));

		const byName = (n: string) => report?.results.find((r) => r.processor === n);
		check('flaky failed (isolated)', byName('flaky')?.status === 'failed');
		check('summary still completed despite flaky throw', byName('summary')?.status === 'completed');
		check(
			'analytics saw the summary (ordering honored)',
			byName('analytics')?.detail?.summaryWasReady === true,
		);
		check(
			'dependent skipped via dependency_failed',
			byName('dependent')?.status === 'skipped' &&
				byName('dependent')?.detail?.reason === 'dependency_failed',
		);
		check('dependent.run never executed', !trace.includes('dependent'));

		// Email: exactly one message, addressed correctly, containing BOTH summary and transcript.
		const sender = out.stores?.email as CapturingEmailSender | undefined;
		const mail = sender?.sent[0];
		check('email completed', byName('email')?.status === 'completed');
		check('exactly one email sent', sender?.sent.length === 1);
		check('email addressed to the user', mail?.to === 'user-s1@example.com');
		check('email body contains the summary', mail?.body.includes('hello | hi there') === true);
		check(
			'email body contains the transcript',
			mail?.body.includes('user: hello') === true &&
				mail?.body.includes('assistant: hi there') === true,
		);
	}

	// ── Scenario 2: reason preservation across a failure path ───────────────
	console.log('\nScenario 2: reason preservation (reconnect_failed)');
	{
		const out: { stores?: PostSessionStores } = {};
		driver.closeWithReason('s2', 'reconnect_failed', makeBuilder('s2', { out }));
		const report = await driver.drainSession('s2');
		check(
			'memory completed for s2',
			report?.results.find((r) => r.processor === 'memory')?.status === 'completed',
		);
		// MemoryProcessor wrote `facts:<user>:<reason>` → the caller reason must appear.
		check(
			'caller reason reached the snapshot',
			out.stores?.memory.written.some((w) => w.endsWith(':reconnect_failed')) === true,
		);
		// The reason also shows up in the email subject.
		const sender = out.stores?.email as CapturingEmailSender | undefined;
		check(
			'email subject carries the reason',
			sender?.sent[0]?.subject.includes('reconnect_failed') === true,
		);
	}

	// ── Scenario 3: failed_to_start when the build thunk throws ──────────────
	console.log('\nScenario 3: build thunk throws → failed_to_start');
	{
		driver.closeWithReason('s3', 'normal', makeBuilder('s3', { throwOnBuild: true }));
		const report = await driver.drainSession('s3');
		check('outcome failed_to_start', report?.outcome === 'failed_to_start');
		check('failureReason snapshot_failed', report?.failureReason === 'snapshot_failed');
		check('no processors ran', (report?.results.length ?? -1) === 0);
		check('report still produced (no hang)', !!report);
	}

	// ── Scenario 4: backpressure — optional dropped, required admitted ───────
	console.log('\nScenario 4: backpressure (capacity = 0)');
	{
		// optional-only pipeline at zero capacity → drop. A `dropped` run must STILL
		// emit through the single completion channel (not only accepted runs).
		const optPipe = new InMemoryPipeline(0);
		const optEmitted: PostSessionReport[] = [];
		optPipe.events.onProcessed((r) => optEmitted.push(r));
		optPipe.register(new SummaryProcessor());
		optPipe.freeze();
		const rep1 = await optPipe.dispatch({
			sessionId: 'o1',
			reason: 'normal',
			build: makeBuilder('o1'),
		}).report;
		check(
			'optional run dropped at capacity 0',
			rep1.outcome === 'dropped' && rep1.failureReason === 'queue_overflow',
		);
		check(
			'dropped run emitted through pipeline.events',
			optEmitted.length === 1 && optEmitted[0].outcome === 'dropped',
		);

		// pipeline containing a required processor → admitted even at zero capacity
		const reqPipe = new InMemoryPipeline(0);
		const reqEmitted: PostSessionReport[] = [];
		reqPipe.events.onProcessed((r) => reqEmitted.push(r));
		reqPipe.register(new MemoryProcessor());
		reqPipe.freeze();
		const rep2 = await reqPipe.dispatch({
			sessionId: 'q1',
			reason: 'normal',
			build: makeBuilder('q1'),
		}).report;
		check('required run admitted at capacity 0', rep2.outcome === 'accepted');
		check(
			'accepted required run emitted through pipeline.events',
			reqEmitted.length === 1 && reqEmitted[0].outcome === 'accepted',
		);
	}

	// ── Scenario 5: freeze() validation rejects bad graphs ───────────────────
	console.log('\nScenario 5: freeze() validation');
	{
		const badDep = new InMemoryPipeline();
		badDep.register(new AnalyticsProcessor()); // dependsOn 'summary' (not registered)
		check(
			'missing dependency rejected at freeze',
			throws(() => badDep.freeze()),
		);

		class ReqOnOptional extends PostSessionProcessor {
			readonly name = 'req';
			readonly required = true;
			readonly dependsOn = ['summary'];
			async run() {}
		}
		const badReq = new InMemoryPipeline();
		badReq.register(new SummaryProcessor());
		badReq.register(new ReqOnOptional());
		check(
			'required-depends-on-optional rejected at freeze',
			throws(() => badReq.freeze()),
		);
	}

	// ── Final: the process-scoped events channel saw every run exactly once ──
	console.log('\nFinal: completion channel (pipeline.events)');
	// s1, s2, s3 ran on the shared `pipeline`/`driver` (Scenario 4 used its own).
	check('onProcessed fired once per run on the shared pipeline', emitted.length === 3);
	check(
		'every emitted report has an outcome',
		emitted.every((r) => !!r.outcome),
	);

	console.log('');
	if (failures > 0) {
		console.error(`FAILED: ${failures} invariant check(s) failed.`);
		process.exit(1);
	}
	console.log('All post-session-processor invariants verified ✓');
}

function throws(fn: () => void): boolean {
	try {
		fn();
		return false;
	} catch {
		return true;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
