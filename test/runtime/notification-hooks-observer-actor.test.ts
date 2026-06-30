/**
 * Tests for `NotificationHooksObserverActor` — the built-in observability
 * subscriber that fires `FrameworkHooks.onBackgroundNotification` for every
 * delivered notification.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActorSendOptions } from '../../src/runtime/actor-send-fn.js';
import {
	NotificationHooksObserverActor,
	type OnBackgroundNotificationCallback,
} from '../../src/runtime/actors/notification-hooks-observer-actor.js';
import type { ActorId } from '../../src/runtime/envelope.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import type { RuntimeMessage } from '../../src/runtime/messages.js';

interface RecordedSend {
	type: RuntimeMessage['type'];
	payload: unknown;
	to: ActorId;
	options?: ActorSendOptions;
}

function makeActor(callback: OnBackgroundNotificationCallback, sessionId = 'sess-1') {
	const sends: RecordedSend[] = [];
	const sendMessage = vi.fn(
		(type: RuntimeMessage['type'], payload: unknown, to: ActorId, options?: ActorSendOptions) => {
			sends.push({ type, payload, to, options });
		},
	);
	const actor = new NotificationHooksObserverActor(
		'notification-hooks-observer',
		sendMessage,
		'notification',
		callback,
		sessionId,
	);
	return { actor, sends };
}

describe('NotificationHooksObserverActor', () => {
	it('subscribes to all labels in onStart', async () => {
		const callback = vi.fn();
		const { actor, sends } = makeActor(callback);

		await actor.onStart();

		const sub = sends.find((s) => s.type === 'notification.subscribe');
		expect(sub).toBeDefined();
		expect(sub?.to).toBe('notification');
		expect(sub?.payload).toEqual({ subscriberId: 'notification-hooks-observer' });
	});

	it('fires the callback with the full event payload on notification.delivered', async () => {
		const callback = vi.fn();
		const { actor } = makeActor(callback, 'session-42');

		await actor.onMessage(
			createEnvelope(
				'notification.delivered',
				{
					id: 'n-1',
					label: 'SYSTEM',
					text: 'completion text',
					priority: 'normal',
					turnComplete: true,
					publishedAtMs: 1000,
					deliveredAtMs: 1500,
					deferredMs: 500,
				},
				'notification-hooks-observer',
				{ correlationId: 'trace-abc' },
			),
		);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith({
			sessionId: 'session-42',
			id: 'n-1',
			label: 'SYSTEM',
			priority: 'normal',
			publishedAtMs: 1000,
			deliveredAtMs: 1500,
			deferredMs: 500,
			correlationId: 'trace-abc',
		});
	});

	it('passes correlationId=undefined when the envelope has none', async () => {
		const callback = vi.fn();
		const { actor } = makeActor(callback);

		await actor.onMessage(
			createEnvelope(
				'notification.delivered',
				{
					id: 'n-1',
					label: 'SYSTEM',
					text: '',
					priority: 'normal',
					turnComplete: true,
					publishedAtMs: 1,
					deliveredAtMs: 1,
					deferredMs: 0,
				},
				'notification-hooks-observer',
			),
		);

		expect(callback).toHaveBeenCalledWith(expect.objectContaining({ correlationId: undefined }));
	});

	it('ignores non-notification.delivered envelopes', async () => {
		const callback = vi.fn();
		const { actor } = makeActor(callback);

		await actor.onMessage(
			createEnvelope(
				'notification.publish',
				{ label: 'SYSTEM', text: 'x' },
				'notification-hooks-observer',
			),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it('does not throw when the consumer callback throws (resume policy semantics)', async () => {
		const callback = vi.fn(() => {
			throw new Error('consumer hook crashed');
		});
		const { actor } = makeActor(callback);

		await expect(
			actor.onMessage(
				createEnvelope(
					'notification.delivered',
					{
						id: 'n-1',
						label: 'SYSTEM',
						text: '',
						priority: 'normal',
						turnComplete: true,
						publishedAtMs: 1,
						deliveredAtMs: 1,
						deferredMs: 0,
					},
					'notification-hooks-observer',
				),
			),
		).resolves.not.toThrow();
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('unsubscribes in onStop', async () => {
		const callback = vi.fn();
		const { actor, sends } = makeActor(callback);

		await actor.onStart();
		sends.length = 0;
		await actor.onStop('shutdown');

		const unsub = sends.find((s) => s.type === 'notification.unsubscribe');
		expect(unsub).toBeDefined();
		expect(unsub?.payload).toEqual({ subscriberId: 'notification-hooks-observer' });
	});
});
