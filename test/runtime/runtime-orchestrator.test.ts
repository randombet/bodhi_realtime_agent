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
		capabilities: { messageTruncation: false },
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

	// -- Notification subsystem wiring (step 1.7) ---------------------------

	describe('notification subsystem', () => {
		it('starts NotificationActor and registers it with the runtime', async () => {
			orchestrator = new RuntimeOrchestrator(createConfig());
			await orchestrator.start();
			expect(orchestrator.notificationActor).toBeDefined();
			expect(orchestrator.runtime.hasActor('notification')).toBe(true);
		});

		it('TransportActor self-subscribes; default filter forwards every label', async () => {
			const adapter = createMockAdapter();
			orchestrator = new RuntimeOrchestrator(createConfig({ adapter }));
			await orchestrator.start();

			// Producer publishes with two different labels — both should be wrapped
			// and dispatched to adapter.sendContent (default = subscribe to all labels).
			orchestrator.runtime.tell(
				'notification.publish',
				{ label: 'SYSTEM', text: 's-text' },
				'notification',
			);
			orchestrator.runtime.tell(
				'notification.publish',
				{ label: 'TIME REMINDER', text: 't-text' },
				'notification',
			);

			await vi.waitFor(() => {
				expect(adapter.sendContent).toHaveBeenCalledTimes(2);
			});
			expect(adapter.sendContent).toHaveBeenCalledWith(
				[{ role: 'user', parts: [{ text: '[SYSTEM]: s-text' }] }],
				true,
			);
			expect(adapter.sendContent).toHaveBeenCalledWith(
				[{ role: 'user', parts: [{ text: '[TIME REMINDER]: t-text' }] }],
				true,
			);
		});

		it('does not construct the hooks observer when no callback is configured', async () => {
			orchestrator = new RuntimeOrchestrator(createConfig());
			await orchestrator.start();
			expect(orchestrator.notificationHooksObserver).toBeNull();
			expect(orchestrator.runtime.hasActor('notification-hooks-observer')).toBe(false);
		});

		it('constructs and starts the hooks observer when onBackgroundNotification is configured', async () => {
			const onBackgroundNotification = vi.fn();
			orchestrator = new RuntimeOrchestrator(
				createConfig({
					sessionId: 'sess-1',
					notification: { onBackgroundNotification },
				}),
			);
			await orchestrator.start();
			expect(orchestrator.notificationHooksObserver).not.toBeNull();
			expect(orchestrator.runtime.hasActor('notification-hooks-observer')).toBe(true);
		});

		it('hook fires end-to-end with timing and sessionId fields populated', async () => {
			const onBackgroundNotification = vi.fn();
			orchestrator = new RuntimeOrchestrator(
				createConfig({
					sessionId: 'sess-trace',
					notification: { onBackgroundNotification },
				}),
			);
			await orchestrator.start();

			orchestrator.runtime.tell(
				'notification.publish',
				{ label: 'SYSTEM', text: 'hello' },
				'notification',
			);

			await vi.waitFor(() => {
				expect(onBackgroundNotification).toHaveBeenCalledTimes(1);
			});
			const event = onBackgroundNotification.mock.calls[0][0];
			expect(event.sessionId).toBe('sess-trace');
			expect(event.label).toBe('SYSTEM');
			expect(event.priority).toBe('normal');
			expect(typeof event.publishedAtMs).toBe('number');
			expect(typeof event.deliveredAtMs).toBe('number');
			expect(event.deferredMs).toBeGreaterThanOrEqual(0);
		});

		it('always constructs BackgroundAgentHostActor (even with no backgroundAgents)', async () => {
			orchestrator = new RuntimeOrchestrator(createConfig());
			await orchestrator.start();
			expect(orchestrator.backgroundAgentHost).toBeDefined();
			expect(orchestrator.runtime.hasActor('background-agents')).toBe(true);
		});

		it('adapter.onTurnComplete does NOT flush queued notifications — VoiceSession owns notification.turn_complete (TTS-gating fix)', async () => {
			// Locks in the H1 fix: the raw adapter.onTurnComplete callback fires
			// when the LLM finishes generating, which is BEFORE TTS audio finishes
			// when an external TTSProvider is wired. If TransportActor mirrored
			// that callback to notification.turn_complete (as in step 1.6's
			// original wiring), notifications would flush mid-TTS. Ownership
			// has moved to VoiceSession.handleTurnCompleteInternal — the
			// effective turn boundary that already TTS-gates.
			const adapter = createMockAdapter();
			orchestrator = new RuntimeOrchestrator(createConfig({ adapter }));
			await orchestrator.start();

			// Activate session (so SessionActor is in 'active') and start audio.
			adapter.onSessionReady?.();
			orchestrator.runtime.tell('notification.audio_started', {}, 'notification');

			// Queue a notification.
			orchestrator.runtime.tell(
				'notification.publish',
				{ label: 'SYSTEM', text: 'queued-during-audio' },
				'notification',
			);

			// Wait one tick to let the publish land.
			await new Promise((r) => setTimeout(r, 0));

			// Reset adapter.sendContent recording and fire the RAW transport
			// turn-complete callback. With the fix, this MUST NOT flush.
			(adapter.sendContent as ReturnType<typeof vi.fn>).mockClear();
			adapter.onTurnComplete?.('turn-1');
			await new Promise((r) => setTimeout(r, 10));
			expect(adapter.sendContent).not.toHaveBeenCalled();

			// Now simulate VoiceSession.handleTurnCompleteInternal sending the
			// notification.turn_complete envelope (the new effective boundary).
			orchestrator.runtime.tell('notification.turn_complete', {}, 'notification');
			await vi.waitFor(() => {
				expect(adapter.sendContent).toHaveBeenCalledWith(
					[{ role: 'user', parts: [{ text: '[SYSTEM]: queued-during-audio' }] }],
					true,
				);
			});
		});

		it('end-to-end: agent.transfer_completed reaches BackgroundAgentHost and updates ctx.session.activeAgent', async () => {
			// This test locks in the fix from commit 30c3a16: MainAgentActor sends
			// agent.transfer_completed only to SessionActor; SessionActor must
			// fan it out to 'background-agents' or the host's onAgentTransfer
			// + cancelOnTransfer + ctx.session.activeAgent updates are all dead
			// code in the integrated runtime.
			const onTransfer = vi.fn();
			let observedActiveAgentBefore = '';
			let observedActiveAgentAfter = '';
			const probe = {
				name: 'probe',
				onStart: (ctx: { session: { activeAgent: string } }) => {
					observedActiveAgentBefore = ctx.session.activeAgent;
					(probe as { _readLater?: () => void })._readLater = () => {
						observedActiveAgentAfter = ctx.session.activeAgent;
					};
				},
				onAgentTransfer: onTransfer,
			};
			orchestrator = new RuntimeOrchestrator(
				createConfig({
					sessionId: 'sess-x',
					initialAgent: 'main',
					backgroundAgents: [probe],
				}),
			);
			await orchestrator.start();

			// Drive the session into 'active'.
			orchestrator.runtime.tell('transport.session_ready', {}, 'session');
			await vi.waitFor(() => expect(observedActiveAgentBefore).toBe('main'));

			// Send agent.transfer_completed straight to SessionActor (mimics
			// MainAgentActor's emit path — main-agent-actor.ts:141).
			orchestrator.runtime.tell(
				'agent.transfer_completed',
				{ fromAgent: 'main', toAgent: 'specialist', transferCorrelationId: 't-1' },
				'session',
			);

			await vi.waitFor(() => expect(onTransfer).toHaveBeenCalledTimes(1));
			expect(onTransfer).toHaveBeenCalledWith({ fromAgent: 'main', toAgent: 'specialist' });

			(probe as { _readLater?: () => void })._readLater?.();
			expect(observedActiveAgentAfter).toBe('specialist');
		});

		it('end-to-end: BackgroundAgent.onStart fires after first session.connected; ctx.publish reaches the wire', async () => {
			const adapter = createMockAdapter();
			const onStart = vi.fn();
			const reminder = {
				name: 'reminder',
				onStart: (ctx: {
					sessionId: string;
					publish: (n: { label: string; text: string }) => void;
				}) => {
					onStart(ctx.sessionId);
					ctx.publish({ label: 'TIME REMINDER', text: '5 min left' });
				},
			};
			orchestrator = new RuntimeOrchestrator(
				createConfig({
					adapter,
					sessionId: 'sess-1',
					backgroundAgents: [reminder],
				}),
			);
			await orchestrator.start();

			// Trigger the SessionActor → 'background-agents' fan-out chain.
			adapter.onSessionReady?.();

			// onStart fires once.
			await vi.waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
			expect(onStart).toHaveBeenCalledWith('sess-1');

			// And ctx.publish reaches TransportActor → adapter.sendContent
			// (wrapped as "[TIME REMINDER]: 5 min left").
			await vi.waitFor(() => {
				expect(adapter.sendContent).toHaveBeenCalledWith(
					[{ role: 'user', parts: [{ text: '[TIME REMINDER]: 5 min left' }] }],
					true,
				);
			});
		});

		it('honors a custom transportSubscriptionFilter end-to-end (label allowlist)', async () => {
			const adapter = createMockAdapter();
			orchestrator = new RuntimeOrchestrator(
				createConfig({
					adapter,
					notification: { transportSubscriptionFilter: { labels: ['SYSTEM'] } },
				}),
			);
			await orchestrator.start();

			// Two publishes — only SYSTEM should reach the adapter.
			orchestrator.runtime.tell(
				'notification.publish',
				{ label: 'SYSTEM', text: 'should-pass' },
				'notification',
			);
			orchestrator.runtime.tell(
				'notification.publish',
				{ label: 'TIME REMINDER', text: 'should-be-filtered' },
				'notification',
			);

			// Wait for the SYSTEM one to land; assert the filtered one never does.
			await vi.waitFor(() => {
				expect(adapter.sendContent).toHaveBeenCalledWith(
					[{ role: 'user', parts: [{ text: '[SYSTEM]: should-pass' }] }],
					true,
				);
			});
			// Drain microtasks then verify only one sendContent call was made.
			await vi.waitFor(() => {
				expect(adapter.sendContent).toHaveBeenCalledTimes(1);
			});
		});
	});
});
