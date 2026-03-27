// SPDX-License-Identifier: MIT

/**
 * RuntimeOrchestrator tests — verifies convenience wiring and lifecycle.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransportAdapter } from '../../src/runtime/adapters/transport-adapter.js';
import { RuntimeOrchestrator } from '../../src/runtime/runtime-orchestrator.js';
import type { OrchestratorConfig } from '../../src/runtime/runtime-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(): TransportAdapter {
	return {
		onSessionReady: undefined,
		onTurnComplete: undefined,
		onInterrupted: undefined,
		onToolCallReceived: undefined,
		onToolCallCancelled: undefined,
		onError: undefined,
		onClosed: undefined,
		sendContent: vi.fn(),
		sendToolResult: vi.fn(),
		transferSession: vi.fn().mockResolvedValue(undefined),
		cancelGeneration: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

function createConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
	return {
		adapter: createMockAdapter(),
		tools: new Map(),
		inlineExecutor: { execute: vi.fn().mockResolvedValue({ result: 'ok' }) },
		clientSend: vi.fn(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeOrchestrator', () => {
	let orchestrator: RuntimeOrchestrator;

	afterEach(async () => {
		if (orchestrator?.isRunning) {
			await orchestrator.stop();
		}
	});

	it('starts and registers all actors', async () => {
		orchestrator = new RuntimeOrchestrator(createConfig());
		expect(orchestrator.isRunning).toBe(false);

		await orchestrator.start();

		expect(orchestrator.isRunning).toBe(true);
		expect(orchestrator.runtime.hasActor('transport')).toBe(true);
		expect(orchestrator.runtime.hasActor('session')).toBe(true);
		expect(orchestrator.runtime.hasActor('tool-router')).toBe(true);
		expect(orchestrator.runtime.hasActor('subagent-supervisor')).toBe(true);
		expect(orchestrator.runtime.hasActor('main-agent')).toBe(true);
		expect(orchestrator.runtime.hasActor('client-gateway')).toBe(true);
	});

	it('stops all actors on stop', async () => {
		orchestrator = new RuntimeOrchestrator(createConfig());
		await orchestrator.start();
		await orchestrator.stop();

		expect(orchestrator.isRunning).toBe(false);
		expect(orchestrator.runtime.hasActor('transport')).toBe(false);
	});

	it('double start throws', async () => {
		orchestrator = new RuntimeOrchestrator(createConfig());
		await orchestrator.start();
		await expect(orchestrator.start()).rejects.toThrow('already started');
	});

	it('double stop is safe', async () => {
		orchestrator = new RuntimeOrchestrator(createConfig());
		await orchestrator.start();
		await orchestrator.stop();
		await orchestrator.stop(); // no throw
	});

	it('wires adapter callbacks to session actor', async () => {
		const adapter = createMockAdapter();
		orchestrator = new RuntimeOrchestrator(createConfig({ adapter }));
		await orchestrator.start();

		// Adapter callbacks should be wired after start
		expect(adapter.onSessionReady).toBeDefined();
		expect(adapter.onTurnComplete).toBeDefined();
		expect(adapter.onToolCallReceived).toBeDefined();
	});

	it('registers agents when provided in config', async () => {
		orchestrator = new RuntimeOrchestrator(
			createConfig({
				agents: [
					{ name: 'general', instructions: 'Be general', tools: [] },
					{ name: 'booking', instructions: 'Handle bookings', tools: [] },
				],
				initialAgent: 'general',
			}),
		);
		await orchestrator.start();

		expect(orchestrator.mainAgentActor.activeAgentName).toBe('general');
	});

	it('full flow: adapter session_ready → session active', async () => {
		const adapter = createMockAdapter();
		orchestrator = new RuntimeOrchestrator(createConfig({ adapter }));
		await orchestrator.start();

		adapter.onSessionReady?.();
		await vi.waitFor(() => expect(orchestrator.sessionActor.currentPhase).toBe('active'));
	});

	it('full flow: inline tool call through the graph', async () => {
		const adapter = createMockAdapter();
		orchestrator = new RuntimeOrchestrator(createConfig({ adapter }));
		await orchestrator.start();

		adapter.onSessionReady?.();
		await vi.waitFor(() => expect(orchestrator.sessionActor.currentPhase).toBe('active'));

		adapter.onToolCallReceived?.([{ id: 'tc-1', name: 'test', args: {} }]);
		await vi.waitFor(() => expect(adapter.sendToolResult).toHaveBeenCalled());
	});

	it('sets up supervisor with default policies', async () => {
		orchestrator = new RuntimeOrchestrator(createConfig());
		await orchestrator.start();

		// Supervisor should be registered
		expect(orchestrator.supervisor).toBeDefined();
	});

	it('provides observer and dead letter queue', () => {
		orchestrator = new RuntimeOrchestrator(createConfig());
		expect(orchestrator.observer).toBeDefined();
		expect(orchestrator.deadLetterQueue).toBeDefined();
	});
});
