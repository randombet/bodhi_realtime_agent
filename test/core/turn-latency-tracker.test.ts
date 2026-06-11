// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';
import { TurnLatencyTracker } from '../../src/core/turn-latency-tracker.js';
import type { ResponseOrigin, SpeechEventSource } from '../../src/types/events.js';
import type { TurnLatencySegments } from '../../src/types/hooks.js';

const SID = 's';

function harness(ringCapacity?: number) {
	const bus = new EventBus();
	const latencies: Array<{ turnId: string; segments: TurnLatencySegments }> = [];
	const drops: Array<{ reason: string; turnId?: string }> = [];
	const results: Array<{ turnId: string; segments: TurnLatencySegments }> = [];
	bus.subscribe('turn.latency', (p) => results.push({ turnId: p.turnId, segments: p.segments }));
	const tracker = new TurnLatencyTracker({
		sessionId: SID,
		bus,
		emitLatency: (turnId, segments) => latencies.push({ turnId, segments }),
		emitDrop: (reason, turnId) => drops.push({ reason, turnId }),
		log: vi.fn(),
		ringCapacity,
	});

	const speechStart = (atMs: number, source: SpeechEventSource = 'client-vad') =>
		bus.publish('speech.user_started', { sessionId: SID, atMs, source });
	const speechEnd = (atMs: number, source: SpeechEventSource = 'client-vad') =>
		bus.publish('speech.user_ended', { sessionId: SID, atMs, source });
	const respStart = (turnId: string, atMs: number, origin: ResponseOrigin = 'user_audio') =>
		bus.publish('response.started', { sessionId: SID, turnId, atMs, origin });
	const firstAudio = (turnId: string, atMs: number) =>
		bus.publish('response.first_audio', { sessionId: SID, turnId, atMs });
	const turnEnd = (turnId: string) => bus.publish('turn.end', { sessionId: SID, turnId });
	const interrupted = (turnId: string) =>
		bus.publish('turn.interrupted', { sessionId: SID, turnId });
	const reset = (reason: 'reconnect' | 'transfer' | 'close') =>
		bus.publish('session.reset', { sessionId: SID, reason });

	return {
		bus,
		tracker,
		latencies,
		drops,
		results,
		speechStart,
		speechEnd,
		respStart,
		firstAudio,
		turnEnd,
		interrupted,
		reset,
	};
}

describe('TurnLatencyTracker', () => {
	it('happy path: anchor → response → first audio → turn.end emits segments (and the turn.latency mirror)', () => {
		const h = harness();
		h.speechStart(500);
		h.speechEnd(1000);
		h.respStart('t1', 1300);
		h.firstAudio('t1', 1450);
		h.turnEnd('t1');
		h.tracker.flush();

		expect(h.latencies).toEqual([
			{
				turnId: 't1',
				segments: { totalE2EMs: 450, geminiProcessingMs: 300, backendToClientMs: 150 },
			},
		]);
		expect(h.results).toHaveLength(1); // EventBus mirror
		expect(h.drops).toHaveLength(0);
	});

	it('emission is deferred to the drain tick (async edge), not synchronous', async () => {
		const h = harness();
		h.speechEnd(1000);
		h.respStart('t1', 1300);
		h.firstAudio('t1', 1450);
		h.turnEnd('t1');
		expect(h.latencies).toHaveLength(0); // nothing yet — sync side only appends
		await new Promise((r) => setImmediate(r));
		expect(h.latencies).toHaveLength(1);
	});

	it('H1: a user_audio turn with no anchor drops no_anchor — never a wrong-utterance sample', () => {
		const h = harness();
		// Turn 1 completes normally (its anchor is consumed).
		h.speechEnd(1000);
		h.respStart('t1', 1300);
		h.firstAudio('t1', 1450);
		h.turnEnd('t1');
		// Turn 2: quiet mic — NO speech events at all.
		h.respStart('t2', 5000);
		h.firstAudio('t2', 5400);
		h.turnEnd('t2');
		h.tracker.flush();

		expect(h.latencies).toHaveLength(1); // only t1 — t2 emits nothing
		expect(h.drops).toEqual([{ reason: 'no_anchor', turnId: 't2' }]);
	});

	it('H2: post-snapshot echo segments cannot contaminate the active anchor', () => {
		const h = harness();
		h.speechStart(500);
		h.speechEnd(1000);
		h.respStart('t1', 1300);
		// Echo during playback: starts AFTER the response → next-turn pending.
		h.speechStart(2000);
		h.speechEnd(2500);
		h.firstAudio('t1', 1450);
		h.turnEnd('t1');
		h.tracker.flush();

		expect(h.latencies[0].segments.totalE2EMs).toBe(450); // original anchor kept
	});

	it('H3: multi-response (tool) turns keep first-response stamps — E2E includes tool time', () => {
		const h = harness();
		h.speechEnd(1000);
		h.respStart('t1', 1300); // response 1: tool call, no audio
		h.respStart('t1', 4000); // response 2 after the tool — must NOT re-stamp
		h.firstAudio('t1', 4200);
		h.turnEnd('t1');
		h.tracker.flush();

		expect(h.latencies[0].segments).toEqual({
			totalE2EMs: 3200, // includes tool execution
			geminiProcessingMs: 300, // from the FIRST response start
			backendToClientMs: 2900,
		});
	});

	it('late provider anchor attaches to the active turn when its start preceded the response', () => {
		const h = harness();
		h.speechStart(50, 'provider');
		h.respStart('t1', 100); // semantic VAD: response before speech_stopped arrives
		h.speechEnd(350, 'provider'); // start(50) < respStart(100) → attaches
		h.firstAudio('t1', 500);
		h.turnEnd('t1');
		h.tracker.flush();

		expect(h.latencies[0].segments.totalE2EMs).toBe(150);
		// provider anchor (350) is after response start (100) → segment omitted, not negative
		expect(h.latencies[0].segments.geminiProcessingMs).toBeUndefined();
		expect(h.latencies[0].segments.backendToClientMs).toBe(400);
	});

	it('late-attach guard: a stop whose start came after response.started pends for the next epoch', () => {
		const h = harness();
		h.respStart('t1', 100);
		h.speechStart(120, 'provider');
		h.speechEnd(350, 'provider'); // start(120) > respStart(100) → NOT the active turn's
		h.firstAudio('t1', 500);
		h.turnEnd('t1');
		// Next turn claims the promoted anchor.
		h.respStart('t2', 600);
		h.firstAudio('t2', 700);
		h.turnEnd('t2');
		h.tracker.flush();

		// t1 dropped (no anchor; one was diverted), t2 uses the 350 anchor.
		expect(h.drops[0].turnId).toBe('t1');
		expect(h.latencies).toHaveLength(1);
		expect(h.latencies[0]).toEqual({
			turnId: 't2',
			segments: { totalE2EMs: 350, geminiProcessingMs: 250, backendToClientMs: 100 },
		});
	});

	it('short-barge-in promotion: an anchor completed before the interrupted turn.end survives the tick (both sources)', () => {
		for (const source of ['provider', 'client-vad'] as const) {
			const h = harness();
			h.respStart('t1', 100);
			h.speechStart(120, source);
			h.speechEnd(180, source); // before t1's turn.end — must be promoted, not stale-dropped
			h.interrupted('t1');
			h.turnEnd('t1');
			h.respStart('t2', 300);
			h.firstAudio('t2', 500);
			h.turnEnd('t2');
			h.tracker.flush();

			expect(h.latencies.map((l) => l.turnId)).toEqual(['t2']);
			expect(h.latencies[0].segments.totalE2EMs).toBe(320); // 500 − 180
		}
	});

	it('provider anchor wins over client-VAD; client-VAD never downgrades provider', () => {
		const h = harness();
		h.speechStart(400);
		h.speechEnd(900, 'provider');
		h.speechEnd(1000, 'client-vad'); // must not replace the provider anchor
		h.respStart('t1', 1300);
		h.firstAudio('t1', 1450);
		h.turnEnd('t1');
		h.tracker.flush();

		expect(h.latencies[0].segments.totalE2EMs).toBe(550); // 1450 − 900
	});

	it('origin eligibility: greetings/text turns with no anchor are silent — no drop', () => {
		const h = harness();
		h.respStart('g1', 100, 'assistant_initiated');
		h.firstAudio('g1', 300);
		h.turnEnd('g1');
		h.respStart('x1', 1000, 'user_text');
		h.firstAudio('x1', 1200);
		h.turnEnd('x1');
		h.tracker.flush();

		expect(h.latencies).toHaveLength(0);
		expect(h.drops).toHaveLength(0);
	});

	it('tool-only / no-audio turns are not latency-eligible: no sample, no drop', () => {
		const h = harness();
		h.speechEnd(1000);
		h.respStart('t1', 1300); // tool-only — no audio ever
		h.turnEnd('t1');
		h.tracker.flush();

		expect(h.latencies).toHaveLength(0);
		expect(h.drops).toHaveLength(0);
	});

	it('implausible E2E is dropped, not clamped', () => {
		const h = harness();
		h.speechEnd(1000);
		h.respStart('t1', 18000);
		h.firstAudio('t1', 20000); // 19s E2E
		h.turnEnd('t1');
		h.tracker.flush();

		expect(h.latencies).toHaveLength(0);
		expect(h.drops).toEqual([{ reason: 'implausible', turnId: 't1' }]);
	});

	it('overflow fails closed: gap never produces a sample; resyncs at the next turn.end', () => {
		const h = harness(4); // tiny ring
		h.speechEnd(1000);
		h.respStart('t1', 1300);
		h.firstAudio('t1', 1450);
		h.turnEnd('t1');
		h.speechEnd(2000); // 5th append → overflow (ring cleared, suppression on)
		h.tracker.flush();
		expect(h.latencies).toHaveLength(0); // t1's events were in the cleared gap
		expect(h.drops).toEqual([{ reason: 'overflow', turnId: undefined }]);

		// Still suppressed until a resync boundary passes…
		h.respStart('t2', 3000);
		h.firstAudio('t2', 3200);
		h.turnEnd('t2'); // resync boundary — no emission for t2
		h.tracker.flush();
		expect(h.latencies).toHaveLength(0);

		// …after which correlation works again.
		h.speechEnd(4000);
		h.respStart('t3', 4300);
		h.firstAudio('t3', 4450);
		h.turnEnd('t3');
		h.tracker.flush();
		expect(h.latencies).toEqual([
			{
				turnId: 't3',
				segments: { totalE2EMs: 450, geminiProcessingMs: 300, backendToClientMs: 150 },
			},
		]);
	});

	it('session.reset drops in-flight stamps (reason=reset) only when stamps exist; close quiesces permanently', () => {
		const h = harness();
		// No in-flight state → reset emits no drop.
		h.reset('reconnect');
		h.tracker.flush();
		expect(h.drops).toHaveLength(0);

		// In-flight turn → reset drops it.
		h.speechEnd(1000);
		h.respStart('t1', 1300);
		h.reset('reconnect');
		h.tracker.flush();
		expect(h.drops).toEqual([{ reason: 'reset', turnId: 't1' }]);

		// close(): flush already-buffered, then quiesce — teardown turn.end ignored.
		h.speechEnd(2000);
		h.respStart('t2', 2300);
		h.firstAudio('t2', 2450);
		h.reset('close');
		h.turnEnd('t2'); // teardown tick on a quiesced tracker
		h.tracker.flush();
		expect(h.latencies).toHaveLength(0);
		// Further events are ignored entirely.
		h.speechEnd(9000);
		h.respStart('t3', 9300);
		h.tracker.flush();
		expect(h.latencies).toHaveLength(0);
	});
});
