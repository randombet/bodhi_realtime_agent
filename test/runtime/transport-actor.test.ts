// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportActor } from '../../src/runtime/actors/transport-actor.js';
import type { TransportAdapter } from '../../src/runtime/adapters/transport-adapter.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

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

interface SentMessage {
	type: string;
	payload: unknown;
	to: string;
}

function createMessageSender(): {
	send: (type: string, payload: unknown, to: string) => void;
	messages: SentMessage[];
} {
	const messages: SentMessage[] = [];
	return {
		send: (type: string, payload: unknown, to: string) => {
			messages.push({ type, payload, to });
		},
		messages,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransportActor', () => {
	let adapter: TransportAdapter;
	let sender: ReturnType<typeof createMessageSender>;
	let actor: TransportActor;

	beforeEach(() => {
		adapter = createMockAdapter();
		sender = createMessageSender();
		actor = new TransportActor(
			'transport',
			adapter,
			sender.send,
			'session', // sessionActorId
			'tool-router', // toolRouterActorId
		);
	});

	// -- Lifecycle -----------------------------------------------------------

	describe('lifecycle', () => {
		it('onStart wires adapter callbacks', async () => {
			await actor.onStart();

			// All inbound callbacks should be wired
			expect(adapter.onSessionReady).toBeDefined();
			expect(adapter.onTurnComplete).toBeDefined();
			expect(adapter.onInterrupted).toBeDefined();
			expect(adapter.onToolCallReceived).toBeDefined();
			expect(adapter.onToolCallCancelled).toBeDefined();
			expect(adapter.onError).toBeDefined();
			expect(adapter.onClosed).toBeDefined();
		});

		it('onStop clears adapter callbacks', async () => {
			await actor.onStart();
			await actor.onStop('shutdown');

			expect(adapter.onSessionReady).toBeUndefined();
			expect(adapter.onTurnComplete).toBeUndefined();
			expect(adapter.onInterrupted).toBeUndefined();
			expect(adapter.onToolCallReceived).toBeUndefined();
			expect(adapter.onToolCallCancelled).toBeUndefined();
			expect(adapter.onError).toBeUndefined();
			expect(adapter.onClosed).toBeUndefined();
		});
	});

	// -- Inbound: adapter callbacks → canonical messages ----------------------

	describe('inbound callback → canonical message', () => {
		beforeEach(async () => {
			await actor.onStart();
			// onStart now sends an initial `notification.subscribe` envelope; clear
			// it so each test asserts against only the messages produced by the
			// adapter callback under test.
			sender.messages.length = 0;
		});

		it('onSessionReady → transport.session_ready to session actor', () => {
			adapter.onSessionReady?.();
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.session_ready');
			expect(sender.messages[0].to).toBe('session');
		});

		it('onTurnComplete → transport.turn_complete to session + notification.turn_complete to notification', () => {
			adapter.onTurnComplete?.('turn-1');
			// One mirror to SessionActor (existing) + one mirror to NotificationActor (new).
			expect(sender.messages).toHaveLength(2);
			const toSession = sender.messages.find((m) => m.to === 'session');
			expect(toSession?.type).toBe('transport.turn_complete');
			expect(toSession?.payload).toEqual({ turnId: 'turn-1' });
			const toNotification = sender.messages.find((m) => m.to === 'notification');
			expect(toNotification?.type).toBe('notification.turn_complete');
			expect(toNotification?.payload).toEqual({ turnId: 'turn-1' });
		});

		it('onInterrupted → transport.interrupted, then paired notification.reset_audio + interrupted (in order)', () => {
			adapter.onInterrupted?.();
			// SessionActor mirror plus the notification pair.
			expect(sender.messages).toHaveLength(3);
			expect(sender.messages[0].type).toBe('transport.interrupted');
			expect(sender.messages[0].to).toBe('session');
			// Order matters: reset_audio first, then interrupted (mirrors legacy
			// VoiceSession.handleInterrupted: resetAudio() then markInterrupted()).
			expect(sender.messages[1].type).toBe('notification.reset_audio');
			expect(sender.messages[1].to).toBe('notification');
			expect(sender.messages[2].type).toBe('notification.interrupted');
			expect(sender.messages[2].to).toBe('notification');
		});

		it('onToolCallReceived → transport.tool_call_received to tool-router', () => {
			const calls = [{ id: 'tc-1', name: 'get_weather', args: { city: 'NYC' } }];
			adapter.onToolCallReceived?.(calls);
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.tool_call_received');
			expect(sender.messages[0].to).toBe('tool-router');
			expect(sender.messages[0].payload).toEqual({ calls });
		});

		it('onToolCallCancelled → transport.tool_call_cancelled to tool-router', () => {
			adapter.onToolCallCancelled?.(['tc-1', 'tc-2']);
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.tool_call_cancelled');
			expect(sender.messages[0].to).toBe('tool-router');
			expect(sender.messages[0].payload).toEqual({ ids: ['tc-1', 'tc-2'] });
		});

		it('onError → transport.error to session actor', () => {
			adapter.onError?.('connection lost', true);
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.error');
			expect(sender.messages[0].to).toBe('session');
			expect(sender.messages[0].payload).toEqual({
				error: 'connection lost',
				recoverable: true,
			});
		});

		it('onClosed → transport.closed to session actor', () => {
			adapter.onClosed?.('server shutdown');
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.closed');
			expect(sender.messages[0].to).toBe('session');
			expect(sender.messages[0].payload).toEqual({ reason: 'server shutdown' });
		});
	});

	// -- Outbound: canonical messages → adapter commands ----------------------

	describe('outbound message → adapter command', () => {
		it('transport.send_content dispatches to adapter.sendContent', async () => {
			const content = [{ role: 'user', parts: [{ text: 'hello' }] }];
			await actor.onMessage(
				createEnvelope('transport.send_content', { content, turnComplete: true }, 'transport'),
			);
			expect(adapter.sendContent).toHaveBeenCalledWith(content, true);
		});

		it('transport.send_tool_result dispatches to adapter.sendToolResult', async () => {
			await actor.onMessage(
				createEnvelope(
					'transport.send_tool_result',
					{ id: 'tc-1', name: 'get_weather', result: { temp: 72 }, scheduling: 'immediate' },
					'transport',
				),
			);
			expect(adapter.sendToolResult).toHaveBeenCalledWith(
				'tc-1',
				'get_weather',
				{ temp: 72 },
				'immediate',
			);
		});

		it('transport.transfer_session dispatches to adapter.transferSession', async () => {
			const config = { instructions: 'new agent', tools: [], providerOptions: {} };
			const state = { conversationHistory: [] };
			await actor.onMessage(
				createEnvelope('transport.transfer_session', { config, state }, 'transport'),
			);
			expect(adapter.transferSession).toHaveBeenCalledWith(config, state);
		});

		it('transport.cancel_generation dispatches to adapter.cancelGeneration', async () => {
			await actor.onMessage(createEnvelope('transport.cancel_generation', {}, 'transport'));
			expect(adapter.cancelGeneration).toHaveBeenCalled();
		});

		it('transport.trigger_generation dispatches to adapter.triggerGeneration', async () => {
			await actor.onMessage(createEnvelope('transport.trigger_generation', {}, 'transport'));
			expect(adapter.triggerGeneration).toHaveBeenCalled();
		});

		it('unknown message type is silently ignored', async () => {
			// Should not throw
			await actor.onMessage(createEnvelope('unknown.message', {}, 'transport'));
		});
	});

	// -- Tool result scheduling preserved ------------------------------------

	describe('tool result scheduling', () => {
		it('preserves immediate scheduling', async () => {
			await actor.onMessage(
				createEnvelope(
					'transport.send_tool_result',
					{ id: 'tc-1', name: 'tool', result: 'ok', scheduling: 'immediate' },
					'transport',
				),
			);
			expect(adapter.sendToolResult).toHaveBeenCalledWith('tc-1', 'tool', 'ok', 'immediate');
		});

		it('preserves when_idle scheduling', async () => {
			await actor.onMessage(
				createEnvelope(
					'transport.send_tool_result',
					{ id: 'tc-1', name: 'tool', result: 'ok', scheduling: 'when_idle' },
					'transport',
				),
			);
			expect(adapter.sendToolResult).toHaveBeenCalledWith('tc-1', 'tool', 'ok', 'when_idle');
		});
	});

	// -- NotificationActor subscription + delivery handler ------------------

	describe('notification subsystem subscription', () => {
		it('onStart sends notification.subscribe with default (no filter)', async () => {
			await actor.onStart();
			const sub = sender.messages.find((m) => m.type === 'notification.subscribe');
			expect(sub).toBeDefined();
			expect(sub?.to).toBe('notification');
			expect(sub?.payload).toEqual({ subscriberId: 'transport', filter: undefined });
		});

		it('onStart honors a configured transportSubscriptionFilter', async () => {
			const filteredSender = createMessageSender();
			const filteredActor = new TransportActor(
				'transport',
				createMockAdapter(),
				filteredSender.send,
				'session',
				'tool-router',
				'notification',
				{ labels: ['SYSTEM'], minPriority: 'high' },
			);
			await filteredActor.onStart();
			const sub = filteredSender.messages.find((m) => m.type === 'notification.subscribe');
			expect(sub?.payload).toEqual({
				subscriberId: 'transport',
				filter: { labels: ['SYSTEM'], minPriority: 'high' },
			});
		});

		it('honors a custom notificationActorId', async () => {
			const customSender = createMessageSender();
			const customActor = new TransportActor(
				'transport',
				createMockAdapter(),
				customSender.send,
				'session',
				'tool-router',
				'my-notify',
			);
			await customActor.onStart();
			const sub = customSender.messages.find((m) => m.type === 'notification.subscribe');
			expect(sub?.to).toBe('my-notify');
		});

		it('onStop sends notification.unsubscribe', async () => {
			await actor.onStart();
			sender.messages.length = 0;
			await actor.onStop('shutdown');
			const unsub = sender.messages.find((m) => m.type === 'notification.unsubscribe');
			expect(unsub).toBeDefined();
			expect(unsub?.to).toBe('notification');
			expect(unsub?.payload).toEqual({ subscriberId: 'transport' });
		});
	});

	describe('notification.delivered handler (wire-out path)', () => {
		it('builds [label]: text and dispatches to adapter.sendContent', async () => {
			await actor.onMessage(
				createEnvelope(
					'notification.delivered',
					{
						id: 'n-1',
						label: 'SYSTEM',
						text: 'background task generate_image completed',
						priority: 'normal',
						turnComplete: true,
						publishedAtMs: 1,
						deliveredAtMs: 2,
						deferredMs: 1,
					},
					'transport',
				),
			);
			expect(adapter.sendContent).toHaveBeenCalledWith(
				[
					{
						role: 'user',
						parts: [{ text: '[SYSTEM]: background task generate_image completed' }],
					},
				],
				true,
			);
		});

		it('preserves turnComplete=false from the delivered payload', async () => {
			await actor.onMessage(
				createEnvelope(
					'notification.delivered',
					{
						id: 'n-2',
						label: 'SUBAGENT QUESTION',
						text: 'which airline?',
						priority: 'high',
						turnComplete: false,
						publishedAtMs: 1,
						deliveredAtMs: 1,
						deferredMs: 0,
					},
					'transport',
				),
			);
			expect(adapter.sendContent).toHaveBeenCalledWith(
				[{ role: 'user', parts: [{ text: '[SUBAGENT QUESTION]: which airline?' }] }],
				false,
			);
		});

		// "Cancel-and-deliver" for high-priority on truncation-capable transport
		// (OpenAI). The design contract states that a high-priority notification
		// arriving during an active response must interrupt the model audio
		// before the new synthetic turn lands; sendContent alone does not do this.
		describe('cancel-and-deliver semantics', () => {
			it('cancels generation BEFORE sending on high-priority + messageTruncation=true (OpenAI)', async () => {
				const truncationAdapter = createMockAdapter();
				truncationAdapter.capabilities = { messageTruncation: true };
				const truncationSender = createMessageSender();
				const truncationActor = new TransportActor(
					'transport',
					truncationAdapter,
					truncationSender.send,
					'session',
					'tool-router',
				);

				await truncationActor.onMessage(
					createEnvelope(
						'notification.delivered',
						{
							id: 'n-h',
							label: 'SUBAGENT QUESTION',
							text: 'urgent question',
							priority: 'high',
							turnComplete: true,
							publishedAtMs: 1,
							deliveredAtMs: 2,
							deferredMs: 1,
						},
						'transport',
					),
				);

				// Both calls fire, in order: cancel first, then sendContent.
				expect(truncationAdapter.cancelGeneration).toHaveBeenCalledTimes(1);
				expect(truncationAdapter.sendContent).toHaveBeenCalledTimes(1);
				const cancelOrder = (truncationAdapter.cancelGeneration as ReturnType<typeof vi.fn>).mock
					.invocationCallOrder[0];
				const sendOrder = (truncationAdapter.sendContent as ReturnType<typeof vi.fn>).mock
					.invocationCallOrder[0];
				expect(cancelOrder).toBeLessThan(sendOrder);
			});

			it('does NOT cancel on Gemini (messageTruncation=false) even for high-priority', async () => {
				// Default mock adapter has messageTruncation: false.
				await actor.onMessage(
					createEnvelope(
						'notification.delivered',
						{
							id: 'n-h',
							label: 'SUBAGENT QUESTION',
							text: 'urgent',
							priority: 'high',
							turnComplete: true,
							publishedAtMs: 1,
							deliveredAtMs: 2,
							deferredMs: 1,
						},
						'transport',
					),
				);
				expect(adapter.cancelGeneration).not.toHaveBeenCalled();
				expect(adapter.sendContent).toHaveBeenCalledTimes(1);
			});

			it('does NOT cancel on normal-priority notifications even on truncation transport', async () => {
				const truncationAdapter = createMockAdapter();
				truncationAdapter.capabilities = { messageTruncation: true };
				const truncationSender = createMessageSender();
				const truncationActor = new TransportActor(
					'transport',
					truncationAdapter,
					truncationSender.send,
					'session',
					'tool-router',
				);

				await truncationActor.onMessage(
					createEnvelope(
						'notification.delivered',
						{
							id: 'n-n',
							label: 'SYSTEM',
							text: 'normal-priority text',
							priority: 'normal',
							turnComplete: true,
							publishedAtMs: 1,
							deliveredAtMs: 2,
							deferredMs: 1,
						},
						'transport',
					),
				);
				expect(truncationAdapter.cancelGeneration).not.toHaveBeenCalled();
				expect(truncationAdapter.sendContent).toHaveBeenCalledTimes(1);
			});
		});
	});
});
