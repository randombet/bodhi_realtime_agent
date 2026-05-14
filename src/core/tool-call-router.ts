// SPDX-License-Identifier: MIT

import type { AgentRouter } from '../agent/agent-router.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { SubagentConfig } from '../types/agent.js';
import type { ToolDefinition } from '../types/tool.js';
import type { TransportToolResult } from '../types/transport.js';
import type { BackgroundNotificationQueue } from './background-notification-queue.js';
import type { ConversationContext } from './conversation-context.js';
import type { TranscriptManager } from './transcript-manager.js';

/** Callbacks that the ToolCallRouter needs from VoiceSession. */
export interface ToolCallRouterDeps {
	toolExecutor: ToolExecutor;
	agentRouter: AgentRouter;
	conversationContext: ConversationContext;
	notificationQueue: BackgroundNotificationQueue;
	transcriptManager: TranscriptManager;
	subagentConfigs: Record<string, SubagentConfig>;
	/** Send a tool result back to the LLM transport. */
	sendToolResult(result: TransportToolResult): void;
	/** Trigger an agent transfer. */
	transfer(toAgent: string): Promise<void>;
	/** Report an error via hooks/logging. */
	reportError(component: string, error: unknown): void;
	/** Diagnostic log. */
	log(msg: string): void;
}

/**
 * Routes tool calls from the LLM to the correct execution path:
 * inline execution, background subagent handoff, or agent transfer.
 *
 * Extracted from VoiceSession to reduce its line count and isolate
 * tool call routing as a self-contained concern.
 *
 * @deprecated Use `ToolRouterActor` from `src/runtime/` instead.
 * This class is retained for backward compatibility during the transition
 * to the actor-based orchestration layer (`RuntimeOrchestrator`).
 */
export class ToolCallRouter {
	private deps: ToolCallRouterDeps;

	constructor(deps: ToolCallRouterDeps) {
		this.deps = deps;
	}

	/** Update the tool executor (e.g. after an agent transfer). */
	set toolExecutor(executor: ToolExecutor) {
		this.deps.toolExecutor = executor;
	}

	/** Dispatch incoming tool calls to the appropriate handler. */
	handleToolCalls(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): void {
		const names = calls.map((c) => c.name).join(', ');
		this.deps.log(`Tool calls from LLM: [${names}]`);
		// Flush user's input transcript before tool calls so it appears first
		// in conversation context and logs. Safe because Gemini only calls tools
		// after processing the user's complete utterance.
		this.deps.transcriptManager.flushInput();

		// Save output transcript accumulated before tool call to avoid
		// duplication: Gemini transcribes ahead of tool calls, then
		// re-transcribes the same text after receiving the tool result.
		this.deps.transcriptManager.saveOutputPrefix();

		for (const call of calls) {
			const toolCall = {
				toolCallId: call.id,
				toolName: call.name,
				args: call.args,
			};

			// Check if this is a transfer tool
			if (call.name === 'transfer_to_agent' && call.args.agent_name) {
				this.deps.transfer(call.args.agent_name as string).catch((err) => {
					this.deps.reportError('agent-router', err);
				});
				// Send acknowledgement so the LLM doesn't hang
				this.deps.sendToolResult({
					id: call.id,
					name: call.name,
					result: { status: 'transferred' },
					scheduling: 'immediate',
				});
				return;
			}

			// Find tool definition to determine execution type
			const agent = this.deps.agentRouter.activeAgent;
			const toolDef = agent.tools.find((t: ToolDefinition) => t.name === call.name);

			if (toolDef?.execution === 'background') {
				this.handleBackgroundToolCall(toolCall, toolDef);
			} else {
				this.handleInlineToolCall(toolCall, toolDef);
			}
		}
	}

	/** Abort one or more pending tool executions and subagents. */
	handleToolCallCancellation(ids: string[]): void {
		this.deps.toolExecutor.cancel(ids);
		for (const id of ids) {
			this.deps.agentRouter.cancelSubagent(id);
		}
	}

	private handleInlineToolCall(
		call: {
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
		},
		toolDef: ToolDefinition | undefined,
	): void {
		// Respect the tool definition's scheduling hint (e.g. 'silent' for
		// purely informational tools like `set_transcription_mode`). Default
		// 'immediate' preserves existing behaviour.
		const scheduling = toolDef?.scheduling ?? 'immediate';
		this.deps.toolExecutor
			.handleToolCall(call)
			.then((result) => {
				this.deps.conversationContext.addToolCall(call);
				this.deps.conversationContext.addToolResult(result);

				this.deps.sendToolResult({
					id: result.toolCallId,
					name: result.toolName,
					result: result.error ? { error: result.error } : result.result,
					scheduling,
				});
			})
			.catch((err) => {
				this.deps.reportError('tool-executor', err);
				// Always send a response so the LLM doesn't hang. Errors use
				// 'immediate' regardless of the tool's default scheduling —
				// the model should react to failures.
				this.deps.sendToolResult({
					id: call.toolCallId,
					name: call.toolName,
					result: { error: err instanceof Error ? err.message : String(err) },
					scheduling: 'immediate',
				});
			});
	}

	private handleBackgroundToolCall(
		call: { toolCallId: string; toolName: string; args: Record<string, unknown> },
		toolDef: ToolDefinition,
	): void {
		const hasPendingMessage = !!toolDef.pendingMessage;

		// Send a tool result to unblock the LLM (it stops generating until a response arrives).
		// Explicitly mark the task as still in progress so the LLM doesn't claim it's done.
		if (hasPendingMessage) {
			this.deps.sendToolResult({
				id: call.toolCallId,
				name: call.toolName,
				result: {
					status: 'still_in_progress',
					message: toolDef.pendingMessage,
					important:
						'This task is NOT complete yet. Do NOT tell the user it is ready. You will receive a notification when it finishes.',
				},
				scheduling: 'immediate',
			});
		}

		// Find subagent config
		const registeredConfig = this.deps.subagentConfigs[call.toolName];
		if (!registeredConfig) {
			this.handleLocalBackgroundToolCall(call, hasPendingMessage);
			return;
		}

		// Build an isolated config instance per handoff when requested.
		const subagentConfig = registeredConfig.createInstance
			? registeredConfig.createInstance()
			: registeredConfig;

		// Record tool call before handoff starts so reconnect replay includes
		// in-flight background tasks and avoids duplicate re-execution.
		this.deps.conversationContext.addToolCall(call);

		// Handoff to subagent
		this.deps.agentRouter
			.handoff(call, subagentConfig)
			.then((result) => {
				this.deps.conversationContext.addToolResult({
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					result: result.text,
				});

				if (hasPendingMessage) {
					// The pending message already satisfied the tool call from Gemini's perspective.
					// Inject the completion as a context message so Gemini naturally informs the user.
					// If Gemini is mid-generation, queue it until the current turn ends.
					this.deps.notificationQueue.sendOrQueue(
						[
							{
								role: 'user',
								parts: [
									{
										text: `[SYSTEM: Background task "${call.toolName}" completed successfully. Result: ${result.text}. Please inform the user their content is ready now.]`,
									},
								],
							},
						],
						true,
					);
				} else {
					this.deps.sendToolResult({
						id: call.toolCallId,
						name: call.toolName,
						result: { result: result.text },
						scheduling: 'when_idle',
					});
				}
			})
			.catch((err) => {
				this.deps.reportError('subagent-runner', err);
				this.deps.conversationContext.addToolResult({
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					result: null,
					error: err instanceof Error ? err.message : String(err),
				});
				if (hasPendingMessage) {
					this.deps.notificationQueue.sendOrQueue(
						[
							{
								role: 'user',
								parts: [
									{
										text: `[SYSTEM: Background task "${call.toolName}" failed. Exact error details: ${err instanceof Error ? err.message : String(err)}. Tell the user the exact error details first, then ask how to proceed.]`,
									},
								],
							},
						],
						true,
					);
				} else {
					this.deps.sendToolResult({
						id: call.toolCallId,
						name: call.toolName,
						result: { error: err instanceof Error ? err.message : String(err) },
						scheduling: 'when_idle',
					});
				}
			});
	}

	private handleLocalBackgroundToolCall(
		call: { toolCallId: string; toolName: string; args: Record<string, unknown> },
		hasPendingMessage: boolean,
	): void {
		this.deps.conversationContext.addToolCall(call);

		if (!hasPendingMessage) {
			this.deps.sendToolResult({
				id: call.toolCallId,
				name: call.toolName,
				result: {
					status: 'accepted',
					message: 'Background tool accepted. Continue with the next required step.',
					important:
						'Do not wait for another tool result. Continue with the next tool call or user-facing response required by your instructions.',
				},
				scheduling: 'immediate',
			});
		}

		this.deps.toolExecutor
			.handleToolCall(call)
			.then((result) => {
				this.deps.conversationContext.addToolResult(result);

				if (hasPendingMessage) {
					this.deps.notificationQueue.sendOrQueue(
						[
							{
								role: 'user',
								parts: [
									{
										text: `[SYSTEM: Background task "${call.toolName}" completed successfully. Result: ${JSON.stringify(result.result)}. Please inform the user if relevant.]`,
									},
								],
							},
						],
						true,
					);
				}
			})
			.catch((err) => {
				this.deps.reportError('tool-executor', err);
				this.deps.conversationContext.addToolResult({
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					result: null,
					error: err instanceof Error ? err.message : String(err),
				});
				this.deps.notificationQueue.sendOrQueue(
					[
						{
							role: 'user',
							parts: [
								{
									text: `[SYSTEM: Background task "${call.toolName}" failed. Exact error details: ${err instanceof Error ? err.message : String(err)}. Tell the user the exact error details first, then ask how to proceed.]`,
								},
							],
						},
					],
					true,
				);
			});
	}
}
