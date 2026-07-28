import { describe, expect, it, vi } from 'vitest';
import { TransportActor } from '../../src/runtime/actors/transport-actor.js';
import type { TransportAdapter } from '../../src/runtime/adapters/transport-adapter.js';
import { createEnvelope } from '../../src/runtime/envelope.js';

/** P1-2: actor-mode notification delivery is a generation-capable path. The
 *  delivery hook must fire BEFORE the wire-out so VoiceSession can invalidate
 *  a live greeting token — otherwise the notification's model turn could
 *  bind as the greeting. */

function createAdapter(): TransportAdapter {
	return {
		capabilities: { messageTruncation: false },
		sendContent: vi.fn(),
		sendToolResult: vi.fn(),
		transferSession: vi.fn().mockResolvedValue(undefined),
		cancelGeneration: vi.fn(),
		triggerGeneration: vi.fn(),
	} as unknown as TransportAdapter;
}

describe('TransportActor notification delivery hook', () => {
	it('invokes onNotificationDelivered before adapter.sendContent', async () => {
		const adapter = createAdapter();
		const delivered = vi.fn();
		const actor = new TransportActor(
			'transport',
			adapter,
			() => {},
			'session',
			'tool-router',
			'notification',
			undefined,
			delivered,
		);
		await actor.onStart();

		await actor.onMessage(
			createEnvelope(
				'notification.delivered',
				{ label: 'REMINDER', text: 'meeting in 5', turnComplete: true },
				'transport',
			),
		);

		expect(delivered).toHaveBeenCalledTimes(1);
		expect(adapter.sendContent).toHaveBeenCalledTimes(1);
		const sendContentMock = adapter.sendContent as ReturnType<typeof vi.fn>;
		expect(delivered.mock.invocationCallOrder[0]).toBeLessThan(
			sendContentMock.mock.invocationCallOrder[0],
		);
	});

	it('delivery still writes when no hook is wired (hook is optional)', async () => {
		const adapter = createAdapter();
		const actor = new TransportActor('transport', adapter, () => {}, 'session', 'tool-router');
		await actor.onStart();
		await actor.onMessage(
			createEnvelope(
				'notification.delivered',
				{ label: 'REMINDER', text: 'meeting in 5', turnComplete: true },
				'transport',
			),
		);
		expect(adapter.sendContent).toHaveBeenCalledTimes(1);
	});
});
