/**
 * Tests for `examples/interviewer/lib/timing-reminder-agent.ts`. The agent
 * is a thin BackgroundAgent — most of its behavior is "fire setInterval,
 * call ctx.publish, stop on terminal conditions." Verifies that stop
 * conditions actually clear the interval (not just no-op tick).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterviewState } from '../../examples/interviewer/lib/interview-state.js';
import { TimingReminderBackgroundAgent } from '../../examples/interviewer/lib/timing-reminder-agent.js';
import type { BackgroundAgentContext } from '../../src/agent/background-agent.js';

interface FakeCtx {
	ctx: BackgroundAgentContext;
	publishes: Array<{ label: string; text: string; priority?: string; dedupKey?: string }>;
	logs: string[];
	abortController: AbortController;
}

function makeFakeCtx(): FakeCtx {
	const publishes: FakeCtx['publishes'] = [];
	const logs: string[] = [];
	const abortController = new AbortController();
	const ctx: BackgroundAgentContext = {
		sessionId: 'sess',
		userId: 'user',
		publish: (n) => {
			publishes.push({ label: n.label, text: n.text, priority: n.priority, dedupKey: n.dedupKey });
		},
		signal: abortController.signal,
		session: { phase: 'active', activeAgent: 'interviewer' },
		log: (msg) => {
			logs.push(msg);
		},
	};
	return { ctx, publishes, logs, abortController };
}

function makeState(phase: InterviewState['phase'] = 'questioning'): InterviewState {
	// Minimal stub — the agent only reads `state.phase`.
	return { phase } as unknown as InterviewState;
}

describe('TimingReminderBackgroundAgent', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('publishes a reminder on each interval tick', () => {
		const state = makeState('questioning');
		const fake = makeFakeCtx();
		const agent = new TimingReminderBackgroundAgent(state, {
			totalBudgetMs: 30 * 60_000,
			intervalMs: 5 * 60_000,
		});
		agent.onStart(fake.ctx);

		vi.advanceTimersByTime(5 * 60_000);
		expect(fake.publishes).toHaveLength(1);
		expect(fake.publishes[0].label).toBe('TIME REMINDER');
		expect(fake.publishes[0].priority).toBe('high');
		expect(fake.publishes[0].dedupKey).toBe('time-reminder');

		vi.advanceTimersByTime(5 * 60_000);
		expect(fake.publishes).toHaveLength(2);
	});

	it('stops the interval (not just suppresses) when state.phase === "completed"', () => {
		const state = makeState('questioning');
		const fake = makeFakeCtx();
		const agent = new TimingReminderBackgroundAgent(state, {
			totalBudgetMs: 30 * 60_000,
			intervalMs: 5 * 60_000,
		});
		agent.onStart(fake.ctx);

		// First tick fires while still active.
		vi.advanceTimersByTime(5 * 60_000);
		expect(fake.publishes).toHaveLength(1);

		// Interview completes, then second tick.
		state.phase = 'completed';
		vi.advanceTimersByTime(5 * 60_000);
		// No new publish — we're past the terminal branch.
		expect(fake.publishes).toHaveLength(1);

		// Third tick: if the interval were merely no-op'd, we'd still see
		// vi.getTimerCount() include it. After our fix, the interval is
		// cleared, so no further timers should fire.
		vi.advanceTimersByTime(5 * 60_000);
		expect(fake.publishes).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);

		// And the stop log was emitted exactly once.
		const stopLogs = fake.logs.filter((l) => l.startsWith('stopped:'));
		expect(stopLogs).toHaveLength(1);
		expect(stopLogs[0]).toContain('phase=completed');
	});

	it('stops the interval when the wall-clock budget is exhausted', () => {
		const state = makeState('questioning');
		const fake = makeFakeCtx();
		const agent = new TimingReminderBackgroundAgent(state, {
			totalBudgetMs: 2 * 60_000, // 2-minute budget
			intervalMs: 60_000, // 1-minute ticks
		});
		agent.onStart(fake.ctx);

		// Tick 1 (1 min in): 1 min remaining → publish.
		vi.advanceTimersByTime(60_000);
		expect(fake.publishes).toHaveLength(1);

		// Tick 2 (2 min in): 0 min remaining → stop.
		vi.advanceTimersByTime(60_000);
		// No new publish; interval cleared.
		expect(fake.publishes).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);

		// Tick 3+: confirm no further timers exist (no spam).
		vi.advanceTimersByTime(10 * 60_000);
		const elapsedLogs = fake.logs.filter((l) => l.startsWith('stopped: budget elapsed'));
		expect(elapsedLogs).toHaveLength(1); // logged once, not on every tick
	});

	it('stops the interval when ctx.signal is aborted (session close)', () => {
		const state = makeState('questioning');
		const fake = makeFakeCtx();
		const agent = new TimingReminderBackgroundAgent(state, {
			totalBudgetMs: 30 * 60_000,
			intervalMs: 60_000,
		});
		agent.onStart(fake.ctx);

		vi.advanceTimersByTime(60_000);
		expect(fake.publishes).toHaveLength(1);

		fake.abortController.abort();

		vi.advanceTimersByTime(60 * 60_000);
		expect(fake.publishes).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);

		const stopLogs = fake.logs.filter((l) => l.startsWith('stopped: signal aborted'));
		expect(stopLogs).toHaveLength(1);
	});
});
