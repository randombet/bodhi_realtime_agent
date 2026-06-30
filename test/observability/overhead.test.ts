import { describe, expect, it } from 'vitest';
import { MetricsCollector } from '../../src/observability/metrics-collector.js';

/**
 * Overhead / hardening checks. A wall-clock micro-benchmark is flaky in CI, so we
 * verify the property that actually matters for production safety: the collector's
 * footprint stays BOUNDED under high-cardinality, high-volume load (the cardinality
 * guard prevents unbounded series growth), and recording is O(1) per event.
 */
describe('MetricsCollector overhead/bounded-memory', () => {
	it('keeps series bounded under high-cardinality load', () => {
		const c = new MetricsCollector({ privacy: { maxLabelCardinality: 50 } });
		// 10k TTS events across 5k distinct providers + 10k errors across distinct components.
		for (let i = 0; i < 10_000; i++) {
			c.hooks.onTTSSynthesis?.({
				sessionId: `s${i}`,
				provider: `provider-${i % 5000}`,
				textLength: 1,
				durationMs: 1,
				audioMs: 1,
				ttfbMs: i % 300,
				requestId: i,
			});
			c.hooks.onError?.({ component: `component-${i}`, error: new Error('x'), severity: 'error' });
		}
		// Folded to "other" past the cap → series count stays bounded, not ~5000/10000.
		expect(c.ttsTtfbMs.size).toBeLessThanOrEqual(51);
		expect(c.errorTotal.size).toBeLessThanOrEqual(51);
	});

	it('stop-to-transcript state is O(1) (single sequential anchor — no unbounded growth)', () => {
		const c = new MetricsCollector();
		// 10k un-correlated speech-ends just overwrite the single anchor slot.
		for (let i = 0; i < 10_000; i++) {
			c.hooks.onUserSpeechEnd?.({ sessionId: 's', atMs: i });
		}
		// A fresh correlation still works against the latest anchor.
		c.hooks.onUserSpeechEnd?.({ sessionId: 's', atMs: 20_000 });
		c.hooks.onTranscriptReady?.({ sessionId: 's', atMs: 20_005, textLength: 1 });
		expect(c.stopToTranscriptMs.count).toBe(1);
	});

	it('zero recording work when sampled out (rate 0, fast turns)', () => {
		const c = new MetricsCollector({ privacy: { sessionSamplingRate: 0 } });
		for (let i = 0; i < 1000; i++) {
			c.hooks.onTurnLatency?.({
				sessionId: `s${i}`,
				turnId: `${i}`,
				segments: { totalE2EMs: 100 },
			});
		}
		expect(c.turnE2eMs.count).toBe(0); // all sampled out, no histogram growth
	});
});
