// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../src/observability/metrics-collector.js';
import {
	PROMETHEUS_CONTENT_TYPE,
	createMetricsHandler,
	renderPrometheus,
} from '../../src/observability/prometheus.js';

function seed(): MetricsCollector {
	const c = new MetricsCollector();
	c.hooks.onTurnLatency?.({
		sessionId: 's',
		turnId: '1',
		segments: { totalE2EMs: 450, geminiProcessingMs: 300, backendToClientMs: 150 },
	});
	c.hooks.onToolResult?.({ toolCallId: 'a', durationMs: 120, status: 'completed' });
	return c;
}

describe('renderPrometheus', () => {
	it('emits HELP/TYPE and histogram bucket/sum/count lines', () => {
		const text = renderPrometheus(seed());
		expect(text).toContain('# TYPE voice_turn_latency_e2e_ms histogram');
		expect(text).toContain('voice_turn_latency_e2e_ms_bucket{le="500"} 1');
		expect(text).toContain('voice_turn_latency_e2e_ms_bucket{le="+Inf"} 1');
		expect(text).toContain('voice_turn_latency_e2e_ms_sum 450');
		expect(text).toContain('voice_turn_latency_e2e_ms_count 1');
	});

	it('emits labeled histogram series for tool duration by status', () => {
		const text = renderPrometheus(seed());
		expect(text).toContain('# TYPE voice_tool_duration_ms histogram');
		expect(text).toContain('voice_tool_duration_ms_bucket{status="completed",le="200"} 1');
		expect(text).toContain('voice_tool_duration_ms_count{status="completed"} 1');
		expect(text).toContain('# TYPE voice_tool_total counter');
		expect(text).toContain('voice_tool_total{status="completed"} 1');
	});

	it('renders valid exposition for an empty collector (zeroed histograms)', () => {
		const text = renderPrometheus(new MetricsCollector());
		expect(text).toContain('voice_turn_latency_e2e_ms_count 0');
		expect(text).toContain('voice_stop_to_transcript_ms_count 0');
	});
});

describe('createMetricsHandler', () => {
	it('writes content-type + exposition body to the response', () => {
		let headerKV: [string, string] | null = null;
		let body = '';
		const res = {
			statusCode: 0,
			setHeader: (k: string, v: string) => {
				headerKV = [k, v];
			},
			end: (b: string) => {
				body = b;
			},
		};
		createMetricsHandler(seed())({}, res);
		expect(res.statusCode).toBe(200);
		expect(headerKV).toEqual(['Content-Type', PROMETHEUS_CONTENT_TYPE]);
		expect(body).toContain('voice_turn_latency_e2e_ms_count 1');
	});
});
