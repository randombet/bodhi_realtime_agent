// SPDX-License-Identifier: MIT

/**
 * ClientGatewayActor — handles control-plane JSON and UI notifications
 * between the actor runtime and the client WebSocket.
 *
 * Binary audio streaming stays outside this actor (fast-path contract).
 * This actor only handles:
 * - Outbound: GUI notifications, subagent completion notifications,
 *   interaction questions to the client.
 * - Inbound: UI responses, text input from the client.
 *
 * Ensures no duplicate user notifications per toolCallId.
 */

import type { Actor } from '../actor-runtime.js';
import type { ActorId, Envelope } from '../envelope.js';
import type { RuntimeMessage } from '../messages.js';
import type { SubagentCompletion } from '../subagent-completion.js';

/** Callback to send a JSON message to the connected client. */
export type ClientSendFn = (message: Record<string, unknown>) => void;

export class ClientGatewayActor implements Actor {
	readonly id: ActorId;
	/** Track toolCallIds for which we've already sent a user notification. */
	private notifiedToolCalls = new Set<string>();

	constructor(
		id: ActorId,
		private sendMessage: (type: RuntimeMessage['type'], payload: unknown, to: ActorId) => void,
		private clientSend: ClientSendFn,
		private sessionActorId: ActorId,
	) {
		this.id = id;
	}

	async onMessage(envelope: Envelope): Promise<void> {
		switch (envelope.type) {
			case 'interaction.question_presented': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					question?: string;
					requestId?: string;
				};
				this.handleQuestionPresented(p);
				break;
			}
			case 'interaction.user_text_received': {
				const p = envelope.payload as { text: string };
				this.handleUserTextReceived(p);
				break;
			}
			case 'interaction.user_option_selected': {
				const p = envelope.payload as {
					requestId: string;
					selectedOptionId: string;
				};
				this.handleUserOptionSelected(p);
				break;
			}
			case 'subagent.completed': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					result: string;
					completion?: SubagentCompletion;
				};
				this.handleSubagentTerminal('completed', p.toolCallId, p.completion);
				break;
			}
			case 'subagent.failed': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					error: string;
					completion?: SubagentCompletion;
				};
				this.handleSubagentTerminal('failed', p.toolCallId, p.completion);
				break;
			}
			case 'subagent.cancelled': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					completion?: SubagentCompletion;
				};
				this.handleSubagentTerminal('cancelled', p.toolCallId, p.completion);
				break;
			}
			case 'subagent.progress': {
				const p = envelope.payload as {
					toolCallId: string;
					workflowId: string;
					text: string;
				};
				this.handleSubagentProgress(p);
				break;
			}
			default:
				break;
		}
	}

	private handleQuestionPresented(p: {
		toolCallId: string;
		workflowId: string;
		question?: string;
		requestId?: string;
	}): void {
		this.clientSend({
			type: 'subagent.question',
			toolCallId: p.toolCallId,
			workflowId: p.workflowId,
			question: p.question,
			requestId: p.requestId,
		});
	}

	private handleUserTextReceived(p: { text: string }): void {
		// Forward to session actor for routing to the correct subagent
		this.sendMessage('interaction.user_text_received', p, this.sessionActorId);
	}

	private handleUserOptionSelected(p: {
		requestId: string;
		selectedOptionId: string;
	}): void {
		// Forward to session actor for routing
		this.sendMessage('interaction.user_option_selected', p, this.sessionActorId);
	}

	private handleSubagentTerminal(
		event: 'completed' | 'failed' | 'cancelled',
		toolCallId: string,
		completion?: SubagentCompletion,
	): void {
		// Dedup: only notify client once per toolCallId
		if (this.notifiedToolCalls.has(toolCallId)) {
			return;
		}
		this.notifiedToolCalls.add(toolCallId);

		if (completion) {
			this.clientSend({
				type: 'subagent.completion',
				toolCallId,
				status: completion.status,
				summaryText: completion.summaryText,
				uiPayload: completion.uiPayload,
				artifacts: completion.artifacts,
				metadata: completion.metadata,
			});
		} else {
			this.clientSend({
				type: 'subagent.completion',
				toolCallId,
				status: event === 'completed' ? 'success' : event,
			});
		}
	}

	private handleSubagentProgress(p: {
		toolCallId: string;
		workflowId: string;
		text: string;
	}): void {
		this.clientSend({
			type: 'subagent.progress',
			toolCallId: p.toolCallId,
			workflowId: p.workflowId,
			text: p.text,
		});
	}

	/** Reset notification tracking (e.g., on session restart). */
	resetNotificationState(): void {
		this.notifiedToolCalls.clear();
	}
}
