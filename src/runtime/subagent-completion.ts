// SPDX-License-Identifier: MIT

/**
 * SubagentCompletion — structured completion contract for subagent workflows.
 *
 * Provides a deterministic notification policy: every terminal event
 * (success/failure/cancel) produces exactly one SubagentCompletion with
 * typed status, summary text, optional UI payload, and metadata.
 */

/** Status of a completed subagent workflow. */
export type SubagentCompletionStatus = 'success' | 'failure' | 'cancelled';

/** Structured completion envelope for subagent workflows. */
export interface SubagentCompletion {
	/** Unique tool call identifier that originated the workflow. */
	toolCallId: string;
	/** Workflow identifier for correlation. */
	workflowId: string;
	/** Terminal status. */
	status: SubagentCompletionStatus;
	/** Human-readable summary for the LLM to speak back to the user. */
	summaryText: string;
	/** Optional structured UI payload for client rendering. */
	uiPayload?: Record<string, unknown>;
	/** Optional artifacts produced by the subagent. */
	artifacts?: SubagentArtifact[];
	/** Timing and diagnostic metadata. */
	metadata: SubagentCompletionMetadata;
}

/** An artifact produced by a subagent (e.g., file, code snippet). */
export interface SubagentArtifact {
	type: string;
	name: string;
	content: string;
}

/** Metadata attached to every completion. */
export interface SubagentCompletionMetadata {
	/** Config name of the subagent that ran. */
	configName: string;
	/** Total wall-clock duration in milliseconds. */
	durationMs: number;
	/** Number of AI SDK steps executed. */
	stepCount?: number;
	/** Lifetime mode of the workflow. */
	lifetime: 'ephemeral' | 'persistent_session';
}

/**
 * Build a SubagentCompletion from a successful workflow.
 */
export function buildSuccessCompletion(params: {
	toolCallId: string;
	workflowId: string;
	result: string;
	configName: string;
	durationMs: number;
	lifetime?: 'ephemeral' | 'persistent_session';
	uiPayload?: Record<string, unknown>;
	artifacts?: SubagentArtifact[];
	stepCount?: number;
}): SubagentCompletion {
	return {
		toolCallId: params.toolCallId,
		workflowId: params.workflowId,
		status: 'success',
		summaryText: params.result,
		uiPayload: params.uiPayload,
		artifacts: params.artifacts,
		metadata: {
			configName: params.configName,
			durationMs: params.durationMs,
			stepCount: params.stepCount,
			lifetime: params.lifetime ?? 'ephemeral',
		},
	};
}

/**
 * Build a SubagentCompletion from a failed workflow.
 */
export function buildFailureCompletion(params: {
	toolCallId: string;
	workflowId: string;
	error: string;
	configName: string;
	durationMs: number;
	lifetime?: 'ephemeral' | 'persistent_session';
}): SubagentCompletion {
	return {
		toolCallId: params.toolCallId,
		workflowId: params.workflowId,
		status: 'failure',
		summaryText: `Error: ${params.error}`,
		metadata: {
			configName: params.configName,
			durationMs: params.durationMs,
			lifetime: params.lifetime ?? 'ephemeral',
		},
	};
}

/**
 * Build a SubagentCompletion from a cancelled workflow.
 */
export function buildCancelledCompletion(params: {
	toolCallId: string;
	workflowId: string;
	configName: string;
	durationMs: number;
	lifetime?: 'ephemeral' | 'persistent_session';
}): SubagentCompletion {
	return {
		toolCallId: params.toolCallId,
		workflowId: params.workflowId,
		status: 'cancelled',
		summaryText: 'Task was cancelled.',
		metadata: {
			configName: params.configName,
			durationMs: params.durationMs,
			lifetime: params.lifetime ?? 'ephemeral',
		},
	};
}
