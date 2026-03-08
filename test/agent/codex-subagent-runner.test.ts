// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { runCodexSubagent } from '../../src/agent/codex-subagent-runner.js';
import { SubagentSessionImpl } from '../../src/agent/subagent-session.js';
import { HooksManager } from '../../src/core/hooks.js';
import type { SubagentContextSnapshot } from '../../src/types/conversation.js';

vi.mock('@openai/codex-sdk', () => {
	const runStreamed = vi.fn(async (input: string) => ({
		events: (async function* () {
			yield {
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'npm test',
					aggregated_output: '',
					status: 'completed',
					id: '1',
					exit_code: 0,
				},
			};
			yield {
				type: 'item.completed',
				item: { type: 'agent_message', text: `done: ${input}`, id: '2' },
			};
			yield {
				type: 'turn.completed',
				usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
			};
		})(),
	}));

	return {
		Codex: vi.fn(() => ({
			startThread: vi.fn(() => ({ runStreamed })),
		})),
	};
});

function createContext(): SubagentContextSnapshot {
	return {
		task: { description: 'Fix lint', toolCallId: 'tc_1', toolName: 'fix', args: {} },
		conversationSummary: null,
		recentTurns: [],
		relevantMemoryFacts: [],
		agentInstructions: 'You are a coding assistant',
	};
}

describe('runCodexSubagent', () => {
	it('runs a codex turn and returns the final response', async () => {
		const result = await runCodexSubagent({
			config: { name: 'coder', provider: 'codex', instructions: 'code', tools: {} },
			context: createContext(),
			hooks: new HooksManager(),
		});

		expect(result.text).toContain('done:');
		expect(result.stepCount).toBe(2);
	});

	it('supports interactive follow-up messages via SubagentSession', async () => {
		const hooks = new HooksManager();
		const session = new SubagentSessionImpl('tc_1', { interactive: true, inputTimeout: 1000 });
		session.onStateChange((next) => {
			if (next === 'waiting_for_input') {
				setTimeout(() => session.sendToSubagent('done'), 0);
			}
		});

		const result = await runCodexSubagent({
			config: {
				name: 'coder',
				provider: 'codex',
				instructions: 'code',
				tools: {},
				interactive: true,
			},
			context: createContext(),
			hooks,
			session,
		});

		expect(result.text).toContain('done:');
		expect(result.stepCount).toBeGreaterThan(0);
	});
});
