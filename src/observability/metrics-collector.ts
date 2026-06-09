// SPDX-License-Identifier: MIT

import type { FrameworkHooks } from '../types/hooks.js';
import { Counter, Histogram, HistogramVec } from './histogram.js';

/**
 * Subscribes to {@link FrameworkHooks} events and aggregates them into in-memory
 * Prometheus-style metrics (histograms + counters). Dependency-free; render the
 * exposition with the Prometheus endpoint helper.
 *
 * Integration: pass `collector.hooks` as `VoiceSessionConfig.hooks`.
 *
 *     const collector = new MetricsCollector();
 *     new VoiceSession({ ...cfg, hooks: collector.hooks });
 *     // expose collector via the /metrics endpoint helper
 *
 * Privacy: never stores transcript text — only `textLength` and timing — and
 * never attaches per-session/user labels. Label cardinality capping is added in
 * a later step; Phase 4 adds the configurable PrivacyConfig.
 */
export class MetricsCollector {
	// --- Latency (infrastructure) ---
	readonly turnE2eMs = new Histogram();
	readonly turnProviderProcessingMs = new Histogram();
	readonly turnBackendToClientMs = new Histogram();
	readonly stopToTranscriptMs = new Histogram();
	// --- Barge-in (user behavior) ---
	readonly bargeInCancelLatencyMs = new Histogram([10, 30, 60, 100, 200, 500, 1000]);
	readonly bargeInTotal = new Counter();
	// --- TTS / tools / errors (execution) ---
	readonly ttsTtfbMs = new HistogramVec();
	readonly toolDurationMs = new HistogramVec();
	readonly toolTotal = new Counter();
	readonly errorTotal = new Counter();

	/** turnId → user-speech-end timestamp, for stop-to-transcript correlation. */
	private readonly pendingSpeechEnd = new Map<string, number>();

	/** A {@link FrameworkHooks} object wired to this collector. Stable identity. */
	readonly hooks: FrameworkHooks = {
		onTurnLatency: (e) => {
			this.turnE2eMs.observe(e.segments.totalE2EMs);
			if (e.segments.geminiProcessingMs !== undefined)
				this.turnProviderProcessingMs.observe(e.segments.geminiProcessingMs);
			if (e.segments.backendToClientMs !== undefined)
				this.turnBackendToClientMs.observe(e.segments.backendToClientMs);
		},
		onUserSpeechEnd: (e) => {
			if (e.turnId === undefined) return;
			this.pendingSpeechEnd.set(e.turnId, e.atMs);
			// Bound the correlation map (evict oldest insertion).
			if (this.pendingSpeechEnd.size > 256) {
				const oldest = this.pendingSpeechEnd.keys().next().value;
				if (oldest !== undefined) this.pendingSpeechEnd.delete(oldest);
			}
		},
		onTranscriptReady: (e) => {
			if (e.turnId === undefined) return;
			const start = this.pendingSpeechEnd.get(e.turnId);
			if (start === undefined) return;
			this.pendingSpeechEnd.delete(e.turnId);
			this.stopToTranscriptMs.observe(Math.max(0, e.atMs - start));
		},
		onBargeInDetected: (e) => {
			this.bargeInCancelLatencyMs.observe(e.latencyMs);
			this.bargeInTotal.inc({ successful: String(e.successful) });
		},
		onTTSSynthesis: (e) => {
			this.ttsTtfbMs.observe({ provider: e.provider }, e.ttfbMs);
		},
		onToolResult: (e) => {
			this.toolDurationMs.observe({ status: e.status }, e.durationMs);
			this.toolTotal.inc({ status: e.status });
		},
		onError: (e) => {
			this.errorTotal.inc({ component: e.component, severity: e.severity });
		},
	};
}
