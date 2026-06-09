// SPDX-License-Identifier: MIT

import type { Meter, Tracer } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import {
	createOtelMetricsHooks,
	createOtelTracingHooks,
	mergeHooks,
} from '../../src/observability/opentelemetry.js';

interface Recorded {
	name: string;
	value: number;
	attrs?: Record<string, string>;
}

/** Minimal fake Meter that captures histogram.record / counter.add calls. */
function fakeMeter(): { meter: Meter; recorded: Recorded[] } {
	const recorded: Recorded[] = [];
	const make =
		(name: string) =>
		(value: number, attrs?: Record<string, string>): void => {
			recorded.push({ name, value, attrs });
		};
	const meter = {
		createHistogram: (name: string) => ({ record: make(name) }),
		createCounter: (name: string) => ({ add: make(name) }),
	} as unknown as Meter;
	return { meter, recorded };
}

describe('createOtelMetricsHooks', () => {
	it('maps onTurnLatency segments to the OTel histograms', () => {
		const { meter, recorded } = fakeMeter();
		const hooks = createOtelMetricsHooks(meter);
		hooks.onTurnLatency?.({
			sessionId: 's',
			turnId: '1',
			segments: { totalE2EMs: 450, geminiProcessingMs: 300, backendToClientMs: 150 },
		});
		expect(recorded).toContainEqual({
			name: 'voice.turn.latency.e2e',
			value: 450,
			attrs: undefined,
		});
		expect(recorded).toContainEqual({
			name: 'voice.turn.provider_processing',
			value: 300,
			attrs: undefined,
		});
	});

	it('correlates stop-to-transcript and labels tool results', () => {
		const { meter, recorded } = fakeMeter();
		const hooks = createOtelMetricsHooks(meter);
		hooks.onUserSpeechEnd?.({ sessionId: 's', turnId: '3', atMs: 1000 });
		hooks.onTranscriptReady?.({ sessionId: 's', turnId: '3', atMs: 1200, textLength: 5 });
		hooks.onToolResult?.({ toolCallId: 'a', durationMs: 90, status: 'completed' });
		expect(recorded).toContainEqual({
			name: 'voice.stop_to_transcript',
			value: 200,
			attrs: undefined,
		});
		expect(recorded).toContainEqual({
			name: 'voice.tool.duration',
			value: 90,
			attrs: { status: 'completed' },
		});
	});

	it('tracks interruption + recovery counters', () => {
		const { meter, recorded } = fakeMeter();
		const hooks = createOtelMetricsHooks(meter);
		hooks.onTurnFinalized?.({ sessionId: 's', turnId: 't', interrupted: true });
		hooks.onTurnFinalized?.({ sessionId: 's', turnId: 't', interrupted: false });
		const names = recorded.map((r) => r.name);
		expect(names).toContain('voice.turns.interrupted');
		expect(names).toContain('voice.bargein.recovered');
	});
});

interface FakeSpan {
	name: string;
	startTime: number;
	endTime?: number;
}

function fakeTracer(): { tracer: Tracer; spans: FakeSpan[] } {
	const spans: FakeSpan[] = [];
	const tracer = {
		startSpan: (name: string, opts?: { startTime?: number }) => {
			const span: FakeSpan = { name, startTime: opts?.startTime ?? 0 };
			spans.push(span);
			return {
				setAttribute: () => {},
				end: (endTime?: number) => {
					span.endTime = endTime;
				},
			};
		},
	} as unknown as Tracer;
	return { tracer, spans };
}

describe('createOtelTracingHooks', () => {
	it('reconstructs a voice_turn span with child spans from the timing', () => {
		const { tracer, spans } = fakeTracer();
		const hooks = createOtelTracingHooks(tracer);
		hooks.onUserSpeechEnd?.({ sessionId: 's', turnId: '1', atMs: 1000 });
		hooks.onTurnLatency?.({
			sessionId: 's',
			turnId: '1',
			segments: { totalE2EMs: 450, geminiProcessingMs: 300, backendToClientMs: 150 },
		});
		const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
		expect(byName.voice_turn).toMatchObject({ startTime: 1000, endTime: 1450 });
		expect(byName.provider_processing).toMatchObject({ startTime: 1000, endTime: 1300 });
		expect(byName.backend_to_client).toMatchObject({ startTime: 1300, endTime: 1450 });
	});

	it('emits no span without a correlated user-speech-end', () => {
		const { tracer, spans } = fakeTracer();
		const hooks = createOtelTracingHooks(tracer);
		hooks.onTurnLatency?.({ sessionId: 's', turnId: '9', segments: { totalE2EMs: 100 } });
		expect(spans).toHaveLength(0);
	});
});

describe('mergeHooks', () => {
	it('invokes the same hook on every source', () => {
		const calls: string[] = [];
		const a = { onJumpIn: () => calls.push('a') };
		const b = { onJumpIn: () => calls.push('b') };
		const merged = mergeHooks(a, b);
		merged.onJumpIn?.({ sessionId: 's' });
		expect(calls).toEqual(['a', 'b']);
	});
});
