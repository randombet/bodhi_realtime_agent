// SPDX-License-Identifier: MIT

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

	it('admits the run even at zero capacity (memory is required)', async () => {
		const pipeline = createDefaultPostSessionPipeline({ maxConcurrentRuns: 0 });
		const run = pipeline.dispatch({
			sessionId: 's',
			reason: 'normal',
			build: builder({ memoryExtraction: async () => {} }),
		});
		expect(run.outcome).toBe('accepted');
		await run.report;
	});

	it('getDefaultPostSessionPipeline returns a stable singleton', () => {
		expect(getDefaultPostSessionPipeline()).toBe(getDefaultPostSessionPipeline());
	});
});
