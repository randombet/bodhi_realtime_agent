import { describe, expect, it, vi } from 'vitest';
import {
	createDefaultPostSessionPipeline,
	getDefaultPostSessionPipeline,
} from '../../src/post-session/default-pipeline.js';
import type {
	PostSessionSnapshot,
	PostSessionSnapshotBuilder,
	PostSessionStores,
} from '../../src/post-session/types.js';

function builder(stores: PostSessionStores): PostSessionSnapshotBuilder {
	return (reason) => {
		const snapshot: PostSessionSnapshot = {
			sessionId: 's',
			userId: 'u',
			initialAgentName: 'a',
			finalAgentName: 'a',
			transferPath: ['a'],
			reason,
			startedAt: 0,
			endedAt: 1,
			durationMs: 1,
			conversation: { items: [] },
			metrics: { turnCount: 0, toolCallCount: 0, agentTransferCount: 0 },
		};
		return { snapshot, stores };
	};
}

describe('default post-session pipeline', () => {
	it('runs the memory-distillation processor via the memoryExtraction capability', async () => {
		const pipeline = createDefaultPostSessionPipeline();
		const extract = vi.fn(async () => {});
		const report = await pipeline.dispatch({
			sessionId: 's',
			reason: 'normal',
			build: builder({ memoryExtraction: extract }),
		}).report;

		expect(extract).toHaveBeenCalledOnce();
		const memory = report.results.find((r) => r.processor === 'memory-distillation');
		expect(memory?.status).toBe('completed');
		expect(memory?.detail).toEqual({ extracted: true });
	});

	it('skips memory-distillation when no extraction capability is provided', async () => {
		const pipeline = createDefaultPostSessionPipeline();
		const report = await pipeline.dispatch({
			sessionId: 's',
			reason: 'normal',
			build: builder({}),
		}).report;
		const memory = report.results.find((r) => r.processor === 'memory-distillation');
		expect(memory?.status).toBe('skipped');
	});

	it('memory run bounded-waits at capacity rather than being dropped', async () => {
		// Capacity 1 + generous wait: the required memory run queues behind an
		// occupying run and completes once a slot frees (not dropped like optional).
		const pipeline = createDefaultPostSessionPipeline({
			maxConcurrentRuns: 1,
			requiredWaitMs: 1000,
		});
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const first = pipeline.dispatch({
			sessionId: 's1',
			reason: 'normal',
			build: builder({ memoryExtraction: () => gate }),
		});
		const second = pipeline.dispatch({
			sessionId: 's2',
			reason: 'normal',
			build: builder({ memoryExtraction: async () => {} }),
		});
		expect(second.outcome).toBe('accepted');
		release();
		const [r1, r2] = await Promise.all([first.report, second.report]);
		expect(r1.outcome).toBe('accepted');
		expect(r2.outcome).toBe('accepted');
	});

	it('getDefaultPostSessionPipeline returns a stable singleton', () => {
		expect(getDefaultPostSessionPipeline()).toBe(getDefaultPostSessionPipeline());
	});
});
