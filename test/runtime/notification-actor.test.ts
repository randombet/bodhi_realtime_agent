// SPDX-License-Identifier: MIT

/**
 * Tests for `NotificationActor` (`src/runtime/actors/notification-actor.ts`).
 *
 * Two halves:
 *   1. Parity with legacy `BackgroundNotificationQueue` — every test case
 *      from `test/core/background-notification-queue.test.ts` is mirrored here
 *      via mailbox sends, asserting identical delivery order and timing.
 *   2. New behaviors specific to the actor: subscribe/unsubscribe/filter,
 *      dedupKey replacement (queued + immediate paths), label normalization,
 *      correlationId propagation, clear empties the queue.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ActorSendOptions } from '../../src/runtime/actor-send-fn.js';
import { NotificationActor, normalizeLabel } from '../../src/runtime/actors/notification-actor.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import type { ActorId } from '../../src/runtime/envelope.js';
import type { RuntimeMessage } from '../../src/runtime/messages.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface RecordedSend {
	type: RuntimeMessage['type'];
	payload: unknown;
	to: ActorId;
	options?: ActorSendOptions;
}

function makeActor(opts: { messageTruncation?: boolean } = {}) {
	const sends: RecordedSend[] = [];
	const sendMessage = vi.fn(
		(type: RuntimeMessage['type'], payload: unknown, to: ActorId, options?: ActorSendOptions) => {
			sends.push({ type, payload, to, options });
		},
	);
	const actor = new NotificationActor('notification', sendMessage, {
		messageTruncation: opts.messageTruncation ?? false,
	});
	return { actor, sends, sendMessage };
}

async function tell(
	actor: NotificationActor,
	type: RuntimeMessage['type'],
	payload: unknown,
	options?: { correlationId?: string },
): Promise<void> {
	await actor.onMessage(createEnvelope(type, payload, 'notification', options));
}

async function subscribe(
	actor: NotificationActor,
	subscriberId: string,
	filter?: { labels?: string[]; minPriority?: 'normal' | 'high' },
) {
	await tell(actor, 'notification.subscribe', { subscriberId, filter });
}

async function publish(
	actor: NotificationActor,
	label: string,
	text: string,
	extra: {
		priority?: 'normal' | 'high';
		turnComplete?: boolean;
		dedupKey?: string;
		id?: string;
	} = {},
	envelopeOptions?: { correlationId?: string },
) {
	await tell(actor, 'notification.publish', { label, text, ...extra }, envelopeOptions);
}

/** Filter recorded sends down to the `notification.delivered` payloads. */
function delivered(sends: RecordedSend[]) {
	return sends.filter((s) => s.type === 'notification.delivered');
}

// ---------------------------------------------------------------------------
// Half 1: parity with BackgroundNotificationQueue
// ---------------------------------------------------------------------------

describe('NotificationActor — parity with BackgroundNotificationQueue', () => {
	it('sends immediately when no audio has been received', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await publish(actor, 'SYSTEM', 'hello');

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect(out[0].to).toBe('transport');
		expect((out[0].payload as { text: string }).text).toBe('hello');
	});

	it('queues when audio has been received', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'SYSTEM', 'hello');

		expect(delivered(sends)).toHaveLength(0);
	});

	it('flushes one queued notification on natural turn complete', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'SYSTEM', 'msg1');
		await publish(actor, 'SYSTEM', 'msg2');

		await tell(actor, 'notification.turn_complete', {});

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect((out[0].payload as { text: string }).text).toBe('msg1');
	});

	it('does NOT flush on interrupted turn (interrupted then turn_complete)', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'SYSTEM', 'hello');
		// Match TransportActor.onInterrupted: reset_audio FIRST, then interrupted.
		await tell(actor, 'notification.reset_audio', {});
		await tell(actor, 'notification.interrupted', {});
		await tell(actor, 'notification.turn_complete', {});

		expect(delivered(sends)).toHaveLength(0);
	});

	it('flushes remaining after interrupted turn on next natural turn', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'SYSTEM', 'hello');
		await tell(actor, 'notification.reset_audio', {});
		await tell(actor, 'notification.interrupted', {});
		await tell(actor, 'notification.turn_complete', {});
		expect(delivered(sends)).toHaveLength(0);

		// Next natural turn complete should flush.
		await tell(actor, 'notification.turn_complete', {});
		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect((out[0].payload as { text: string }).text).toBe('hello');
	});

	it('clear drops all queued notifications', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'SYSTEM', 'msg1');
		await publish(actor, 'SYSTEM', 'msg2');
		await tell(actor, 'notification.clear', { reason: 'test' });

		await tell(actor, 'notification.turn_complete', {});
		expect(delivered(sends)).toHaveLength(0);
	});

	it('reset_audio allows immediate send on next call', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await tell(actor, 'notification.reset_audio', {});
		await publish(actor, 'SYSTEM', 'hello');

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect((out[0].payload as { text: string }).text).toBe('hello');
	});

	describe('priority: high', () => {
		it('delivers immediately when idle (no audio)', async () => {
			const { actor, sends } = makeActor();
			await subscribe(actor, 'transport');

			await publish(actor, 'SYSTEM', 'urgent', { priority: 'high' });

			const out = delivered(sends);
			expect(out).toHaveLength(1);
			expect((out[0].payload as { priority: string }).priority).toBe('high');
		});

		it('queues at front when busy on non-truncation transport (Gemini)', async () => {
			const { actor, sends } = makeActor({ messageTruncation: false });
			await subscribe(actor, 'transport');

			await tell(actor, 'notification.audio_started', {});
			await publish(actor, 'SYSTEM', 'normal1');
			await publish(actor, 'SYSTEM', 'urgent', { priority: 'high' });
			await publish(actor, 'SYSTEM', 'normal2');

			expect(delivered(sends)).toHaveLength(0);

			// On turn complete, high-priority should flush first.
			await tell(actor, 'notification.turn_complete', {});
			const out = delivered(sends);
			expect(out).toHaveLength(1);
			expect((out[0].payload as { text: string }).text).toBe('urgent');
		});

		it('delivers immediately when busy on truncation transport (OpenAI)', async () => {
			const { actor, sends } = makeActor({ messageTruncation: true });
			await subscribe(actor, 'transport');

			await tell(actor, 'notification.audio_started', {});
			await publish(actor, 'SYSTEM', 'urgent', { priority: 'high' });

			const out = delivered(sends);
			expect(out).toHaveLength(1);
			expect((out[0].payload as { text: string }).text).toBe('urgent');
		});
	});

	describe('mixed priority ordering', () => {
		it('high-priority items flush before normal items', async () => {
			const { actor, sends } = makeActor({ messageTruncation: false });
			await subscribe(actor, 'transport');

			await tell(actor, 'notification.audio_started', {});
			await publish(actor, 'SYSTEM', 'normal1');
			await publish(actor, 'SYSTEM', 'normal2');
			await publish(actor, 'SYSTEM', 'urgent', { priority: 'high' });

			// Flush all turns end-to-end. We must repeat audio_started between
			// turns so the queue continues to gate.
			await tell(actor, 'notification.turn_complete', {});
			await tell(actor, 'notification.audio_started', {});
			await tell(actor, 'notification.turn_complete', {});
			await tell(actor, 'notification.audio_started', {});
			await tell(actor, 'notification.turn_complete', {});

			const texts = delivered(sends).map((s) => (s.payload as { text: string }).text);
			expect(texts).toEqual(['urgent', 'normal1', 'normal2']);
		});

		it('normal priority maintains FIFO order among normals', async () => {
			const { actor, sends } = makeActor();
			await subscribe(actor, 'transport');

			await tell(actor, 'notification.audio_started', {});
			await publish(actor, 'SYSTEM', 'first');
			await publish(actor, 'SYSTEM', 'second');
			await publish(actor, 'SYSTEM', 'third');

			await tell(actor, 'notification.turn_complete', {});
			await tell(actor, 'notification.audio_started', {});
			await tell(actor, 'notification.turn_complete', {});
			await tell(actor, 'notification.audio_started', {});
			await tell(actor, 'notification.turn_complete', {});

			const texts = delivered(sends).map((s) => (s.payload as { text: string }).text);
			expect(texts).toEqual(['first', 'second', 'third']);
		});
	});
});

// ---------------------------------------------------------------------------
// Half 2: new behaviors
// ---------------------------------------------------------------------------

describe('NotificationActor — subscribe / unsubscribe / fan-out', () => {
	it('fans out to every matching subscriber, one envelope each', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');
		await subscribe(actor, 'observer');

		await publish(actor, 'SYSTEM', 'hello');

		const out = delivered(sends);
		expect(out).toHaveLength(2);
		const recipients = out.map((s) => s.to).sort();
		expect(recipients).toEqual(['observer', 'transport']);
		// Same payload on each.
		expect((out[0].payload as { text: string }).text).toBe('hello');
		expect((out[1].payload as { text: string }).text).toBe('hello');
	});

	it('unsubscribe stops further deliveries to that subscriber', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');
		await subscribe(actor, 'observer');

		await tell(actor, 'notification.unsubscribe', { subscriberId: 'observer' });

		await publish(actor, 'SYSTEM', 'after-unsubscribe');

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect(out[0].to).toBe('transport');
	});

	it('label filter restricts delivery to the configured labels only', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport'); // all labels
		await subscribe(actor, 'system-only', { labels: ['SYSTEM'] });

		await publish(actor, 'SYSTEM', 's');
		await publish(actor, 'SUBAGENT UPDATE', 'u');

		const out = delivered(sends);
		const sysOnly = out.filter((s) => s.to === 'system-only');
		const transport = out.filter((s) => s.to === 'transport');
		expect(sysOnly).toHaveLength(1);
		expect((sysOnly[0].payload as { label: string }).label).toBe('SYSTEM');
		expect(transport).toHaveLength(2);
	});

	it('minPriority=high excludes normal-priority deliveries', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'urgent-only', { minPriority: 'high' });

		await publish(actor, 'SYSTEM', 'low'); // normal
		await publish(actor, 'SYSTEM', 'urgent', { priority: 'high' });

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect((out[0].payload as { text: string }).text).toBe('urgent');
	});

	it('subscribers added after publish do not get a replay', async () => {
		const { actor, sends } = makeActor();
		await publish(actor, 'SYSTEM', 'before-anyone-subscribed');

		await subscribe(actor, 'late');
		await publish(actor, 'SYSTEM', 'after-late-subscribed');

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect((out[0].payload as { text: string }).text).toBe('after-late-subscribed');
		expect(out[0].to).toBe('late');
	});
});

describe('NotificationActor — dedupKey', () => {
	it('replaces a queued entry with a matching dedupKey', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'TIME REMINDER', '15 min left', { dedupKey: 'time' });
		await publish(actor, 'TIME REMINDER', '10 min left', { dedupKey: 'time' });
		await publish(actor, 'TIME REMINDER', '5 min left', { dedupKey: 'time' });

		// Only the latest survives.
		await tell(actor, 'notification.turn_complete', {});
		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect((out[0].payload as { text: string }).text).toBe('5 min left');
	});

	it('also replaces queued entries when a later publish takes the immediate-deliver path', async () => {
		// This is the key case Codex flagged: dedup must run BEFORE the
		// audio-received check. If the queued entry isn't removed when the new
		// one delivers immediately, the queued entry would fire later as a
		// stale duplicate.
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'TIME REMINDER', 'queued', { dedupKey: 'time' });
		// Audio ends; next publish takes the immediate-deliver path.
		await tell(actor, 'notification.turn_complete', {});
		// The flushed item from the previous turn is in `sends` already.
		// Now reset and verify the queue is empty for the dedup test.
		expect(delivered(sends)).toHaveLength(1); // 'queued' flushed

		// Begin a new audio turn; queue another with the same key.
		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'TIME REMINDER', 'will-be-replaced', { dedupKey: 'time' });
		// Now end audio without turn_complete first to test the immediate path.
		await tell(actor, 'notification.reset_audio', {});
		await publish(actor, 'TIME REMINDER', 'replacement', { dedupKey: 'time' });

		// 'replacement' delivered immediately (audioReceived=false after reset).
		const after = delivered(sends);
		expect(after).toHaveLength(2);
		expect((after[1].payload as { text: string }).text).toBe('replacement');

		// Verify the previously-queued 'will-be-replaced' was dropped: turn end
		// does NOT flush an extra notification.
		await tell(actor, 'notification.turn_complete', {});
		expect(delivered(sends)).toHaveLength(2);
	});

	it('different dedupKeys are independent', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'TIME REMINDER', 'time-1', { dedupKey: 'time' });
		await publish(actor, 'BUDGET ALERT', 'budget-1', { dedupKey: 'budget' });
		await publish(actor, 'TIME REMINDER', 'time-2', { dedupKey: 'time' });

		await tell(actor, 'notification.turn_complete', {});
		await tell(actor, 'notification.audio_started', {});
		await tell(actor, 'notification.turn_complete', {});

		const texts = delivered(sends).map((s) => (s.payload as { text: string }).text);
		expect(texts).toEqual(['budget-1', 'time-2']);
	});
});

describe('NotificationActor — label normalization', () => {
	it('normalizeLabel produces the documented shapes', () => {
		expect(normalizeLabel('SYSTEM')).toBe('SYSTEM');
		expect(normalizeLabel('SUBAGENT UPDATE')).toBe('SUBAGENT UPDATE');
		expect(normalizeLabel('Time Reminder')).toBe('TIME REMINDER');
		expect(normalizeLabel('[USER 42]')).toBe('USER 42');
		expect(normalizeLabel('!!!')).toBe('SYSTEM'); // empty after sanitize → fallback
		expect(normalizeLabel('a'.repeat(50))).toBe('A'.repeat(32)); // truncate to 32
	});

	it('publishes with arbitrary user labels by normalizing on ingest', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await publish(actor, '[Time Reminder]', 'the actual text');

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect((out[0].payload as { label: string }).label).toBe('TIME REMINDER');
	});
});

describe('NotificationActor — correlationId propagation', () => {
	it('forwards envelope.correlationId from publish onto delivered envelopes', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');
		await subscribe(actor, 'observer');

		await publish(actor, 'SYSTEM', 'hello', {}, { correlationId: 'trace-abc' });

		const out = delivered(sends);
		expect(out).toHaveLength(2);
		expect(out[0].options?.correlationId).toBe('trace-abc');
		expect(out[1].options?.correlationId).toBe('trace-abc');
	});

	it('correlationId of undefined is propagated as-is (not synthesized)', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await publish(actor, 'SYSTEM', 'hello'); // no correlationId

		const out = delivered(sends);
		expect(out).toHaveLength(1);
		expect(out[0].options?.correlationId).toBeUndefined();
	});

	it('sets `from: this.id` on outbound envelopes', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await publish(actor, 'SYSTEM', 'hello');

		const out = delivered(sends);
		expect(out[0].options?.from).toBe('notification');
	});
});

describe('NotificationActor — onStop', () => {
	it('clears queue and subscribers on stop', async () => {
		const { actor, sends } = makeActor();
		await subscribe(actor, 'transport');

		await tell(actor, 'notification.audio_started', {});
		await publish(actor, 'SYSTEM', 'queued1');
		await publish(actor, 'SYSTEM', 'queued2');

		await actor.onStop('test');

		// After stop, neither flush nor publish should reach any subscriber.
		await tell(actor, 'notification.turn_complete', {});
		await publish(actor, 'SYSTEM', 'post-stop');
		expect(delivered(sends)).toHaveLength(0);
	});
});
