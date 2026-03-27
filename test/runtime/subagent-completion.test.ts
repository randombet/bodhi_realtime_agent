// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	buildCancelledCompletion,
	buildFailureCompletion,
	buildSuccessCompletion,
} from '../../src/runtime/subagent-completion.js';

describe('SubagentCompletion builders', () => {
	describe('buildSuccessCompletion', () => {
		it('builds a success completion with required fields', () => {
			const c = buildSuccessCompletion({
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				result: 'Task done',
				configName: 'coder',
				durationMs: 1500,
			});

			expect(c.status).toBe('success');
			expect(c.summaryText).toBe('Task done');
			expect(c.toolCallId).toBe('tc-1');
			expect(c.workflowId).toBe('wf-1');
			expect(c.metadata.configName).toBe('coder');
			expect(c.metadata.durationMs).toBe(1500);
			expect(c.metadata.lifetime).toBe('ephemeral');
		});

		it('includes optional fields when provided', () => {
			const c = buildSuccessCompletion({
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				result: 'Done',
				configName: 'coder',
				durationMs: 500,
				lifetime: 'persistent_session',
				uiPayload: { card: 'result-card' },
				artifacts: [{ type: 'code', name: 'main.ts', content: 'console.log("hi")' }],
				stepCount: 3,
			});

			expect(c.metadata.lifetime).toBe('persistent_session');
			expect(c.uiPayload).toEqual({ card: 'result-card' });
			expect(c.artifacts).toHaveLength(1);
			expect(c.metadata.stepCount).toBe(3);
		});
	});

	describe('buildFailureCompletion', () => {
		it('builds a failure completion with error prefix', () => {
			const c = buildFailureCompletion({
				toolCallId: 'tc-2',
				workflowId: 'wf-2',
				error: 'timeout exceeded',
				configName: 'researcher',
				durationMs: 30000,
			});

			expect(c.status).toBe('failure');
			expect(c.summaryText).toBe('Error: timeout exceeded');
			expect(c.metadata.configName).toBe('researcher');
		});
	});

	describe('buildCancelledCompletion', () => {
		it('builds a cancelled completion', () => {
			const c = buildCancelledCompletion({
				toolCallId: 'tc-3',
				workflowId: 'wf-3',
				configName: 'coder',
				durationMs: 200,
			});

			expect(c.status).toBe('cancelled');
			expect(c.summaryText).toBe('Task was cancelled.');
		});
	});
});
