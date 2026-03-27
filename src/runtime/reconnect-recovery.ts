// SPDX-License-Identifier: MIT

/**
 * Session-scoped reconnect recovery.
 *
 * Recovers in-flight workflows across transport reconnect within the same
 * runtime process. NOT crash recovery — this is purely in-memory state that
 * survives transport-level disconnects.
 *
 * Provides idempotency/dedup protection via explicit keys:
 * - toolCallId → dedup tool result delivery
 * - workflowId → dedup terminal workflow events
 * - requestId → dedup interaction response application
 * - transferCorrelationId → dedup transfer completion/failure
 */

/** Workflow state snapshot for recovery. */
export interface RecoverableWorkflow {
	toolCallId: string;
	workflowId: string;
	configName: string;
	lifetime: 'ephemeral' | 'persistent_session';
	state: 'running' | 'waiting_input';
	/** Pending question if in waiting_input state. */
	pendingQuestion?: string;
	/** When the workflow was started. */
	startedAt: number;
}

/**
 * ReconnectRecovery tracks in-flight state for session-scoped recovery
 * and provides dedup protection for idempotent message delivery.
 */
export class ReconnectRecovery {
	/** Active workflows that survive reconnect. */
	private workflows = new Map<string, RecoverableWorkflow>();

	/** Dedup sets for terminal events (keyed by dedup ID). */
	private deliveredToolResults = new Set<string>();
	private terminalWorkflows = new Set<string>();
	private appliedResponses = new Set<string>();
	private completedTransfers = new Set<string>();

	// -- Workflow tracking ---------------------------------------------------

	/** Register a workflow for recovery tracking. */
	trackWorkflow(workflow: RecoverableWorkflow): void {
		this.workflows.set(workflow.toolCallId, workflow);
	}

	/** Update workflow state (e.g., running → waiting_input). */
	updateWorkflowState(
		toolCallId: string,
		state: RecoverableWorkflow['state'],
		pendingQuestion?: string,
	): void {
		const wf = this.workflows.get(toolCallId);
		if (wf) {
			wf.state = state;
			wf.pendingQuestion = pendingQuestion;
		}
	}

	/** Remove a workflow (terminal state reached). */
	removeWorkflow(toolCallId: string): void {
		this.workflows.delete(toolCallId);
	}

	/** Get all recoverable workflows. */
	getRecoverableWorkflows(): RecoverableWorkflow[] {
		return [...this.workflows.values()];
	}

	/** Check if a workflow is being tracked. */
	hasWorkflow(toolCallId: string): boolean {
		return this.workflows.has(toolCallId);
	}

	/** Get count of tracked workflows. */
	get workflowCount(): number {
		return this.workflows.size;
	}

	// -- Dedup: tool results ------------------------------------------------

	/** Check if a tool result has already been delivered. Returns true if duplicate. */
	isDuplicateToolResult(toolCallId: string): boolean {
		return this.deliveredToolResults.has(toolCallId);
	}

	/** Mark a tool result as delivered. */
	markToolResultDelivered(toolCallId: string): void {
		this.deliveredToolResults.add(toolCallId);
	}

	// -- Dedup: terminal workflow events ------------------------------------

	/** Check if a terminal event for this workflow has been processed. */
	isDuplicateTerminalEvent(workflowId: string): boolean {
		return this.terminalWorkflows.has(workflowId);
	}

	/** Mark a terminal workflow event as processed. */
	markTerminalEvent(workflowId: string): void {
		this.terminalWorkflows.add(workflowId);
	}

	// -- Dedup: interaction responses ----------------------------------------

	/** Check if an interaction response has been applied. */
	isDuplicateResponse(requestId: string): boolean {
		return this.appliedResponses.has(requestId);
	}

	/** Mark an interaction response as applied. */
	markResponseApplied(requestId: string): void {
		this.appliedResponses.add(requestId);
	}

	// -- Dedup: transfers ---------------------------------------------------

	/** Check if a transfer completion has been emitted. */
	isDuplicateTransfer(transferCorrelationId: string): boolean {
		return this.completedTransfers.has(transferCorrelationId);
	}

	/** Mark a transfer as completed. */
	markTransferCompleted(transferCorrelationId: string): void {
		this.completedTransfers.add(transferCorrelationId);
	}

	// -- Session lifecycle --------------------------------------------------

	/** Clear all recovery state (on session close). */
	clear(): void {
		this.workflows.clear();
		this.deliveredToolResults.clear();
		this.terminalWorkflows.clear();
		this.appliedResponses.clear();
		this.completedTransfers.clear();
	}
}
