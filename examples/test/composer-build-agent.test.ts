// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { StoredUserAgentDocument } from '../../app/agents/agent-definition-parse.js';
import { buildExampleAgent } from '../composer/build-agent.js';

// Hermetic: a fake generateObject so the demo runs with no API keys, plus a tiny
// in-memory store. Asserts the example produces a valid, persisted definition.
function inMemoryStore() {
	const records = new Map<string, StoredUserAgentDocument>();
	return {
		records,
		async putIfAbsent(r: StoredUserAgentDocument): Promise<'created' | 'exists'> {
			if (records.has(r.id)) return 'exists';
			records.set(r.id, r);
			return 'created';
		},
	};
}

describe('examples/composer build-agent', () => {
	it('builds and persists a valid agent definition with mocked generation', async () => {
		const store = inMemoryStore();
		const result = await buildExampleAgent({
			store,
			env: { GEMINI_API_KEY: 'test' },
			generateObjectFn: async () => ({
				object: {
					displayName: 'Cooking Assistant',
					description: 'Helps with recipes.',
					instructions: 'You are a friendly cooking assistant.',
					requestedToolIds: ['calculate', 'get_current_time'],
				},
			}),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.agentId).toMatch(/^ua_[a-f0-9]{16}$/);
		const saved = store.records.get(result.agentId);
		expect(saved?.name).toBe('Cooking Assistant');
		expect((saved as { mainAgents: { name: string }[] }).mainAgents[0].name).toBe('main');
	});
});
