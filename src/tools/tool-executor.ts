// SPDX-License-Identifier: MIT

import { ToolExecutionError } from '../core/errors.js';
import type { IEventBus } from '../core/event-bus.js';
import type { HooksManager } from '../core/hooks.js';
import type { ToolCall, ToolResult } from '../types/conversation.js';
import type { ToolContext, ToolDefinition } from '../types/tool.js';

/** Internal tracking for an in-flight tool execution. */
interface PendingExecution {
	controller: AbortController;
	toolName: string;
	startedAt: number;
}

/**
 * Executes inline tool calls requested by Gemini.
 *
 * For each tool call: validates arguments via Zod, creates an AbortController,
 * fires onToolCall/onToolResult hooks, publishes EventBus events, and enforces timeouts.
 * Multiple tool calls can run concurrently — each is tracked in the `pending` map.
 */
export class ToolExecutor {
	private tools = new Map<string, ToolDefinition>();
	private pending = new Map<string, PendingExecution>();

	constructor(
		private hooks: HooksManager,
		private eventBus: IEventBus,
		private sessionId: string,
		private agentName: string,
		private sendJsonToClient?: (message: Record<string, unknown>) => void,
		private setDirective?: (key: string, value: string | null, scope?: 'session' | 'agent') => void,
	) {}

	register(tools: ToolDefinition[]): void {
		for (const tool of tools) {
			this.tools.set(tool.name, tool);
		}
	}

	/** Execute a tool call: validate args, run with timeout, fire hooks, return result. */
	async handleToolCall(call: ToolCall): Promise<ToolResult> {
		const tool = this.tools.get(call.toolName);
		if (!tool) {
			return {
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				result: null,
				error: `Unknown tool: ${call.toolName}`,
			};
		}

		// Validate args with Zod
		const parsed = tool.parameters.safeParse(call.args);
		if (!parsed.success) {
			return {
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				result: null,
				error: `Validation failed: ${parsed.error.message}`,
			};
		}

		const controller = new AbortController();
		const startedAt = Date.now();
		this.pending.set(call.toolCallId, {
			controller,
			toolName: call.toolName,
			startedAt,
		});

		// Fire hook
		if (this.hooks.onToolCall) {
			this.hooks.onToolCall({
				sessionId: this.sessionId,
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				execution: tool.execution,
				agentName: this.agentName,
			});
		}

		// Publish event
		this.eventBus.publish('tool.call', {
			...call,
			sessionId: this.sessionId,
			agentName: this.agentName,
		});

		const ctx: ToolContext = {
			toolCallId: call.toolCallId,
			agentName: this.agentName,
			sessionId: this.sessionId,
			abortSignal: controller.signal,
			sendJsonToClient: this.sendJsonToClient,
			setDirective: this.setDirective,
		};

		let result: ToolResult;
		try {
			const timeoutMs = tool.timeout ?? 30_000;
			const output = await this.executeWithTimeout(tool, parsed.data, ctx, timeoutMs);
			result = {
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				result: output,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result = {
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				result: null,
				error: message,
			};
		} finally {
			this.pending.delete(call.toolCallId);
		}

		const durationMs = Date.now() - startedAt;

		// Fire result hook
		if (this.hooks.onToolResult) {
			this.hooks.onToolResult({
				toolCallId: call.toolCallId,
				durationMs,
				status: result.error ? 'error' : 'completed',
				error: result.error,
			});
		}

		// Publish result event
		this.eventBus.publish('tool.result', {
			...result,
			sessionId: this.sessionId,
		});

		return result;
	}

	/** Abort one or more pending tool executions and fire cancellation hooks/events. */
	cancel(toolCallIds: string[]): void {
		for (const id of toolCallIds) {
			const pending = this.pending.get(id);
			if (pending) {
				pending.controller.abort();
				this.pending.delete(id);

				if (this.hooks.onToolResult) {
					this.hooks.onToolResult({
						toolCallId: id,
						durationMs: Date.now() - pending.startedAt,
						status: 'cancelled',
					});
				}
			}
		}

		this.eventBus.publish('tool.cancel', {
			sessionId: this.sessionId,
			toolCallIds,
		});
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	private async executeWithTimeout(
		tool: ToolDefinition,
		args: Record<string, unknown>,
		ctx: ToolContext,
		timeoutMs: number,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				ctx.abortSignal.dispatchEvent(new Event('abort'));
				reject(new ToolExecutionError(`Tool "${tool.name}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			tool
				.execute(args, ctx)
				.then(resolve)
				.catch(reject)
				.finally(() => clearTimeout(timer));
		});
	}
}
