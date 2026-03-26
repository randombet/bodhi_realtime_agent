// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import type { RecoverableWorkflow } from '../../src/runtime/reconnect-recovery.js';
import { ReconnectRecovery } from '../../src/runtime/reconnect-recovery.js';

describe('ReconnectRecovery', () => {
	let recovery: ReconnectRecovery;

	beforeEach(() => {
		recovery = new ReconnectRecovery();
	});

	// -- Workflow tracking ---------------------------------------------------

	describe('workflow tracking', () => {
		it('tracks and retrieves workflows', () => {
			const wf: RecoverableWorkflow = {
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				configName: 'coder',
				lifetime: 'ephemeral',
				state: 'running',
				startedAt: Date.now(),
			};

			recovery.trackWorkflow(wf);

			expect(recovery.hasWorkflow('tc-1')).toBe(true);
			expect(recovery.workflowCount).toBe(1);
			expect(recovery.getRecoverableWorkflows()).toHaveLength(1);
			expect(recovery.getRecoverableWorkflows()[0].configName).toBe('coder');
		});

		it('updates workflow state', () => {
			recovery.trackWorkflow({
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				configName: 'coder',
				lifetime: 'ephemeral',
				state: 'running',
				startedAt: Date.now(),
			});

			recovery.updateWorkflowState('tc-1', 'waiting_input', 'What file?');

			const workflows = recovery.getRecoverableWorkflows();
			expect(workflows[0].state).toBe('waiting_input');
			expect(workflows[0].pendingQuestion).toBe('What file?');
		});

		it('removes workflow on terminal state', () => {
			recovery.trackWorkflow({
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				configName: 'coder',
				lifetime: 'ephemeral',
				state: 'running',
				startedAt: Date.now(),
			});

			recovery.removeWorkflow('tc-1');

			expect(recovery.hasWorkflow('tc-1')).toBe(false);
			expect(recovery.workflowCount).toBe(0);
		});

		it('recovers running workflows after reconnect', () => {
			recovery.trackWorkflow({
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				configName: 'coder',
				lifetime: 'persistent_session',
				state: 'running',
				startedAt: Date.now(),
			});
			recovery.trackWorkflow({
				toolCallId: 'tc-2',
				workflowId: 'wf-2',
				configName: 'researcher',
				lifetime: 'ephemeral',
				state: 'waiting_input',
				pendingQuestion: 'Which paper?',
				startedAt: Date.now(),
			});

			// Simulate reconnect: get recoverable workflows
			const recoverable = recovery.getRecoverableWorkflows();
			expect(recoverable).toHaveLength(2);

			const running = recoverable.find((w) => w.state === 'running');
			const waiting = recoverable.find((w) => w.state === 'waiting_input');
			expect(running?.configName).toBe('coder');
			expect(waiting?.pendingQuestion).toBe('Which paper?');
		});
	});

	// -- Dedup: tool results ------------------------------------------------

	describe('tool result dedup', () => {
		it('detects duplicate tool result delivery', () => {
			expect(recovery.isDuplicateToolResult('tc-1')).toBe(false);

			recovery.markToolResultDelivered('tc-1');

			expect(recovery.isDuplicateToolResult('tc-1')).toBe(true);
			expect(recovery.isDuplicateToolResult('tc-2')).toBe(false);
		});
	});

	// -- Dedup: terminal workflow events ------------------------------------

	describe('terminal event dedup', () => {
		it('detects duplicate terminal workflow events', () => {
			expect(recovery.isDuplicateTerminalEvent('wf-1')).toBe(false);

			recovery.markTerminalEvent('wf-1');

			expect(recovery.isDuplicateTerminalEvent('wf-1')).toBe(true);
		});
	});

	// -- Dedup: interaction responses ----------------------------------------

	describe('interaction response dedup', () => {
		it('detects duplicate interaction responses', () => {
			expect(recovery.isDuplicateResponse('req-1')).toBe(false);

			recovery.markResponseApplied('req-1');

			expect(recovery.isDuplicateResponse('req-1')).toBe(true);
		});
	});

	// -- Dedup: transfers ---------------------------------------------------

	describe('transfer dedup', () => {
		it('detects duplicate transfer completions', () => {
			expect(recovery.isDuplicateTransfer('corr-1')).toBe(false);

			recovery.markTransferCompleted('corr-1');

			expect(recovery.isDuplicateTransfer('corr-1')).toBe(true);
		});
	});

	// -- Session close clears state -----------------------------------------

	describe('session close', () => {
		it('clears all recovery state on close', () => {
			recovery.trackWorkflow({
				toolCallId: 'tc-1',
				workflowId: 'wf-1',
				configName: 'coder',
				lifetime: 'ephemeral',
				state: 'running',
				startedAt: Date.now(),
			});
			recovery.markToolResultDelivered('tc-1');
			recovery.markTerminalEvent('wf-1');
			recovery.markResponseApplied('req-1');
			recovery.markTransferCompleted('corr-1');

			recovery.clear();

			expect(recovery.workflowCount).toBe(0);
			expect(recovery.isDuplicateToolResult('tc-1')).toBe(false);
			expect(recovery.isDuplicateTerminalEvent('wf-1')).toBe(false);
			expect(recovery.isDuplicateResponse('req-1')).toBe(false);
			expect(recovery.isDuplicateTransfer('corr-1')).toBe(false);
		});
	});

	// -- Duplicate replay inputs ignored deterministically ------------------

	describe('duplicate replay behavior', () => {
		it('ignores duplicate tool result on replay', () => {
			recovery.markToolResultDelivered('tc-1');

			// Simulate replay: same toolCallId
			const shouldDeliver = !recovery.isDuplicateToolResult('tc-1');
			expect(shouldDeliver).toBe(false);
		});

		it('ignores duplicate terminal event on replay', () => {
			recovery.markTerminalEvent('wf-1');

			const shouldProcess = !recovery.isDuplicateTerminalEvent('wf-1');
			expect(shouldProcess).toBe(false);
		});

		it('ignores duplicate response on replay', () => {
			recovery.markResponseApplied('req-1');

			const shouldApply = !recovery.isDuplicateResponse('req-1');
			expect(shouldApply).toBe(false);
		});

		it('ignores duplicate transfer on replay', () => {
			recovery.markTransferCompleted('corr-1');

			const shouldEmit = !recovery.isDuplicateTransfer('corr-1');
			expect(shouldEmit).toBe(false);
		});
	});
});
