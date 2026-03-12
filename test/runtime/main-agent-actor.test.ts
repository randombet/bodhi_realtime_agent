// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '../../src/runtime/actors/main-agent-actor.js';
import { MainAgentActor } from '../../src/runtime/actors/main-agent-actor.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SentMessage {
	type: string;
	payload: unknown;
	to: string;
}

function setup(agents: AgentDefinition[] = []) {
	const messages: SentMessage[] = [];
	const send = (type: string, payload: unknown, to: string) => {
		messages.push({ type, payload, to });
	};

	const hooks = {
		onAgentTransfer: vi.fn(),
		onError: vi.fn(),
	};

	const actor = new MainAgentActor('main-agent', send, 'transport', 'session', hooks);

	if (agents.length > 0) {
		actor.registerAgents(agents);
	}

	return { actor, messages, hooks };
}

function makeAgent(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name,
		instructions: `Instructions for ${name}`,
		tools: [],
		...overrides,
	};
}

function transferEnvelope(toAgent: string, correlationId = 'corr-1') {
	return createEnvelope(
		'agent.transfer_requested',
		{ toAgent, transferCorrelationId: correlationId },
		'main-agent',
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MainAgentActor', () => {
	let actor: MainAgentActor;
	let messages: SentMessage[];
	let hooks: { onAgentTransfer: ReturnType<typeof vi.fn>; onError: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		const agents = [makeAgent('general'), makeAgent('booking')];
		const s = setup(agents);
		actor = s.actor;
		messages = s.messages;
		hooks = s.hooks;
		actor.setActiveAgent('general');
	});

	// -- Transfer success ---------------------------------------------------

	describe('transfer success', () => {
		it('sends transfer_session to transport and transfer_completed to session', async () => {
			await actor.onMessage(transferEnvelope('booking'));

			const transfer = messages.find((m) => m.type === 'transport.transfer_session');
			expect(transfer).toBeDefined();
			expect(transfer?.to).toBe('transport');

			const completed = messages.find((m) => m.type === 'agent.transfer_completed');
			expect(completed).toBeDefined();
			expect(completed?.to).toBe('session');
			expect((completed?.payload as { toAgent: string }).toAgent).toBe('booking');
		});

		it('updates active agent name on success', async () => {
			expect(actor.activeAgentName).toBe('general');

			await actor.onMessage(transferEnvelope('booking'));

			expect(actor.activeAgentName).toBe('booking');
		});

		it('fires onAgentTransfer hook', async () => {
			await actor.onMessage(transferEnvelope('booking', 'corr-42'));

			expect(hooks.onAgentTransfer).toHaveBeenCalledWith({
				fromAgent: 'general',
				toAgent: 'booking',
				transferCorrelationId: 'corr-42',
			});
		});
	});

	// -- Hook invocation order -----------------------------------------------

	describe('hook invocation order', () => {
		it('calls onExit before onEnter', async () => {
			const callOrder: string[] = [];

			const general = makeAgent('general', {
				onExit: vi.fn().mockImplementation(() => {
					callOrder.push('onExit:general');
				}),
			});
			const booking = makeAgent('booking', {
				onEnter: vi.fn().mockImplementation(() => {
					callOrder.push('onEnter:booking');
				}),
			});

			const s = setup([general, booking]);
			s.actor.setActiveAgent('general');

			await s.actor.onMessage(transferEnvelope('booking'));

			expect(callOrder).toEqual(['onExit:general', 'onEnter:booking']);
		});

		it('handles agents without hooks gracefully', async () => {
			// Default agents have no onExit/onEnter — should not throw
			await actor.onMessage(transferEnvelope('booking'));

			expect(actor.activeAgentName).toBe('booking');
		});
	});

	// -- Transfer failure ---------------------------------------------------

	describe('transfer failure', () => {
		it('sends transfer_failed for unknown agent', async () => {
			await actor.onMessage(transferEnvelope('nonexistent'));

			const failed = messages.find((m) => m.type === 'agent.transfer_failed');
			expect(failed).toBeDefined();
			expect(failed?.to).toBe('session');
			expect((failed?.payload as { error: string }).error).toContain('Unknown agent');
		});

		it('sends transfer_failed when onExit throws', async () => {
			const general = makeAgent('general', {
				onExit: vi.fn().mockRejectedValue(new Error('exit failed')),
			});
			const booking = makeAgent('booking');

			const s = setup([general, booking]);
			s.actor.setActiveAgent('general');

			await s.actor.onMessage(transferEnvelope('booking'));

			const failed = s.messages.find((m) => m.type === 'agent.transfer_failed');
			expect(failed).toBeDefined();
			expect((failed?.payload as { error: string }).error).toBe('exit failed');
		});

		it('fires onError hook on transfer failure', async () => {
			const general = makeAgent('general', {
				onExit: vi.fn().mockRejectedValue(new Error('boom')),
			});
			const booking = makeAgent('booking');

			const s = setup([general, booking]);
			s.actor.setActiveAgent('general');

			await s.actor.onMessage(transferEnvelope('booking'));

			expect(s.hooks.onError).toHaveBeenCalledWith(
				expect.objectContaining({
					component: 'main-agent-actor',
					error: 'boom',
				}),
			);
		});

		it('does not change active agent on failure', async () => {
			const general = makeAgent('general', {
				onExit: vi.fn().mockRejectedValue(new Error('fail')),
			});

			const s = setup([general, makeAgent('booking')]);
			s.actor.setActiveAgent('general');

			await s.actor.onMessage(transferEnvelope('booking'));

			// Active agent should still be general since onExit failed
			expect(s.actor.activeAgentName).toBe('general');
		});
	});

	// -- No active agent ---------------------------------------------------

	describe('no initial active agent', () => {
		it('uses "none" as fromAgent when no active agent set', async () => {
			const s = setup([makeAgent('booking')]);
			// Don't set active agent

			await s.actor.onMessage(transferEnvelope('booking'));

			const completed = s.messages.find((m) => m.type === 'agent.transfer_completed');
			expect(completed).toBeDefined();
			expect((completed?.payload as { fromAgent: string }).fromAgent).toBe('none');
		});
	});
});
