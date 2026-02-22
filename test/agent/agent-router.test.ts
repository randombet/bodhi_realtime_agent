// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentRouter } from '../../src/agent/agent-router.js';
import { ConversationContext } from '../../src/core/conversation-context.js';
import { AgentError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/event-bus.js';
import { HooksManager } from '../../src/core/hooks.js';
import { SessionManager } from '../../src/core/session-manager.js';
import type { ClientTransport } from '../../src/transport/client-transport.js';
import type { GeminiLiveTransport } from '../../src/transport/gemini-live-transport.js';
import type { MainAgent } from '../../src/types/agent.js';

// Mock the ai module
vi.mock('ai', () => ({
	generateText: vi.fn(async (opts: { onStepFinish?: (step: unknown) => void }) => {
		opts.onStepFinish?.({ toolCalls: [], usage: { totalTokens: 50 } });
		return { text: 'subagent result' };
	}),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createMockGeminiTransport() {
	return {
		connect: vi.fn(),
		reconnect: vi.fn(),
		disconnect: vi.fn(),
		sendAudio: vi.fn(),
		sendToolResponse: vi.fn(),
		sendClientContent: vi.fn(),
		updateTools: vi.fn(),
		updateSystemInstruction: vi.fn(),
		updateGoogleSearch: vi.fn(),
		isConnected: true,
	};
}

function createMockClientTransport() {
	return {
		startBuffering: vi.fn(),
		stopBuffering: vi.fn(() => []),
		sendAudioToClient: vi.fn(),
		isClientConnected: true,
		buffering: false,
	};
}

function createTestAgent(name: string, overrides?: Partial<MainAgent>): MainAgent {
	return {
		name,
		instructions: `You are ${name}`,
		tools: [],
		...overrides,
	};
}

function setup() {
	const eventBus = new EventBus();
	const hooks = new HooksManager();
	const convCtx = new ConversationContext();
	const sessionMgr = new SessionManager(
		{ sessionId: 'sess_1', userId: 'user_1', initialAgent: 'general' },
		eventBus,
		hooks,
	);
	const gemini = createMockGeminiTransport();
	const client = createMockClientTransport();

	const router = new AgentRouter(
		sessionMgr,
		eventBus,
		hooks,
		convCtx,
		gemini as unknown as GeminiLiveTransport,
		client as unknown as ClientTransport,
		mockModel,
	);

	return { router, eventBus, hooks, convCtx, sessionMgr, gemini, client };
}

describe('AgentRouter', () => {
	describe('registration', () => {
		it('registers and sets initial agent', () => {
			const { router } = setup();
			router.registerAgents([createTestAgent('general'), createTestAgent('booking')]);
			router.setInitialAgent('general');
			expect(router.activeAgent.name).toBe('general');
		});

		it('throws for unknown initial agent', () => {
			const { router } = setup();
			router.registerAgents([createTestAgent('general')]);
			expect(() => router.setInitialAgent('unknown')).toThrow(AgentError);
		});
	});

	describe('transfer', () => {
		it('transfers from one agent to another', async () => {
			const { router, sessionMgr, gemini, client, eventBus } = setup();
			const onExit = vi.fn();
			const onEnter = vi.fn();

			router.registerAgents([
				createTestAgent('general', { onExit }),
				createTestAgent('booking', { onEnter }),
			]);
			router.setInitialAgent('general');

			// Get session to ACTIVE state first
			sessionMgr.transitionTo('CONNECTING');
			sessionMgr.transitionTo('ACTIVE');

			const transferHandler = vi.fn();
			eventBus.subscribe('agent.transfer', transferHandler);

			await router.transfer('booking');

			expect(onExit).toHaveBeenCalledOnce();
			expect(onEnter).toHaveBeenCalledOnce();
			expect(router.activeAgent.name).toBe('booking');
			expect(client.startBuffering).toHaveBeenCalledOnce();
			expect(client.stopBuffering).toHaveBeenCalledOnce();
			expect(gemini.updateSystemInstruction).toHaveBeenCalledWith('You are booking');
			expect(gemini.reconnect).toHaveBeenCalledOnce();
			expect(transferHandler).toHaveBeenCalledWith(
				expect.objectContaining({ fromAgent: 'general', toAgent: 'booking' }),
			);
		});

		it('prepends language directive on transfer when agent has language', async () => {
			const { router, sessionMgr, gemini } = setup();
			router.registerAgents([
				createTestAgent('general'),
				createTestAgent('spanish', { language: 'es-ES' }),
			]);
			router.setInitialAgent('general');
			sessionMgr.transitionTo('CONNECTING');
			sessionMgr.transitionTo('ACTIVE');

			await router.transfer('spanish');

			expect(gemini.updateSystemInstruction).toHaveBeenCalledWith(
				expect.stringContaining('You MUST respond in Spanish'),
			);
			expect(gemini.updateSystemInstruction).toHaveBeenCalledWith(
				expect.stringContaining('You are spanish'),
			);
		});

		it('throws for unknown target agent', async () => {
			const { router } = setup();
			router.registerAgents([createTestAgent('general')]);
			router.setInitialAgent('general');

			await expect(router.transfer('unknown')).rejects.toThrow(AgentError);
		});
	});

	describe('handoff', () => {
		it('spawns subagent and returns result', async () => {
			const { router } = setup();
			router.registerAgents([createTestAgent('general')]);
			router.setInitialAgent('general');

			const result = await router.handoff(
				{ toolCallId: 'tc_1', toolName: 'search', args: { q: 'flights' } },
				{ name: 'search-agent', instructions: 'Search', tools: {} },
			);

			expect(result.text).toBe('subagent result');
			expect(result.stepCount).toBe(1);
			expect(router.activeSubagentCount).toBe(0);
		});

		it('publishes agent.handoff event', async () => {
			const { router, eventBus } = setup();
			router.registerAgents([createTestAgent('general')]);
			router.setInitialAgent('general');

			const handler = vi.fn();
			eventBus.subscribe('agent.handoff', handler);

			await router.handoff(
				{ toolCallId: 'tc_1', toolName: 'search', args: {} },
				{ name: 'search-agent', instructions: 'Search', tools: {} },
			);

			expect(handler).toHaveBeenCalledWith(
				expect.objectContaining({
					subagentName: 'search-agent',
					toolCallId: 'tc_1',
				}),
			);
		});

		it('cancelSubagent aborts the running subagent', async () => {
			const { router } = setup();
			router.registerAgents([createTestAgent('general')]);
			router.setInitialAgent('general');

			// Start a handoff (will resolve quickly due to mock)
			const promise = router.handoff(
				{ toolCallId: 'tc_1', toolName: 'search', args: {} },
				{ name: 'search-agent', instructions: 'Search', tools: {} },
			);

			// Cancel should be safe even if already done
			router.cancelSubagent('tc_1');

			await promise;
			expect(router.activeSubagentCount).toBe(0);
		});
	});
});
