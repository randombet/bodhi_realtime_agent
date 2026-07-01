import { describe, expect, it, vi } from 'vitest';
import { InMemoryPostSessionPipeline } from '../../../src/post-session/pipeline.js';
import { AnalyticsProcessor } from '../../../src/post-session/processors/analytics.js';
import type {
	PostSessionSnapshot,
	PostSessionSnapshotBuilder,
	PostSessionStores,
} from '../../../src/post-session/types.js';

function builder(stores: PostSessionStores): PostSessionSnapshotBuilder {
	return (reason) => {
		const snapshot: PostSessionSnapshot = {
			sessionId: 's',
			userId: 'u',
			initialAgentName: 'greeter',
			finalAgentName: 'expert',
			transferPath: ['greeter', 'expert'],
			reason,
			startedAt: 0,
			endedAt: 5000,
			durationMs: 5000,
			conversation: { items: [] },
			metrics: { turnCount: 3, toolCallCount: 2, agentTransferCount: 1 },
		};
		return { snapshot, stores };
	};
}

describe('AnalyticsProcessor', () => {
	it('derives a summary from the snapshot and forwards it to the sink', async () => {
		const pipeline = new InMemoryPostSessionPipeline();
		pipeline.register(new AnalyticsProcessor());
		pipeline.freeze();
		const sink = vi.fn();

		const report = await pipeline.dispatch({
			sessionId: 's',
			reason: 'user_hangup',
			build: builder({ analyticsSink: sink }),
		}).report;

		const expected = {
			sessionId: 's',
			userId: 'u',
			reason: 'user_hangup',
			durationMs: 5000,
			initialAgentName: 'greeter',
			finalAgentName: 'expert',
			transferPath: ['greeter', 'expert'],
			turnCount: 3,
			toolCallCount: 2,
			agentTransferCount: 1,
		};
		expect(sink).toHaveBeenCalledWith(expected);
		const result = report.results.find((r) => r.processor === 'analytics');
		expect(result?.status).toBe('completed');
		expect(result?.detail).toEqual(expected);
	});

	it('completes without a sink (summary still on the report)', async () => {
		const pipeline = new InMemoryPostSessionPipeline();
		pipeline.register(new AnalyticsProcessor());
		pipeline.freeze();
		const report = await pipeline.dispatch({ sessionId: 's', reason: 'normal', build: builder({}) })
			.report;
		expect(report.results.find((r) => r.processor === 'analytics')?.status).toBe('completed');
	});
});
