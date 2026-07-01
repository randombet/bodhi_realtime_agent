// Post-Session Processor — runnable verification demo.
//
// This drives the REAL pipeline from `src/post-session/` (not a standalone copy),
// so it cannot drift from production behavior. It registers a few sample
// processors and asserts the design's headline invariants, exiting non-zero on any
// failure (CI-friendly smoke test). For a focused email example, see
// `email-summary.ts`; for exhaustive unit coverage, see
// `test/post-session/pipeline.test.ts`.
//
// Run:  pnpm tsx examples/post-session-processor/post-session-processor-demo.ts
// No keys/network needed.

import { InMemoryPostSessionPipeline } from '../../src/post-session/pipeline.js';
import { PostSessionProcessor } from '../../src/post-session/types.js';
import type {
	PostSessionContext,
	PostSessionReport,
	PostSessionSnapshot,
	PostSessionSnapshotBuilder,
} from '../../src/post-session/types.js';
import type { ConversationItem } from '../../src/types/conversation.js';

// ───────────────────────────────────────────────────────────────────────────
// Email capability (pluggable) + demo-shared state
// ───────────────────────────────────────────────────────────────────────────

interface EmailMessage {
	to: string;
	subject: string;
	body: string;
}
class CapturingEmailSender {
	readonly sent: EmailMessage[] = [];
	async send(message: EmailMessage): Promise<void> {
		this.sent.push(message);
	}
}

// Ordering trace + per-session summary hand-off (demo-level; a real build would use
// an `email`/summary capability on PostSessionStores).
const trace: string[] = [];
const summaries = new Map<string, string>();

// ───────────────────────────────────────────────────────────────────────────
// Sample processors (extend the REAL PostSessionProcessor)
// ───────────────────────────────────────────────────────────────────────────

class SummaryProcessor extends PostSessionProcessor {
	readonly name = 'summary';
	async run(ctx: PostSessionContext) {
		trace.push('summary');
		const text = ctx.conversation.items.map((i) => i.content).join(' | ');
		summaries.set(ctx.sessionId, text);
		return { chars: text.length };
	}
}

class AnalyticsProcessor extends PostSessionProcessor {
	readonly name = 'analytics';
	readonly dependsOn = ['summary'];
	async run(ctx: PostSessionContext) {
		trace.push('analytics');
		return { summaryWasReady: (summaries.get(ctx.sessionId)?.length ?? 0) > 0 };
	}
}

class EmailProcessor extends PostSessionProcessor {
	readonly name = 'email';
	readonly dependsOn = ['summary'];
	constructor(private readonly sender: CapturingEmailSender) {
		super();
	}
	async run(ctx: PostSessionContext) {
		trace.push('email');
		const summary = summaries.get(ctx.sessionId) ?? '';
		const transcript = ctx.conversation.items.map((i) => `${i.role}: ${i.content}`).join('\n');
		const to = `${ctx.userId}@example.com`;
		await this.sender.send({
			to,
			subject: `Your session summary (${ctx.reason})`,
			body: `Summary:\n${summary}\n\n--- Full transcript ---\n${transcript}`,
		});
		return { to };
	}
}

class MemoryProcessor extends PostSessionProcessor {
	readonly name = 'memory';
	readonly required = true;
	async run() {
		trace.push('memory');
	}
}

class FlakyProcessor extends PostSessionProcessor {
	readonly name = 'flaky';
	async run(): Promise<void> {
		trace.push('flaky');
		throw new Error('boom');
	}
}

class DependentProcessor extends PostSessionProcessor {
	readonly name = 'dependent';
	readonly dependsOn = ['flaky'];
	async run() {
		trace.push('dependent'); // should never run
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Harness
// ───────────────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

function makeBuilder(
	sessionId: string,
	opts?: { throwOnBuild?: boolean },
): PostSessionSnapshotBuilder {
	return (reason) => {
		if (opts?.throwOnBuild) throw new Error('snapshot build failed');
		const items: ConversationItem[] = [
			{ role: 'user', content: 'hello', timestamp: 1 },
			{ role: 'assistant', content: 'hi there', timestamp: 2 },
		];
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
			conversation: { items },
			metrics: { turnCount: 1, toolCallCount: 0, agentTransferCount: 0 },
		};
		return { snapshot, stores: {} };
	};
}

const result = (report: PostSessionReport | undefined, name: string) =>
	report?.results.find((r) => r.processor === name);

async function main(): Promise<void> {
	const emailSender = new CapturingEmailSender();

	// ── Scenario 1: ordering, isolation, dependency-skip, email ─────────────
	console.log('\nScenario 1: ordering, isolation, dependency-skip, email');
	{
		trace.length = 0;
		const pipeline = new InMemoryPostSessionPipeline();
		pipeline.register(new SummaryProcessor());
		pipeline.register(new AnalyticsProcessor());
		pipeline.register(new EmailProcessor(emailSender));
		pipeline.register(new MemoryProcessor());
		pipeline.register(new FlakyProcessor());
		pipeline.register(new DependentProcessor());
		pipeline.freeze();

		const report = await pipeline.dispatch({
			sessionId: 's1',
			reason: 'normal',
			build: makeBuilder('s1'),
		}).report;

		check('outcome accepted', report.outcome === 'accepted');
		check('summary ran before analytics', trace.indexOf('summary') < trace.indexOf('analytics'));
		check('summary ran before email', trace.indexOf('summary') < trace.indexOf('email'));
		check('flaky failed (isolated)', result(report, 'flaky')?.status === 'failed');
		check(
			'summary completed despite flaky throw',
			result(report, 'summary')?.status === 'completed',
		);
		check(
			'analytics saw the summary',
			result(report, 'analytics')?.detail?.summaryWasReady === true,
		);
		check(
			'dependent skipped via dependency_failed',
			result(report, 'dependent')?.status === 'skipped' &&
				result(report, 'dependent')?.detail?.reason === 'dependency_failed',
		);
		check('dependent.run never executed', !trace.includes('dependent'));

		const mail = emailSender.sent[0];
		check('exactly one email sent', emailSender.sent.length === 1);
		check('email addressed to the user', mail?.to === 'user-s1@example.com');
		check('email body contains the summary', mail?.body.includes('hello | hi there') === true);
		check(
			'email body contains the transcript',
			mail?.body.includes('user: hello') === true &&
				mail?.body.includes('assistant: hi there') === true,
		);
	}

	// ── Scenario 2: reason preservation ─────────────────────────────────────
	console.log('\nScenario 2: reason preservation');
	{
		let seen: string | undefined;
		class Capture extends PostSessionProcessor {
			readonly name = 'capture';
			async run(ctx: PostSessionContext) {
				seen = ctx.reason;
			}
		}
		const pipeline = new InMemoryPostSessionPipeline();
		pipeline.register(new Capture());
		pipeline.freeze();
		await pipeline.dispatch({
			sessionId: 's2',
			reason: 'reconnect_failed',
			build: makeBuilder('s2'),
		}).report;
		check('caller reason reached the snapshot', seen === 'reconnect_failed');
	}

	// ── Scenario 3: failed_to_start when build throws ───────────────────────
	console.log('\nScenario 3: build throws → failed_to_start');
	{
		const pipeline = new InMemoryPostSessionPipeline();
		const emitted: PostSessionReport[] = [];
		pipeline.events.onProcessed((r) => emitted.push(r));
		pipeline.register(new SummaryProcessor());
		pipeline.freeze();
		const run = pipeline.dispatch({
			sessionId: 's3',
			reason: 'normal',
			build: makeBuilder('s3', { throwOnBuild: true }),
		});
		const report = await run.report;
		check('outcome failed_to_start', report.outcome === 'failed_to_start');
		check('failureReason snapshot_failed', report.failureReason === 'snapshot_failed');
		check('no processors ran', report.results.length === 0);
		check('failed run still emitted', emitted.length === 1);
	}

	// ── Scenario 4: backpressure (bounded-wait model) ───────────────────────
	console.log('\nScenario 4: backpressure');
	{
		// Optional-only run at zero capacity → dropped (queue_overflow), still emits.
		const optPipe = new InMemoryPostSessionPipeline({ maxConcurrentRuns: 0 });
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
		check('dropped run emitted', optEmitted.length === 1 && optEmitted[0].outcome === 'dropped');

		// Required run bounded-waits; with no slot + short budget → required_capacity_timeout.
		const reqPipe = new InMemoryPostSessionPipeline({ maxConcurrentRuns: 0, requiredWaitMs: 20 });
		reqPipe.register(new MemoryProcessor());
		reqPipe.freeze();
		const rep2 = await reqPipe.dispatch({
			sessionId: 'q1',
			reason: 'normal',
			build: makeBuilder('q1'),
		}).report;
		check(
			'required run times out waiting for a slot',
			rep2.outcome === 'dropped' && rep2.failureReason === 'required_capacity_timeout',
		);

		// Capacity 1: a required run waits behind an occupying run, then runs when it frees.
		const waitPipe = new InMemoryPostSessionPipeline({
			maxConcurrentRuns: 1,
			requiredWaitMs: 1000,
		});
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		class Gated extends PostSessionProcessor {
			readonly name = 'gated';
			readonly required = true;
			async run() {
				await gate;
			}
		}
		waitPipe.register(new Gated());
		waitPipe.freeze();
		const first = waitPipe.dispatch({
			sessionId: 'w1',
			reason: 'normal',
			build: makeBuilder('w1'),
		});
		const second = waitPipe.dispatch({
			sessionId: 'w2',
			reason: 'normal',
			build: makeBuilder('w2'),
		});
		check('second required run queued (waiting)', waitPipe.stats().queued === 1);
		release();
		const [r1, r2] = await Promise.all([first.report, second.report]);
		check(
			'both required runs accepted after slot frees',
			r1.outcome === 'accepted' && r2.outcome === 'accepted',
		);
	}

	// ── Scenario 5: freeze() validation ─────────────────────────────────────
	console.log('\nScenario 5: freeze() validation');
	{
		const badDep = new InMemoryPostSessionPipeline();
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
		const badReq = new InMemoryPostSessionPipeline();
		badReq.register(new SummaryProcessor());
		badReq.register(new ReqOnOptional());
		check(
			'required-depends-on-optional rejected at freeze',
			throws(() => badReq.freeze()),
		);
	}

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
