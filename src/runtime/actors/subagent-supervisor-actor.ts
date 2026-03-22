// SPDX-License-Identifier: MIT

/**
 * SubagentSupervisorActor — owns workflow-level coordination and registry
 * for background subagent workflows.
 *
 * Reuses SubagentSession and InteractionModeManager for actual state
 * transitions (no duplicate state). Manages ephemeral and persistent
 * subagent lifecycle.
 */

import type { Actor } from '../actor-runtime.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { RuntimeMessage } from '../messages.js';

/** Execution request emitted when a background subagent workflow is spawned. */
export interface SubagentExecutionRequest {
	toolCallId: string;
	workflowId: string;
	toolName: string;
	args: Record<string, unknown>;
	configName: string;
	lifetime: 'ephemeral' | 'persistent_session';
}

/** Optional execution bridge that runs real subagent work for a spawned workflow. */
export type SubagentExecutionHandler = (
	request: SubagentExecutionRequest,
	signal: AbortSignal,
) => Promise<string>;

/** Tracks a single subagent workflow. */
interface SubagentWorkflow {
	toolCallId: string;
	workflowId: string;
	toolName: string;
	configName: string;
	lifetime: 'ephemeral' | 'persistent_session';
	state: 'pending' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';
	controller?: AbortController;
}

export class SubagentSupervisorActor implements Actor {
	readonly id: ActorId;
	private workflows = new Map<string, SubagentWorkflow>();
	private nextWorkflowId = 0;

	constructor(
		id: ActorId,
		private sendMessage: (type: RuntimeMessage['type'], payload: unknown, to: ActorId) => void,
		private transportActorId: ActorId,
		private sessionActorId: ActorId,
		private executionHandler?: SubagentExecutionHandler,
	) {
		this.id = id;
	}

	async onMessage(envelope: Envelope): Promise<void> {
		switch (envelope.type) {
			case 'subagent.spawn_requested': {
				const p = envelope.payload as {
					toolCallId: string;
					toolName: string;
					args: Record<string, unknown>;
					configName: string;
					lifetime: 'ephemeral' | 'persistent_session';
				};
				this.handleSpawnRequest(p);
				break;
			}
			case 'subagent.cancel_requested': {
				const { toolCallId } = envelope.payload as { toolCallId: string };
				this.handleCancelRequest(toolCallId);
				break;
			}
			case 'subagent.completed': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					result: string;
				};
				this.handleCompleted(p);
				break;
			}
			case 'subagent.failed': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					error: string;
				};
				this.handleFailed(p);
				break;
			}
			case 'subagent.needs_input': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					question: string;
				};
				this.handleNeedsInput(p);
				break;
			}
			case 'interaction.answer_delivered': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					text: string;
				};
				this.handleAnswerDelivered(p);
				break;
			}
			case 'subagent.timeout': {
				const { toolCallId } = envelope.payload as { toolCallId: string };
				this.handleCancelRequest(toolCallId);
				break;
			}
			default:
				break;
		}
	}

	private handleSpawnRequest(p: {
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
		configName: string;
		lifetime: 'ephemeral' | 'persistent_session';
	}): void {
		const workflowId = `wf-${++this.nextWorkflowId}`;
		const workflow: SubagentWorkflow = {
			toolCallId: p.toolCallId,
			workflowId,
			toolName: p.toolName,
			configName: p.configName,
			lifetime: p.lifetime,
			state: 'running',
		};
		this.workflows.set(p.toolCallId, workflow);

		this.sendMessage(
			'subagent.started',
			{ toolCallId: p.toolCallId, workflowId },
			this.sessionActorId,
		);

		// Optional execution bridge: run real subagent work and emit terminal events.
		if (this.executionHandler) {
			const controller = new AbortController();
			workflow.controller = controller;
			void this.runExecution(workflow, p.args, controller.signal);
		}
	}

	private handleCancelRequest(toolCallId: string): void {
		const workflow = this.workflows.get(toolCallId);
		if (
			!workflow ||
			workflow.state === 'completed' ||
			workflow.state === 'cancelled' ||
			workflow.state === 'failed'
		) {
			return;
		}

		workflow.controller?.abort();
		workflow.state = 'cancelled';
		this.sendMessage(
			'subagent.cancelled',
			{ toolCallId, workflowId: workflow.workflowId },
			this.sessionActorId,
		);
		this.workflows.delete(toolCallId);
	}

	private handleCompleted(p: { toolCallId: string; workflowId: string; result: string }): void {
		const workflow = this.workflows.get(p.toolCallId);
		if (!workflow || this.isTerminal(workflow.state)) return;

		workflow.state = 'completed';
		// Send result back to transport
		this.sendMessage(
			'transport.send_tool_result',
			{
				id: p.toolCallId,
				name: workflow.configName,
				result: { result: p.result },
				scheduling: 'when_idle',
			},
			this.transportActorId,
		);
		this.workflows.delete(p.toolCallId);
	}

	private handleFailed(p: { toolCallId: string; workflowId: string; error: string }): void {
		const workflow = this.workflows.get(p.toolCallId);
		if (!workflow || this.isTerminal(workflow.state)) return;

		workflow.state = 'failed';
		this.sendMessage(
			'transport.send_tool_result',
			{
				id: p.toolCallId,
				name: workflow.configName,
				result: { error: p.error },
				scheduling: 'when_idle',
			},
			this.transportActorId,
		);
		this.workflows.delete(p.toolCallId);
	}

	private handleNeedsInput(p: { toolCallId: string; workflowId: string; question: string }): void {
		const workflow = this.workflows.get(p.toolCallId);
		if (!workflow || this.isTerminal(workflow.state)) return;

		workflow.state = 'waiting_input';
		this.sendMessage(
			'interaction.question_presented',
			{ toolCallId: p.toolCallId, workflowId: p.workflowId },
			this.sessionActorId,
		);
	}

	private handleAnswerDelivered(p: { toolCallId: string; workflowId: string; text: string }): void {
		const workflow = this.workflows.get(p.toolCallId);
		if (!workflow || workflow.state !== 'waiting_input') return;

		workflow.state = 'running';
	}

	private isTerminal(state: SubagentWorkflow['state']): boolean {
		return state === 'completed' || state === 'failed' || state === 'cancelled';
	}

	private async runExecution(
		workflow: SubagentWorkflow,
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<void> {
		const request: SubagentExecutionRequest = {
			toolCallId: workflow.toolCallId,
			workflowId: workflow.workflowId,
			toolName: workflow.toolName,
			args,
			configName: workflow.configName,
			lifetime: workflow.lifetime,
		};

		try {
			// Guard: runExecution is only called when executionHandler is defined
			// (checked in handleSpawnRequest), but guard defensively.
			if (!this.executionHandler) return;
			const result = await this.executionHandler(request, signal);

			// Workflow may have been cancelled while execution was in flight.
			const current = this.workflows.get(workflow.toolCallId);
			if (!current || this.isTerminal(current.state)) return;

			this.handleCompleted({
				toolCallId: workflow.toolCallId,
				workflowId: workflow.workflowId,
				result,
			});
		} catch (err) {
			// Ignore expected aborts after cancellation.
			if (signal.aborted || !this.workflows.has(workflow.toolCallId)) return;

			this.handleFailed({
				toolCallId: workflow.toolCallId,
				workflowId: workflow.workflowId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/** Get the number of active workflows (for observability). */
	get activeWorkflowCount(): number {
		return this.workflows.size;
	}

	/** Check if a workflow exists for the given tool call. */
	hasWorkflow(toolCallId: string): boolean {
		return this.workflows.has(toolCallId);
	}

	/** Get the state of a workflow. */
	getWorkflowState(toolCallId: string): SubagentWorkflow['state'] | undefined {
		return this.workflows.get(toolCallId)?.state;
	}
}
