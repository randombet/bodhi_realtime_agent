// SPDX-License-Identifier: MIT

import type { Meter } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { createOtelMetricsHooks } from '../../src/observability/opentelemetry.js';

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
