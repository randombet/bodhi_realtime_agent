// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EventBus } from '../../src/core/event-bus.js';
import { HooksManager } from '../../src/core/hooks.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import type { ToolDefinition } from '../../src/types/tool.js';

function createTestTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
	return {
		name: 'test_tool',
		description: 'A test tool',
		parameters: z.object({ query: z.string() }),
		execution: 'inline',
		execute: vi.fn(async () => 'result'),
		...overrides,
	};
}

function setup() {
	const hooks = new HooksManager();
	const eventBus = new EventBus();
	const executor = new ToolExecutor(hooks, eventBus, 'sess_1', 'main');
	return { hooks, eventBus, executor };
}

describe('ToolExecutor', () => {
	it('executes tool and returns result', async () => {
		const { executor } = setup();
		executor.register([createTestTool()]);

		const result = await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'hello' },
		});

		expect(result.result).toBe('result');
		expect(result.error).toBeUndefined();
	});

	it('returns error for unknown tool', async () => {
		const { executor } = setup();

		const result = await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'unknown',
			args: {},
		});

		expect(result.error).toContain('Unknown tool');
		expect(result.result).toBeNull();
	});

	it('validates args with Zod schema', async () => {
		const { executor } = setup();
		executor.register([createTestTool()]);

		const result = await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 123 }, // should be string
		});

		expect(result.error).toContain('Validation failed');
	});

	it('fires onToolCall and onToolResult hooks', async () => {
		const { hooks, executor } = setup();
		const onToolCall = vi.fn();
		const onToolResult = vi.fn();
		hooks.register({ onToolCall, onToolResult });

		executor.register([createTestTool()]);
		await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(onToolCall).toHaveBeenCalledOnce();
		expect(onToolCall).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'sess_1',
				toolCallId: 'tc_1',
				toolName: 'test_tool',
				execution: 'inline',
				agentName: 'main',
			}),
		);

		expect(onToolResult).toHaveBeenCalledOnce();
		expect(onToolResult).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCallId: 'tc_1',
				status: 'completed',
			}),
		);
	});

	it('publishes events to EventBus', async () => {
		const { eventBus, executor } = setup();
		const callHandler = vi.fn();
		const resultHandler = vi.fn();
		eventBus.subscribe('tool.call', callHandler);
		eventBus.subscribe('tool.result', resultHandler);

		executor.register([createTestTool()]);
		await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(callHandler).toHaveBeenCalledOnce();
		expect(resultHandler).toHaveBeenCalledOnce();
	});

	it('handles tool execution error', async () => {
		const { executor } = setup();
		executor.register([
			createTestTool({
				execute: vi.fn(async () => {
					throw new Error('tool broke');
				}),
			}),
		]);

		const result = await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(result.error).toBe('tool broke');
		expect(result.result).toBeNull();
	});

	it('times out long-running tool', async () => {
		const { executor } = setup();
		executor.register([
			createTestTool({
				timeout: 50,
				execute: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve('late'), 200))),
			}),
		]);

		const result = await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(result.error).toContain('timed out');
	});

	it('sets signal.aborted to true on timeout', async () => {
		const { executor } = setup();
		let receivedSignal: AbortSignal | null = null;
		executor.register([
			createTestTool({
				timeout: 50,
				execute: vi.fn(async (_args, ctx) => {
					receivedSignal = ctx.abortSignal;
					return new Promise((resolve) => setTimeout(() => resolve('late'), 200));
				}),
			}),
		]);

		await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(receivedSignal).not.toBeNull();
		expect(receivedSignal?.aborted).toBe(true);
	});

	it('cancel aborts pending execution', async () => {
		const { hooks, executor } = setup();
		const onToolResult = vi.fn();
		hooks.register({ onToolResult });

		let receivedSignal: AbortSignal | null = null;
		executor.register([
			createTestTool({
				execute: vi.fn(async (_args, ctx) => {
					receivedSignal = ctx.abortSignal;
					return new Promise((resolve) => setTimeout(() => resolve('done'), 500));
				}),
			}),
		]);

		const promise = executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		// Let the tool start
		await new Promise((r) => setTimeout(r, 10));

		executor.cancel(['tc_1']);

		expect(onToolResult).toHaveBeenCalledWith(
			expect.objectContaining({ toolCallId: 'tc_1', status: 'cancelled' }),
		);

		// Let promise settle
		await promise;
	});

	it('passes sendJsonToClient to tool context when provided', async () => {
		const hooks = new HooksManager();
		const eventBus = new EventBus();
		const mockSend = vi.fn();
		const executor = new ToolExecutor(hooks, eventBus, 'sess_1', 'main', mockSend);

		let receivedCtx: { sendJsonToClient?: (msg: Record<string, unknown>) => void } | null = null;
		executor.register([
			createTestTool({
				execute: vi.fn(async (_args, ctx) => {
					receivedCtx = ctx;
					ctx.sendJsonToClient?.({ type: 'test', data: 'hello' });
					return 'ok';
				}),
			}),
		]);

		await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(receivedCtx?.sendJsonToClient).toBe(mockSend);
		expect(mockSend).toHaveBeenCalledWith({ type: 'test', data: 'hello' });
	});

	it('passes setDirective to tool context when provided', async () => {
		const hooks = new HooksManager();
		const eventBus = new EventBus();
		const mockSetDirective = vi.fn();
		const executor = new ToolExecutor(
			hooks,
			eventBus,
			'sess_1',
			'main',
			undefined,
			mockSetDirective,
		);

		executor.register([
			createTestTool({
				execute: vi.fn(async (_args, ctx) => {
					ctx.setDirective?.('pacing', 'speak slowly');
					ctx.setDirective?.('language', null);
					return 'ok';
				}),
			}),
		]);

		await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(mockSetDirective).toHaveBeenCalledTimes(2);
		expect(mockSetDirective).toHaveBeenCalledWith('pacing', 'speak slowly');
		expect(mockSetDirective).toHaveBeenCalledWith('language', null);
	});

	it('fires onError hook with ToolExecutionError preserving original cause', async () => {
		const { hooks, executor } = setup();
		const onError = vi.fn();
		hooks.register({ onError });

		const originalError = new Error('disk full');
		executor.register([
			createTestTool({
				execute: vi.fn(async () => {
					throw originalError;
				}),
			}),
		]);

		await executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		expect(onError).toHaveBeenCalledOnce();
		const errorEvent = onError.mock.calls[0][0];
		expect(errorEvent.component).toBe('tool');
		expect(errorEvent.error.message).toContain('disk full');
		expect(errorEvent.error.cause).toBe(originalError);
	});

	it('tracks pending count', async () => {
		const { executor } = setup();
		executor.register([
			createTestTool({
				execute: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve('done'), 100))),
			}),
		]);

		expect(executor.pendingCount).toBe(0);

		const promise = executor.handleToolCall({
			toolCallId: 'tc_1',
			toolName: 'test_tool',
			args: { query: 'test' },
		});

		// Let it start
		await new Promise((r) => setTimeout(r, 10));
		expect(executor.pendingCount).toBe(1);

		await promise;
		expect(executor.pendingCount).toBe(0);
	});
});
