// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Histogram } from '../../src/observability/histogram.js';
import { MetricsCollector } from '../../src/observability/metrics-collector.js';

describe('Histogram', () => {
	it('counts observations into cumulative le-buckets with sum/count', () => {
		const h = new Histogram([100, 500, 1000]);
		for (const v of [50, 150, 600, 2000]) h.observe(v);
		expect(h.count).toBe(4);
		expect(h.sum).toBe(2800);
		expect(h.buckets()).toEqual([
			{ le: 100, count: 1 }, // 50
			{ le: 500, count: 2 }, // +150
			{ le: 1000, count: 3 }, // +600
			{ le: Number.POSITIVE_INFINITY, count: 4 }, // +2000
		]);
	});
});

describe('MetricsCollector', () => {
	it('records onTurnLatency segments into the right histograms', () => {
		const c = new MetricsCollector();
		c.hooks.onTurnLatency?.({
			sessionId: 's',
			turnId: '1',
			segments: { totalE2EMs: 450, geminiProcessingMs: 300, backendToClientMs: 150 },
		});
		expect(c.turnE2eMs.count).toBe(1);
		expect(c.turnE2eMs.sum).toBe(450);
		expect(c.turnProviderProcessingMs.sum).toBe(300);
		expect(c.turnBackendToClientMs.sum).toBe(150);
	});

	it('correlates onUserSpeechEnd → onTranscriptReady into stop-to-transcript', () => {
		const c = new MetricsCollector();
		c.hooks.onUserSpeechEnd?.({ sessionId: 's', turnId: '7', atMs: 1000 });
		c.hooks.onTranscriptReady?.({ sessionId: 's', turnId: '7', atMs: 1200, textLength: 9 });
		expect(c.stopToTranscriptMs.count).toBe(1);
		expect(c.stopToTranscriptMs.sum).toBe(200);
	});

	it('does not correlate across mismatched turnIds', () => {
		const c = new MetricsCollector();
		c.hooks.onUserSpeechEnd?.({ sessionId: 's', turnId: '7', atMs: 1000 });
		c.hooks.onTranscriptReady?.({ sessionId: 's', turnId: '8', atMs: 1200, textLength: 9 });
		expect(c.stopToTranscriptMs.count).toBe(0);
	});

	it('records barge-in cancel latency + a labeled total', () => {
		const c = new MetricsCollector();
		c.hooks.onBargeInDetected?.({
			sessionId: 's',
			speechStartedAtMs: 1000,
			detectedAtMs: 1200,
			cancelRequestedAtMs: 1210,
			latencyMs: 10,
			successful: true,
		});
		expect(c.bargeInCancelLatencyMs.sum).toBe(10);
		expect(c.bargeInTotal.entries()).toEqual([{ labels: { successful: 'true' }, value: 1 }]);
	});

	it('records tool results by status', () => {
		const c = new MetricsCollector();
		c.hooks.onToolResult?.({ toolCallId: 'a', durationMs: 120, status: 'completed' });
		c.hooks.onToolResult?.({ toolCallId: 'b', durationMs: 80, status: 'error', error: 'x' });
		expect(c.toolTotal.size).toBe(2);
		expect(c.toolDurationMs.size).toBe(2);
	});

	it('caps label cardinality: providers past the cap fold to "other"', () => {
		const c = new MetricsCollector({ maxLabelCardinality: 2 });
		for (const provider of ['p1', 'p2', 'p3', 'p4']) {
			c.hooks.onTTSSynthesis?.({
				sessionId: 's',
				provider,
				textLength: 10,
				durationMs: 100,
				audioMs: 90,
				ttfbMs: 20,
				requestId: 1,
			});
		}
		const labels = c.ttsTtfbMs.entries().map((e) => e.labels.provider);
		// 2 distinct kept, the rest folded → at most 3 series (p1, p2, other)
		expect(c.ttsTtfbMs.size).toBe(3);
		expect(labels).toContain('other');
		expect(labels).toContain('p1');
		expect(labels).toContain('p2');
		expect(labels).not.toContain('p3');
	});

	it('tracks interruption rate and recovery via onTurnFinalized', () => {
		const c = new MetricsCollector();
		const fin = (interrupted: boolean) =>
			c.hooks.onTurnFinalized?.({ sessionId: 's', turnId: 't', interrupted });
		fin(false); // clean
		fin(true); // interrupted -> awaiting recovery
		fin(false); // clean after interrupt -> recovered
		fin(true); // interrupted, no clean turn after -> not recovered
		expect(c.turnsTotal.entries()[0].value).toBe(4);
		expect(c.turnsInterruptedTotal.entries()[0].value).toBe(2);
		expect(c.bargeInRecoveredTotal.entries()[0].value).toBe(1);
	});

	it('counts jump-ins', () => {
		const c = new MetricsCollector();
		c.hooks.onJumpIn?.({ sessionId: 's', turnId: '1' });
		c.hooks.onJumpIn?.({ sessionId: 's', turnId: '2' });
		expect(c.jumpInTotal.entries()[0].value).toBe(2);
	});

	it('records agent re-entry latency', () => {
		const c = new MetricsCollector();
		c.hooks.onAgentReentry?.({ sessionId: 's', reentryMs: 350 });
		expect(c.reentryLatencyMs.count).toBe(1);
		expect(c.reentryLatencyMs.sum).toBe(350);
	});

	it('records a missed barge-in (successful=false)', () => {
		const c = new MetricsCollector();
		c.hooks.onBargeInDetected?.({
			sessionId: 's',
			speechStartedAtMs: 1000,
			detectedAtMs: 1200,
			cancelRequestedAtMs: 1200,
			latencyMs: 0,
			successful: false,
		});
		expect(c.bargeInTotal.entries()).toEqual([{ labels: { successful: 'false' }, value: 1 }]);
	});

	it('never stores transcript text (textLength only on the typed payload)', () => {
		const c = new MetricsCollector();
		// onTranscriptReady payload exposes textLength, not text — recorded as a span only.
		c.hooks.onUserSpeechEnd?.({ sessionId: 's', turnId: '1', atMs: 0 });
		c.hooks.onTranscriptReady?.({ sessionId: 's', turnId: '1', atMs: 100, textLength: 42 });
		const json = JSON.stringify(c);
		expect(json).not.toContain('42'); // textLength is not retained as a label/series
	});
});
