// SPDX-License-Identifier: MIT

/**
 * Wire-level parity test (Gemini-only): legacy `BackgroundNotificationQueue`
 * vs actor-mode `NotificationActor`.
 *
 * Drives the same logical producer sequence through both paths and asserts
 * the same gating outcomes — that is, the SAME NUMBER of `sendContent`
 * calls, in the SAME ORDER, with the SAME `turnComplete` flags, regardless
 * of which mode is active. The exact wire-format wrapping (`[X]: Y` in actor
 * mode vs `[X: Y]` in legacy templates) is intentionally NOT compared
 * byte-for-byte — see "Wire-format summary" in the design doc — but the
 * bodies the harness sends through both paths are structurally equivalent
 * (label + text). Both paths receive the same `[label]: body` shape so the
 * comparison is valid.
 *
 * Scenarios covered:
 *   (a) publish during idle (audioReceived=false)
 *   (b) publish while audio active (queued)
 *   (c) multiple publishes batched + single-flush per turn_complete
 *   (d) interrupted turn: skip flush
 *   (e) flush on next natural turn after interrupt
 *   (f) priority='high' on Gemini: queue at front
 *   (g) reset_audio (pre-greeting) reopens the gate
 *
 * Out of scope (per the design's "Phase 4" list):
 *   - OpenAI / messageTruncation=true parity (cancel-and-deliver semantics).
 *     Test scaffolding for that lands as a follow-up.
 *   - Legacy dedupKey: not implemented in BackgroundNotificationQueue, so
 *     dedup parity isn't applicable.
 */

import { describe, expect, it, vi } from 'vitest';
import { BackgroundNotificationQueue } from '../../src/core/background-notification-queue.js';
import type { ActorSendOptions } from '../../src/runtime/actor-send-fn.js';
import { NotificationActor } from '../../src/runtime/actors/notification-actor.js';
import type { ActorId } from '../../src/runtime/envelope.js';
import { createEnvelope } from '../../src/runtime/envelope.js';
import type { NotificationDelivered, RuntimeMessage } from '../../src/runtime/messages.js';

// ---------------------------------------------------------------------------
// Harnesses — drive a logical producer sequence through each path. Both
// expose the same recorded shape: an array of (text, turnComplete) pairs in
// the order TransportActor's adapter.sendContent / legacy queue's sendContent
// callback receives them.
// ---------------------------------------------------------------------------

interface WireEvent {
	text: string;
	turnComplete: boolean;
}

interface PublishStep {
	op: 'publish';
	label: string;
	text: string;
	priority?: 'normal' | 'high';
}
interface AudioStartedStep {
	op: 'audio_started';
}
interface InterruptStep {
	op: 'interrupted';
}
interface TurnCompleteStep {
	op: 'turn_complete';
}
interface ResetAudioStep {
	op: 'reset_audio';
}
type Step = PublishStep | AudioStartedStep | InterruptStep | TurnCompleteStep | ResetAudioStep;

/** Drive the same logical sequence through legacy `BackgroundNotificationQueue`. */
function driveLegacy(steps: Step[], opts: { messageTruncation?: boolean } = {}): WireEvent[] {
	const events: WireEvent[] = [];
	const sendContent = (
		turns: { role: string; parts: { text: string }[] }[],
		turnComplete: boolean,
	) => {
		// Legacy queue wraps the producer's full text into a single Turn already;
		// here we extract for shape-equivalence with the actor harness output.
		const text = turns[0]?.parts[0]?.text ?? '';
		events.push({ text, turnComplete });
	};
	const queue = new BackgroundNotificationQueue(
		sendContent,
		() => {},
		opts.messageTruncation ?? false,
	);

	for (const step of steps) {
		switch (step.op) {
			case 'publish':
				// Legacy's wire form is `[LABEL]: body` constructed at the producer.
				queue.sendOrQueue(
					[{ role: 'user', parts: [{ text: `[${step.label}]: ${step.text}` }] }],
					true,
					{ priority: step.priority ?? 'normal' },
				);
				break;
			case 'audio_started':
				queue.markAudioReceived();
				break;
			case 'interrupted':
				// Legacy pair: resetAudio + markInterrupted (matches
				// VoiceSession.handleInterrupted L1447 + L1448).
				queue.resetAudio();
				queue.markInterrupted();
				break;
			case 'turn_complete':
				queue.onTurnComplete();
				break;
			case 'reset_audio':
				queue.resetAudio();
				break;
		}
	}
	return events;
}

/** Drive the same logical sequence through actor-mode `NotificationActor`. */
async function driveActor(
	steps: Step[],
	opts: { messageTruncation?: boolean } = {},
): Promise<WireEvent[]> {
	const events: WireEvent[] = [];
	const sendMessage = vi.fn(
		(type: RuntimeMessage['type'], payload: unknown, to: ActorId, _options?: ActorSendOptions) => {
			// We only care about wire-out (`notification.delivered` →
			// TransportActor → adapter.sendContent). Simulate that final hop here.
			if (to === 'transport' && type === 'notification.delivered') {
				const p = payload as Omit<NotificationDelivered, 'type'>;
				// Same `[label]: text` wrapping TransportActor would produce.
				events.push({
					text: `[${p.label}]: ${p.text}`,
					turnComplete: p.turnComplete,
				});
			}
		},
	);
	const actor = new NotificationActor('notification', sendMessage, {
		messageTruncation: opts.messageTruncation ?? false,
	});
	// One subscriber: simulate TransportActor.
	await actor.onMessage(
		createEnvelope('notification.subscribe', { subscriberId: 'transport' }, 'notification'),
	);

	for (const step of steps) {
		switch (step.op) {
			case 'publish':
				await actor.onMessage(
					createEnvelope(
						'notification.publish',
						{ label: step.label, text: step.text, priority: step.priority ?? 'normal' },
						'notification',
					),
				);
				break;
			case 'audio_started':
				await actor.onMessage(createEnvelope('notification.audio_started', {}, 'notification'));
				break;
			case 'interrupted':
				// Actor pair sent by TransportActor.onInterrupted in step 1.6:
				// reset_audio FIRST, then interrupted.
				await actor.onMessage(createEnvelope('notification.reset_audio', {}, 'notification'));
				await actor.onMessage(createEnvelope('notification.interrupted', {}, 'notification'));
				break;
			case 'turn_complete':
				await actor.onMessage(createEnvelope('notification.turn_complete', {}, 'notification'));
				break;
			case 'reset_audio':
				await actor.onMessage(createEnvelope('notification.reset_audio', {}, 'notification'));
				break;
		}
	}
	return events;
}

// Compare two recorded sequences by structure (not by exact text — wrapping
// differs because legacy's [LABEL: body] form is constructed at producers
// while actor's [LABEL]: body is constructed at TransportActor). Here both
// harnesses produce `[LABEL]: body` so direct equality holds.
function expectSameWireSequence(legacy: WireEvent[], actor: WireEvent[]) {
	expect(actor).toEqual(legacy);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('Notification subsystem parity (Gemini, messageTruncation=false)', () => {
	it('(a) publish during idle: both deliver immediately', async () => {
		const steps: Step[] = [{ op: 'publish', label: 'SYSTEM', text: 'hello' }];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy).toHaveLength(1);
		expectSameWireSequence(legacy, actor);
	});

	it('(b) publish while audio active: both queue, neither delivers yet', async () => {
		const steps: Step[] = [
			{ op: 'audio_started' },
			{ op: 'publish', label: 'SYSTEM', text: 'queued' },
		];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy).toHaveLength(0);
		expectSameWireSequence(legacy, actor);
	});

	it('(c) multiple publishes during audio: only one flushes per turn_complete', async () => {
		const steps: Step[] = [
			{ op: 'audio_started' },
			{ op: 'publish', label: 'SYSTEM', text: 'msg-1' },
			{ op: 'publish', label: 'SYSTEM', text: 'msg-2' },
			{ op: 'turn_complete' },
		];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy).toHaveLength(1);
		expect(legacy[0].text).toBe('[SYSTEM]: msg-1');
		expectSameWireSequence(legacy, actor);
	});

	it('(d) interrupted turn: neither flushes on the interrupted turn_complete', async () => {
		const steps: Step[] = [
			{ op: 'audio_started' },
			{ op: 'publish', label: 'SYSTEM', text: 'queued' },
			{ op: 'interrupted' },
			{ op: 'turn_complete' },
		];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy).toHaveLength(0);
		expectSameWireSequence(legacy, actor);
	});

	it('(e) flush on the next natural turn after interrupt', async () => {
		const steps: Step[] = [
			{ op: 'audio_started' },
			{ op: 'publish', label: 'SYSTEM', text: 'queued' },
			{ op: 'interrupted' },
			{ op: 'turn_complete' }, // skipped flush (interrupted)
			{ op: 'turn_complete' }, // natural — flush now
		];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy).toHaveLength(1);
		expect(legacy[0].text).toBe('[SYSTEM]: queued');
		expectSameWireSequence(legacy, actor);
	});

	it('(f) priority high on Gemini: queues at FRONT, flushes before normals', async () => {
		const steps: Step[] = [
			{ op: 'audio_started' },
			{ op: 'publish', label: 'SYSTEM', text: 'normal-1' },
			{ op: 'publish', label: 'SYSTEM', text: 'urgent', priority: 'high' },
			{ op: 'publish', label: 'SYSTEM', text: 'normal-2' },
			{ op: 'turn_complete' }, // urgent flushes
		];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy).toHaveLength(1);
		expect(legacy[0].text).toBe('[SYSTEM]: urgent');
		expectSameWireSequence(legacy, actor);
	});

	it('(g) reset_audio reopens the gate: next publish delivers immediately', async () => {
		const steps: Step[] = [
			{ op: 'audio_started' },
			{ op: 'reset_audio' },
			{ op: 'publish', label: 'SYSTEM', text: 'after-reset' },
		];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy).toHaveLength(1);
		expect(legacy[0].text).toBe('[SYSTEM]: after-reset');
		expectSameWireSequence(legacy, actor);
	});

	it('(h) full turn cycle: publish during idle + during audio + flush across two turns', async () => {
		const steps: Step[] = [
			{ op: 'publish', label: 'SYSTEM', text: 'idle-1' }, // immediate
			{ op: 'audio_started' },
			{ op: 'publish', label: 'SYSTEM', text: 'queued-2' },
			{ op: 'publish', label: 'SYSTEM', text: 'queued-3' },
			{ op: 'turn_complete' }, // flushes queued-2
			{ op: 'audio_started' },
			{ op: 'turn_complete' }, // flushes queued-3
		];
		const legacy = driveLegacy(steps);
		const actor = await driveActor(steps);

		expect(legacy.map((e) => e.text)).toEqual([
			'[SYSTEM]: idle-1',
			'[SYSTEM]: queued-2',
			'[SYSTEM]: queued-3',
		]);
		expectSameWireSequence(legacy, actor);
	});
});
