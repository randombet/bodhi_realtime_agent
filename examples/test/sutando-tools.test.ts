import { describe, expect, it } from 'vitest';
import type { MainAgent } from '../../src/types/agent.js';
import { SutandoRelayServer } from '../lib/sutando-relay-server.js';
import {
	ASK_SUTANDO_TOOL_NAME,
	type SutandoWiringConfig,
	createSutandoAgentConfig,
	validateSutandoWiring,
} from '../lib/sutando-tools.js';

function relayStub(): SutandoRelayServer {
	// Never started — the builder/validator never touch the network.
	return new SutandoRelayServer({ token: 'stub-token', port: 0 });
}

function assembled(): {
	config: SutandoWiringConfig;
	wiring: ReturnType<typeof createSutandoAgentConfig>;
} {
	const wiring = createSutandoAgentConfig({ relay: relayStub(), sessionId: 'session-1' });
	const mainAgent: MainAgent = {
		name: 'main',
		instructions: `You are a voice assistant.\n${wiring.personaFragment}`,
		tools: [wiring.tool],
	};
	return {
		config: {
			orchestrationMode: 'actor',
			agents: [mainAgent],
			subagentConfigs: { [ASK_SUTANDO_TOOL_NAME]: wiring.subagentConfig },
		},
		wiring,
	};
}

// ---------------------------------------------------------------------------

describe('createSutandoAgentConfig', () => {
	it('produces a config that passes validateSutandoWiring', () => {
		const { config } = assembled();
		expect(() => validateSutandoWiring(config)).not.toThrow();
	});

	it('two simultaneous sessions get distinct task-ID prefixes', () => {
		const a = createSutandoAgentConfig({ relay: relayStub(), sessionId: 's-a' });
		const b = createSutandoAgentConfig({ relay: relayStub(), sessionId: 's-b' });
		expect(a.taskIdPrefix).not.toBe(b.taskIdPrefix);
		expect(a.taskIdPrefix).toMatch(/^task-bodhi-[a-f0-9]{8}$/);
	});

	it('keying invariant: tool name, registry key, and config name all align', () => {
		const { config, wiring } = assembled();
		expect(wiring.tool.name).toBe(ASK_SUTANDO_TOOL_NAME);
		expect(wiring.subagentConfig.name).toBe(ASK_SUTANDO_TOOL_NAME);
		expect(Object.keys(config.subagentConfigs ?? {})).toEqual([ASK_SUTANDO_TOOL_NAME]);
	});

	it('factory returns the same instance across acquisitions (one conversation per session)', async () => {
		const { wiring } = assembled();
		const factory = wiring.subagentConfig.persistentFactory;
		expect(typeof factory).toBe('function');
		if (!factory) throw new Error('unreachable');
		const first = await factory(ASK_SUTANDO_TOOL_NAME, wiring.subagentConfig);
		const second = await factory(ASK_SUTANDO_TOOL_NAME, wiring.subagentConfig);
		expect(second).toBe(first);
	});
});

describe('validateSutandoWiring — one failure per invariant', () => {
	it('rejects legacy orchestration mode', () => {
		const { config } = assembled();
		config.orchestrationMode = 'legacy';
		expect(() => validateSutandoWiring(config)).toThrow(/orchestrationMode: 'actor'/);
	});

	it('rejects a missing orchestration mode (defaults to legacy)', () => {
		const { config } = assembled();
		config.orchestrationMode = undefined;
		expect(() => validateSutandoWiring(config)).toThrow(/orchestrationMode: 'actor'/);
	});

	it('rejects a missing tool', () => {
		const { config } = assembled();
		config.agents[0].tools = [];
		expect(() => validateSutandoWiring(config)).toThrow(/no agent carries/);
	});

	it('rejects an inline tool', () => {
		const { config } = assembled();
		config.agents[0].tools[0] = { ...config.agents[0].tools[0], execution: 'inline' };
		expect(() => validateSutandoWiring(config)).toThrow(/must be execution: 'background'/);
	});

	it('rejects a missing pendingMessage', () => {
		const { config } = assembled();
		config.agents[0].tools[0] = { ...config.agents[0].tools[0], pendingMessage: undefined };
		expect(() => validateSutandoWiring(config)).toThrow(/pendingMessage/);
	});

	it('rejects a missing subagent config', () => {
		const { config } = assembled();
		config.subagentConfigs = {};
		expect(() => validateSutandoWiring(config)).toThrow(
			/subagentConfigs\["ask_sutando"\] is missing/,
		);
	});

	it('rejects a non-persistent lifetime', () => {
		const { config } = assembled();
		const sc = config.subagentConfigs?.[ASK_SUTANDO_TOOL_NAME];
		if (!sc) throw new Error('unreachable');
		config.subagentConfigs = {
			[ASK_SUTANDO_TOOL_NAME]: { ...sc, lifetime: 'ephemeral' },
		};
		expect(() => validateSutandoWiring(config)).toThrow(/persistent_session/);
	});

	it('rejects a missing persistentFactory', () => {
		const { config } = assembled();
		const sc = config.subagentConfigs?.[ASK_SUTANDO_TOOL_NAME];
		if (!sc) throw new Error('unreachable');
		config.subagentConfigs = {
			[ASK_SUTANDO_TOOL_NAME]: { ...sc, persistentFactory: undefined },
		};
		expect(() => validateSutandoWiring(config)).toThrow(/persistentFactory/);
	});
});
