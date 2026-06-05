// SPDX-License-Identifier: MIT

/**
 * TimingReminderBackgroundAgent — wall-clock reminder for the interviewer demo.
 *
 * Periodically nudges the live LLM with a remaining-time reminder (e.g.
 * "About 25 minutes remain in this interview"). Stops nudging once the
 * interview state is `'completed'`.
 *
 * Cancellation:
 *   - `ctx.signal` aborts on session close. The interval is cleared via the
 *     signal's `addEventListener('abort', …)`, so the agent does not need
 *     to manually unregister anywhere.
 *   - `cancelOnTransfer` is **false** (the default). Time-remaining is a
 *     property of the call, not of any single main agent — surviving a
 *     transfer (e.g. interviewer → recruiter handoff) is the desired
 *     behavior.
 *
 * Dedup:
 *   - Uses `dedupKey: 'time-reminder'` so if multiple ticks land in the
 *     queue (e.g. during a long candidate answer), only the latest one is
 *     delivered. Stale "30 minutes left" doesn't follow "20 minutes left".
 *
 * The actor framework handles audio-gating, priority, label normalization,
 * and the wire wrapping (`[TIME REMINDER]: ...`). This agent is just
 * "publish on a wall clock."
 */

import type { BackgroundAgent, BackgroundAgentContext } from '../../../src/agent/background-agent.js';
import type { InterviewState } from './interview-state.js';

const FIVE_MINUTES_MS = 5 * 60_000;
const DEFAULT_TOTAL_BUDGET_MS = 30 * 60_000;

export interface TimingReminderOptions {
	/** Total wall-clock budget for the interview in milliseconds. Default: 30 min. */
	totalBudgetMs?: number;
	/** Interval between reminders in milliseconds. Default: 5 min. */
	intervalMs?: number;
}

export class TimingReminderBackgroundAgent implements BackgroundAgent {
	readonly name = 'timing-reminder';
	readonly cancelOnTransfer = false;

	private readonly totalBudgetMs: number;
	private readonly intervalMs: number;

	constructor(
		// Only `state.phase` is read (see onStart), so accept any state that
		// exposes it — lets demos with their own state shape (e.g. project-deepdive)
		// reuse this agent without a type cast.
		private readonly state: Pick<InterviewState, 'phase'>,
		options: TimingReminderOptions = {},
	) {
		this.totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
		this.intervalMs = options.intervalMs ?? FIVE_MINUTES_MS;
	}

	onStart(ctx: BackgroundAgentContext): void {
		const startedAt = Date.now();
		const log = ctx.log.bind(ctx);
		log(`started: budget=${this.totalBudgetMs}ms interval=${this.intervalMs}ms`);

		// Forward declaration so `tick` can clearInterval(handle) when it
		// detects a terminal condition (interview completed or budget elapsed).
		let handle: ReturnType<typeof setInterval> | null = null;
		const stop = (reason: string) => {
			if (handle !== null) {
				clearInterval(handle);
				handle = null;
				log(`stopped: ${reason}`);
			}
		};

		const tick = () => {
			// Hard stop once the interview is done — clear the interval so we
			// don't keep ticking (and pinning the event loop) until session close.
			if (this.state.phase === 'completed') {
				stop('interview phase=completed');
				return;
			}

			const elapsedMs = Date.now() - startedAt;
			const remainingMin = Math.max(0, Math.round((this.totalBudgetMs - elapsedMs) / 60_000));
			if (remainingMin <= 0) {
				// Budget exhausted: clear the interval so we don't log "elapsed"
				// every interval forever.
				stop('budget elapsed');
				return;
			}

			ctx.publish({
				label: 'TIME REMINDER',
				text:
					`Wall-clock checkpoint: about ${remainingMin} minute(s) remain in this interview. ` +
					'Briefly remind the candidate of the time remaining in one short sentence, ' +
					'then return to the active interview question.',
				priority: 'high',
				dedupKey: 'time-reminder',
			});
			log(`emitted reminder: ${remainingMin} min remaining`);
		};

		handle = setInterval(tick, this.intervalMs);
		// Cancel cleanly on session close (or other abort signals).
		ctx.signal.addEventListener('abort', () => stop('signal aborted'));
	}

	onStop(reason: string): void {
		// The AbortSignal listener above already cleared the interval; the
		// terminal-condition branches in `tick` may also have cleared it. This
		// hook just exists to surface the close reason in logs.
		void reason;
	}
}
