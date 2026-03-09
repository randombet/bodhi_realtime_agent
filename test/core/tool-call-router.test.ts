// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolCallRouter } from '../../src/core/tool-call-router.js';
import type { SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';

function flushMicrotasks() {
	return Promise.resolve().then(() => Promise.resolve());
}

function createBackgroundTool(name: string, pendingMessage?: string): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		parameters: z.object({ task: z.string().optional() }),
		execution: 'background',
		pendingMessage,
		execute: async () => ({}),
	};
}

describe('ToolCallRouter', () => {
	it('uses createInstance() and records tool_call before handoff completion', async () => {
		const createInstance = vi.fn();
		let resolveHandoff: ((value: { text: string }) => void) | null = null;
		const handoff = vi.fn(
			() =>
				new Promise<{ text: string }>((resolve) => {
					resolveHandoff = resolve;
				}),
		);

		const addToolCall = vi.fn();
		const addToolResult = vi.fn();

		const baseConfig: SubagentConfig = {
			name: 'base',
			instructions: 'base',
			tools: {},
			createInstance,
		};
		const instanceConfig: SubagentConfig = {
			name: 'instance',
			instructions: 'instance',
			tools: {},
		};
		createInstance.mockReturnValue(instanceConfig);

		const router = new ToolCallRouter({
			toolExecutor: {
				handleToolCall: vi.fn(),
				cancel: vi.fn(),
			} as never,
			agentRouter: {
				activeAgent: { name: 'main', tools: [createBackgroundTool('ask_claude', 'working')] },
				handoff,
				cancelSubagent: vi.fn(),
			} as never,
			conversationContext: {
				addToolCall,
				addToolResult,
			} as never,
			notificationQueue: { sendOrQueue: vi.fn() } as never,
			transcriptManager: { flushInput: vi.fn(), saveOutputPrefix: vi.fn() } as never,
			subagentConfigs: { ask_claude: baseConfig },
			sendToolResult: vi.fn(),
			transfer: vi.fn(),
			reportError: vi.fn(),
			log: vi.fn(),
		});

		router.handleToolCalls([{ id: 'tc_1', name: 'ask_claude', args: { task: 'x' } }]);

		expect(createInstance).toHaveBeenCalledOnce();
		expect(handoff).toHaveBeenCalledWith(
			{ toolCallId: 'tc_1', toolName: 'ask_claude', args: { task: 'x' } },
			instanceConfig,
		);
		expect(addToolCall).toHaveBeenCalledWith({
			toolCallId: 'tc_1',
			toolName: 'ask_claude',
			args: { task: 'x' },
		});
		expect(addToolResult).not.toHaveBeenCalled();

		resolveHandoff?.({ text: 'done' });
		await flushMicrotasks();

		expect(addToolResult).toHaveBeenCalledWith({
			toolCallId: 'tc_1',
			toolName: 'ask_claude',
			result: 'done',
		});
	});

	it('records an error tool_result when subagent handoff fails', async () => {
		const handoff = vi.fn().mockRejectedValue(new Error('handoff failed'));
		const addToolCall = vi.fn();
		const addToolResult = vi.fn();
		const reportError = vi.fn();

		const router = new ToolCallRouter({
			toolExecutor: {
				handleToolCall: vi.fn(),
				cancel: vi.fn(),
			} as never,
			agentRouter: {
				activeAgent: { name: 'main', tools: [createBackgroundTool('ask_claude')] },
				handoff,
				cancelSubagent: vi.fn(),
			} as never,
			conversationContext: {
				addToolCall,
				addToolResult,
			} as never,
			notificationQueue: { sendOrQueue: vi.fn() } as never,
			transcriptManager: { flushInput: vi.fn(), saveOutputPrefix: vi.fn() } as never,
			subagentConfigs: {
				ask_claude: {
					name: 'claude',
					instructions: 'relay',
					tools: {},
				},
			},
			sendToolResult: vi.fn(),
			transfer: vi.fn(),
			reportError,
			log: vi.fn(),
		});

		router.handleToolCalls([{ id: 'tc_2', name: 'ask_claude', args: { task: 'y' } }]);
		await flushMicrotasks();

		expect(addToolCall).toHaveBeenCalledWith({
			toolCallId: 'tc_2',
			toolName: 'ask_claude',
			args: { task: 'y' },
		});
		expect(addToolResult).toHaveBeenCalledWith({
			toolCallId: 'tc_2',
			toolName: 'ask_claude',
			result: null,
			error: 'handoff failed',
		});
		expect(reportError).toHaveBeenCalled();
	});
});
