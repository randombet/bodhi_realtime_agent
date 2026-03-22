// SPDX-License-Identifier: MIT

/**
 * ToolRouterActor — dispatches tool calls to the correct execution path:
 * inline execution, background subagent, or agent transfer.
 *
 * Receives `transport.tool_call_received` messages and routes them based
 * on tool definition metadata. Emits typed lifecycle events for each path.
 *
 * Reuses existing ToolExecutor for inline tools. Sends spawn requests to
 * SubagentSupervisorActor for background tools.
 */

import type { Actor } from '../actor-runtime.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { RuntimeMessage } from '../messages.js';

/** Tool metadata needed for routing decisions. */
export interface ToolRoutingInfo {
	name: string;
	execution: 'inline' | 'background';
	configName?: string;
	lifetime?: 'ephemeral' | 'persistent_session';
	pendingMessage?: string;
}

/** Callbacks for inline tool execution. */
export interface InlineToolExecutor {
	execute(call: {
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
	}): Promise<{ result: unknown; error?: string }>;
}

export class ToolRouterActor implements Actor {
	readonly id: ActorId;

	constructor(
		id: ActorId,
		private toolRegistry: Map<string, ToolRoutingInfo>,
		private inlineExecutor: InlineToolExecutor,
		private sendMessage: (type: RuntimeMessage['type'], payload: unknown, to: ActorId) => void,
		private transportActorId: ActorId,
		private subagentSupervisorId: ActorId,
		private mainAgentActorId: ActorId,
		private onTransferRequested?: (toAgent: string) => Promise<void> | void,
	) {
		this.id = id;
	}

	async onMessage(envelope: Envelope): Promise<void> {
		switch (envelope.type) {
			case 'transport.tool_call_received': {
				const { calls } = envelope.payload as {
					calls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
				};
				for (const call of calls) {
					await this.dispatchToolCall(call);
				}
				break;
			}
			case 'transport.tool_call_cancelled': {
				const { ids } = envelope.payload as { ids: string[] };
				for (const id of ids) {
					this.sendMessage(
						'subagent.cancel_requested',
						{ toolCallId: id },
						this.subagentSupervisorId,
					);
				}
				break;
			}
			default:
				break;
		}
	}

	private async dispatchToolCall(call: {
		id: string;
		name: string;
		args: Record<string, unknown>;
	}): Promise<void> {
		// Check for transfer tool
		if (call.name === 'transfer_to_agent' && call.args.agent_name) {
			const toAgent = call.args.agent_name as string;
			try {
				if (this.onTransferRequested) {
					await this.onTransferRequested(toAgent);
				} else {
					const transferCorrelationId = `transfer-${Date.now()}-${call.id}`;
					this.sendMessage(
						'agent.transfer_requested',
						{
							toAgent,
							transferCorrelationId,
						},
						this.mainAgentActorId,
					);
				}
				// Send immediate acknowledgement to transport
				this.sendMessage(
					'transport.send_tool_result',
					{
						id: call.id,
						name: call.name,
						result: { status: 'transferred' },
						scheduling: 'immediate',
					},
					this.transportActorId,
				);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				this.sendMessage(
					'transport.send_tool_result',
					{
						id: call.id,
						name: call.name,
						result: { error: errorMsg },
						scheduling: 'immediate',
					},
					this.transportActorId,
				);
			}
			return;
		}

		const toolInfo = this.toolRegistry.get(call.name);

		if (!toolInfo || toolInfo.execution === 'inline') {
			// Inline execution
			try {
				const result = await this.inlineExecutor.execute({
					toolCallId: call.id,
					toolName: call.name,
					args: call.args,
				});
				this.sendMessage(
					'tool.inline.completed',
					{
						toolCallId: call.id,
						toolName: call.name,
						result: result.error ? { error: result.error } : result.result,
					},
					this.transportActorId,
				);
				// Also send the tool result to transport
				this.sendMessage(
					'transport.send_tool_result',
					{
						id: call.id,
						name: call.name,
						result: result.error ? { error: result.error } : result.result,
						scheduling: 'immediate',
					},
					this.transportActorId,
				);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				this.sendMessage(
					'tool.inline.failed',
					{ toolCallId: call.id, toolName: call.name, error: errorMsg },
					this.transportActorId,
				);
				this.sendMessage(
					'transport.send_tool_result',
					{
						id: call.id,
						name: call.name,
						result: { error: errorMsg },
						scheduling: 'immediate',
					},
					this.transportActorId,
				);
			}
		} else {
			// Background subagent spawn
			if (toolInfo.pendingMessage) {
				this.sendMessage(
					'transport.send_tool_result',
					{
						id: call.id,
						name: call.name,
						result: {
							status: 'still_in_progress',
							message: toolInfo.pendingMessage,
							important: 'This task is NOT complete yet.',
						},
						scheduling: 'immediate',
					},
					this.transportActorId,
				);
			}

			this.sendMessage(
				'subagent.spawn_requested',
				{
					toolCallId: call.id,
					toolName: call.name,
					args: call.args,
					configName: toolInfo.configName ?? call.name,
					lifetime: toolInfo.lifetime ?? 'ephemeral',
				},
				this.subagentSupervisorId,
			);
		}
	}
}
