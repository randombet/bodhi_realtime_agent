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
		});

		it('onSessionReady → transport.session_ready to session actor', () => {
			adapter.onSessionReady?.();
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.session_ready');
			expect(sender.messages[0].to).toBe('session');
		});

		it('onTurnComplete → transport.turn_complete to session actor', () => {
			adapter.onTurnComplete?.('turn-1');
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.turn_complete');
			expect(sender.messages[0].to).toBe('session');
			expect(sender.messages[0].payload).toEqual({ turnId: 'turn-1' });
		});

		it('onInterrupted → transport.interrupted to session actor', () => {
			adapter.onInterrupted?.();
			expect(sender.messages).toHaveLength(1);
			expect(sender.messages[0].type).toBe('transport.interrupted');
			expect(sender.messages[0].to).toBe('session');
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
});
