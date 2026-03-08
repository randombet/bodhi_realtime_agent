// SPDX-License-Identifier: MIT

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runClaudeCodeSubagent } from '../../src/agent/claude-subagent-runner.js';
import { SubagentSessionImpl } from '../../src/agent/subagent-session.js';
import { HooksManager } from '../../src/core/hooks.js';
import type { SubagentContextSnapshot } from '../../src/types/conversation.js';

interface FakeChild extends EventEmitter {
	stdout: EventEmitter;
	stderr: EventEmitter;
	kill: (signal?: string) => void;
}

const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
	spawn: spawnMock,
}));

function createContext(): SubagentContextSnapshot {
	return {
		task: {
			description: 'Write a TypeScript utility',
			toolCallId: 'tc_1',
			toolName: 'ask_claude',
			args: { file: 'util.ts' },
		},
		conversationSummary: null,
		recentTurns: [],
		relevantMemoryFacts: [],
		agentInstructions: 'You are a coding agent.',
	};
}

function mockSpawnWithOutputs(outputs: Array<{ code: number; stdout: string; stderr?: string }>) {
	let idx = 0;
	spawnMock.mockImplementation(() => {
		const child = new EventEmitter() as FakeChild;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = vi.fn();
		const out = outputs[idx++];
		setTimeout(() => {
			if (out.stdout) child.stdout.emit('data', out.stdout);
			if (out.stderr) child.stderr.emit('data', out.stderr);
			child.emit('close', out.code);
		}, 0);
		return child;
	});
}

beforeEach(() => {
	spawnMock.mockReset();
});
describe('runClaudeCodeSubagent', () => {
	it('returns completed result from Claude JSON contract', async () => {
		mockSpawnWithOutputs([{ code: 0, stdout: '{"status":"completed","message":"Done"}' }]);

		const hooks = new HooksManager();
		const result = await runClaudeCodeSubagent({
			config: {
				name: 'claude-coder',
				runtime: 'claude_code',
				instructions: 'Code',
				tools: {},
			},
			context: createContext(),
			hooks,
		});

		expect(result).toEqual({ text: 'Done', stepCount: 1 });
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});

	it('supports interactive needs_input loop via SubagentSession', async () => {
		mockSpawnWithOutputs([
			{
				code: 0,
				stdout: '{"status":"needs_input","message":"Need filename","question":"What file name?"}',
			},
			{ code: 0, stdout: '{"status":"completed","message":"Created helper"}' },
		]);

		const session = new SubagentSessionImpl('tc_1', {
			name: 'claude-coder',
			instructions: 'Code',
			tools: {},
			interactive: true,
		});
		session.onMessage((msg) => {
			if (msg.type === 'question') {
				setTimeout(() => session.sendToSubagent('Use src/helper.ts'), 0);
			}
		});

		const result = await runClaudeCodeSubagent({
			config: {
				name: 'claude-coder',
				runtime: 'claude_code',
				instructions: 'Code',
				tools: {},
				interactive: true,
			},
			context: createContext(),
			hooks: new HooksManager(),
			session,
		});

		expect(result.text).toBe('Created helper');
		expect(result.stepCount).toBe(2);
		expect(spawnMock).toHaveBeenCalledTimes(2);
		expect(session.state).toBe('completed');
	});

	it('throws when Claude output is invalid JSON', async () => {
		mockSpawnWithOutputs([{ code: 0, stdout: 'not-json' }]);

		await expect(
			runClaudeCodeSubagent({
				config: {
					name: 'claude-coder',
					runtime: 'claude_code',
					instructions: 'Code',
					tools: {},
				},
				context: createContext(),
				hooks: new HooksManager(),
			}),
		).rejects.toThrow('not valid JSON');
	});
});
