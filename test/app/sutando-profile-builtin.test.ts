import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	AGENT_PROFILE_CATALOG,
	isRegisteredAgentProfileId,
} from '../../app/agents/agent-profiles-catalog.js';
import { createSutandoBuiltinCompileModel } from '../../app/agents/builtin/sutando/compile-model.js';
import { getBuiltinAgentCompileModel } from '../../app/agents/definitions/builtin-agent-definitions.js';

describe('sutando built-in profile registration', () => {
	it('is a registered catalog profile with the pinned live model', () => {
		expect(isRegisteredAgentProfileId('sutando')).toBe(true);
		const entry = AGENT_PROFILE_CATALOG.find((p) => p.id === 'sutando');
		expect(entry?.label).toBe('My Sutando');
		expect(entry?.speechOutput).toEqual({
			mode: 'native',
			provider: 'gemini',
			model: 'gemini-3.1-flash-live-preview',
		});
		// No phone surface: the profile must not carry an outbound opening prompt.
		expect(
			(entry as { telephonyOutboundOpeningUserPrompt?: string }).telephonyOutboundOpeningUserPrompt,
		).toBeUndefined();
	});

	it('has a compile model in the builtin registry', () => {
		const model = getBuiltinAgentCompileModel('sutando');
		expect(model).not.toBeNull();
		expect(model?.mainAgents[0]?.name).toBe('main');
		expect(model?.mainAgents[0]?.toolIds).toEqual(['get_current_time', 'end_session']);
	});

	it('search modes flip the tool declaration and the persona routing line together', () => {
		const withSearch = createSutandoBuiltinCompileModel(true).mainAgents[0];
		const withoutSearch = createSutandoBuiltinCompileModel(false).mainAgents[0];
		expect(withSearch?.googleSearch).toBe(true);
		expect(withSearch?.instructions).toContain('Google Search: quick factual lookups');
		expect(withoutSearch?.googleSearch).toBe(false);
		expect(withoutSearch?.instructions).not.toContain('Google Search');
		// Both modes still route delegation through ask_sutando.
		expect(withSearch?.instructions).toContain('ask_sutando');
		expect(withoutSearch?.instructions).toContain('ask_sutando');
	});

	it('is NOT offered by the Talk selector (owner-gated; the tab is its only surface)', () => {
		// TALK_BUILTIN_PROFILE_IDS lives in a .tsx module the node test runner
		// does not compile; assert on the source of truth directly.
		const source = readFileSync(
			join(__dirname, '../../app/web-client/src/components/talk/AgentSelector.tsx'),
			'utf-8',
		);
		const listMatch = source.match(/TALK_BUILTIN_PROFILE_IDS = new Set\(\[(.*?)\]\)/s);
		expect(listMatch).not.toBeNull();
		expect(listMatch?.[1]).not.toContain('sutando');
	});
});
