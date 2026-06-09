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
 * Privacy (Phase 1 minimum): never stores transcript text — only `textLength`
 * and timing — never attaches per-session/user labels, and only ever emits a
 * fixed allowlist of low-cardinality label keys (`provider`, `status`,
 * `component`, `severity`, `successful`). Unbounded-ish values (`provider`,
 * `component`) fold to `"other"` past `maxLabelCardinality` so a runaway value
 * cannot mint unbounded series. Phase 4 adds the configurable PrivacyConfig.
 */
export class MetricsCollector {
	// --- Latency (infrastructure) ---
	readonly turnE2eMs = new Histogram();
	readonly turnProviderProcessingMs = new Histogram();
	readonly turnBackendToClientMs = new Histogram();
	readonly stopToTranscriptMs = new Histogram();
	// --- Barge-in / turn-taking (user behavior) ---
	readonly bargeInCancelLatencyMs = new Histogram([10, 30, 60, 100, 200, 500, 1000]);
	readonly bargeInTotal = new Counter();
	readonly turnsTotal = new Counter();
	readonly turnsInterruptedTotal = new Counter();
	/** Interrupted turns that recovered (a clean turn followed). */
	readonly bargeInRecoveredTotal = new Counter();
	/** Agent took the floor while the user was still speaking (jump-ins). */
	readonly jumpInTotal = new Counter();
	// --- TTS / tools / errors (execution) ---
	readonly ttsTtfbMs = new HistogramVec();
	readonly toolDurationMs = new HistogramVec();
	readonly toolTotal = new Counter();
	readonly errorTotal = new Counter();

	/** turnId → user-speech-end timestamp, for stop-to-transcript correlation. */
	private readonly pendingSpeechEnd = new Map<string, number>();
	/** True while awaiting a clean turn after an interrupt (recovery tracking). */
	private awaitingRecovery = false;

	/** Cardinality guard: distinct values seen per capped label dimension. */
	private readonly maxLabelCardinality: number;
	private readonly seenProviders = new Set<string>();
	private readonly seenComponents = new Set<string>();

	constructor(opts: { maxLabelCardinality?: number } = {}) {
		this.maxLabelCardinality = opts.maxLabelCardinality ?? 50;
	}

	/** Return `value`, or `"other"` once this dimension hits the cardinality cap. */
	private cap(seen: Set<string>, value: string): string {
		if (seen.has(value)) return value;
		if (seen.size < this.maxLabelCardinality) {
			seen.add(value);
			return value;
		}
		return 'other';
	}

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
		onJumpIn: () => {
			this.jumpInTotal.inc();
		},
		onTurnFinalized: (e) => {
			this.turnsTotal.inc();
			if (e.interrupted) {
				this.turnsInterruptedTotal.inc();
				this.awaitingRecovery = true;
			} else if (this.awaitingRecovery) {
				// A clean turn followed an interrupt → recovered.
				this.bargeInRecoveredTotal.inc();
				this.awaitingRecovery = false;
			}
		},
		onTTSSynthesis: (e) => {
			this.ttsTtfbMs.observe({ provider: this.cap(this.seenProviders, e.provider) }, e.ttfbMs);
		},
		onToolResult: (e) => {
			this.toolDurationMs.observe({ status: e.status }, e.durationMs);
			this.toolTotal.inc({ status: e.status });
		},
		onError: (e) => {
			this.errorTotal.inc({
				component: this.cap(this.seenComponents, e.component),
				severity: e.severity,
			});
		},
	};
}
