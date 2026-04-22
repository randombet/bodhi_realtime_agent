// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { AgentDefinitionV2 } from '../../app/agents/agent-definition.js';
import { AGENT_DEFINITION_SCHEMA_VERSION } from '../../app/agents/agent-definition.js';
import { resolveSessionRealtimeLlmProvider } from '../../app/agents/resolve-session-realtime-provider.js';

function minimalUserAgentV2(overrides: Partial<AgentDefinitionV2>): AgentDefinitionV2 {
	const base: AgentDefinitionV2 = {
		schemaVersion: AGENT_DEFINITION_SCHEMA_VERSION,
		id: 'ua_0123456789abcdef',
		userId: 'u1',
		name: 'Test',
		description: '',
		mainAgents: [
			{
				name: 'main',
				greeting: 'Hi',
				instructions: 'You are helpful.',
				googleSearch: true,
				toolIds: ['get_current_time', 'end_session'],
			},
		],
		workers: {},
		createdAt: 1,
		updatedAt: 1,
	};
	return { ...base, ...overrides };
}

describe('resolveSessionRealtimeLlmProvider', () => {
	it('uses saved agent realtimeProvider for ua_*', () => {
		const v2 = minimalUserAgentV2({ realtimeProvider: 'openai' });
		expect(
			resolveSessionRealtimeLlmProvider({
				agentProfile: v2.id,
				userAgentV2: v2,
				serverDefaultLlmProvider: 'gemini',
				openaiApiKeyPresent: true,
			}),
		).toBe('openai');
	});

	it('defaults saved agent to gemini when unset', () => {
		const v2 = minimalUserAgentV2({});
		expect(
			resolveSessionRealtimeLlmProvider({
				agentProfile: v2.id,
				userAgentV2: v2,
				serverDefaultLlmProvider: 'openai',
				openaiApiKeyPresent: true,
			}),
		).toBe('gemini');
	});

	it('coerces openai to gemini without API key', () => {
		const v2 = minimalUserAgentV2({ realtimeProvider: 'openai' });
		expect(
			resolveSessionRealtimeLlmProvider({
				agentProfile: v2.id,
				userAgentV2: v2,
				serverDefaultLlmProvider: 'gemini',
				openaiApiKeyPresent: false,
			}),
		).toBe('gemini');
	});

	it('uses server default for built-in profile when catalog has no override', () => {
		expect(
			resolveSessionRealtimeLlmProvider({
				agentProfile: 'standard',
				userAgentV2: null,
				serverDefaultLlmProvider: 'openai',
				openaiApiKeyPresent: true,
			}),
		).toBe('openai');
	});
});
