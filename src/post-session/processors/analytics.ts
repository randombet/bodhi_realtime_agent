// SPDX-License-Identifier: MIT

import { PostSessionProcessor } from '../types.js';
import type { PostSessionContext } from '../types.js';

/**
 * Derives a small per-session analytics summary from the immutable snapshot
 * (duration, turn/tool/transfer counts, agent path, close reason) and, if an
 * `analyticsSink` capability is provided via `ctx.stores`, forwards it there.
 * Pure and reentrant — reads only snapshot data. The summary is also returned as
 * this processor's `detail`, so it is visible on `pipeline.events.onProcessed`.
 *
 * Optional building block: register it on a pipeline where analytics are wanted.
 * (Not part of the default pipeline.)
 */
export class AnalyticsProcessor extends PostSessionProcessor {
	readonly name = 'analytics';

	async run(ctx: PostSessionContext): Promise<Record<string, unknown>> {
		const summary: Record<string, unknown> = {
			sessionId: ctx.sessionId,
			userId: ctx.userId,
			reason: ctx.reason,
			durationMs: ctx.durationMs,
			initialAgentName: ctx.initialAgentName,
			finalAgentName: ctx.finalAgentName,
			transferPath: ctx.transferPath,
			turnCount: ctx.metrics.turnCount,
			toolCallCount: ctx.metrics.toolCallCount,
			agentTransferCount: ctx.metrics.agentTransferCount,
		};
		await ctx.stores.analyticsSink?.(summary);
		return summary;
	}
}
