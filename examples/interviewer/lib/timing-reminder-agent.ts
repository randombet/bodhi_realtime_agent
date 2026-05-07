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
		private readonly state: InterviewState,
		options: TimingReminderOptions = {},
	) {
		this.totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
		this.intervalMs = options.intervalMs ?? FIVE_MINUTES_MS;
	}

	onStart(ctx: BackgroundAgentContext): void {
		const startedAt = Date.now();
		const log = ctx.log.bind(ctx);
		log(`started: budget=${this.totalBudgetMs}ms interval=${this.intervalMs}ms`);

		const tick = () => {
			// Stop nudging once the interview is done. The interval keeps running
			// (it's harmless), but we no longer publish.
			if (this.state.phase === 'completed') return;

			const elapsedMs = Date.now() - startedAt;
			const remainingMin = Math.max(0, Math.round((this.totalBudgetMs - elapsedMs) / 60_000));
			if (remainingMin <= 0) {
				log('budget elapsed; suppressing further reminders');
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

		const handle = setInterval(tick, this.intervalMs);
		// Cancel cleanly on session close (or other abort signals).
		ctx.signal.addEventListener('abort', () => {
			clearInterval(handle);
			log('signal aborted; interval cleared');
		});
	}

	onStop(reason: string): void {
		// Nothing extra to do — the AbortSignal listener above already cleared
		// the interval. This hook is here to log the reason for visibility.
		void reason;
	}
}
