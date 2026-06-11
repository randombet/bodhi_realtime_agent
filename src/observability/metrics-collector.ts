// SPDX-License-Identifier: MIT

import type { FrameworkHooks } from '../types/hooks.js';
import { Counter, Histogram, HistogramVec } from './histogram.js';
import { DEFAULT_PRIVACY_CONFIG, LabelGuard, type PrivacyConfig, hashUnit } from './privacy.js';

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
 * Privacy: never stores transcript text (only `textLength` + timing) and never
 * attaches per-session/user labels; only a fixed allowlist of low-cardinality
 * keys (`provider`, `status`, `component`, `severity`, `successful`) is emitted.
 * A {@link PrivacyConfig} bounds label cardinality (fold to `"other"`, logged)
 * and optionally **samples** high-volume observations per session — while keeping
 * rare/interesting events (errors, barge-ins, jump-ins, re-entries, slow turns)
 * and all turn counters exact, so derived rates stay correct.
 */
export class MetricsCollector {
	// --- Latency (infrastructure) ---
	readonly turnE2eMs = new Histogram();
	readonly turnProviderProcessingMs = new Histogram();
	readonly turnBackendToClientMs = new Histogram();
	readonly stopToTranscriptMs = new Histogram();
	/** Turns that produced no latency sample, by reason — measurement coverage. */
	readonly turnLatencyDroppedTotal = new Counter();
	// --- Barge-in / turn-taking (user behavior) ---
	readonly bargeInCancelLatencyMs = new Histogram([10, 30, 60, 100, 200, 500, 1000]);
	readonly bargeInTotal = new Counter();
	readonly turnsTotal = new Counter();
	readonly turnsInterruptedTotal = new Counter();
	/** Interrupted turns that recovered (a clean turn followed). */
	readonly bargeInRecoveredTotal = new Counter();
	/** Agent took the floor while the user was still speaking (jump-ins). */
	readonly jumpInTotal = new Counter();
	/** Pause from a yield (interrupt) to the agent's next audio (re-entry, ms). */
	readonly reentryLatencyMs = new Histogram([100, 200, 500, 1000, 2000, 3000]);
	// --- TTS / tools / errors (execution) ---
	readonly ttsTtfbMs = new HistogramVec();
	readonly toolDurationMs = new HistogramVec();
	readonly toolTotal = new Counter();
	readonly errorTotal = new Counter();

	/** turnId → user-speech-end timestamp, for stop-to-transcript correlation. */
	private readonly pendingSpeechEnd = new Map<string, number>();
	/** True while awaiting a clean turn after an interrupt (recovery tracking). */
	private awaitingRecovery = false;

	private readonly privacy: PrivacyConfig;
	private readonly labelGuard: LabelGuard;

	constructor(opts: { privacy?: Partial<PrivacyConfig>; log?: (msg: string) => void } = {}) {
		this.privacy = { ...DEFAULT_PRIVACY_CONFIG, ...opts.privacy };
		this.labelGuard = new LabelGuard(this.privacy.maxLabelCardinality, opts.log);
	}

	/** True if this session's high-volume observations should be recorded. Errors,
	 *  barge-ins, jump-ins, re-entries, slow turns, and turn counters bypass this. */
	private keepSession(sessionId: string): boolean {
		return (
			this.privacy.sessionSamplingRate >= 1 ||
			hashUnit(sessionId) < this.privacy.sessionSamplingRate
		);
	}

	/** A {@link FrameworkHooks} object wired to this collector. Stable identity. */
	readonly hooks: FrameworkHooks = {
		onTurnLatency: (e) => {
			// Event-biased: slow turns always kept; otherwise sample by session.
			if (e.segments.totalE2EMs < this.privacy.slowTurnMs && !this.keepSession(e.sessionId)) return;
			this.turnE2eMs.observe(e.segments.totalE2EMs);
			if (e.segments.geminiProcessingMs !== undefined)
				this.turnProviderProcessingMs.observe(e.segments.geminiProcessingMs);
			if (e.segments.backendToClientMs !== undefined)
				this.turnBackendToClientMs.observe(e.segments.backendToClientMs);
		},
		onTurnLatencyDropped: (e) => {
			// Always kept (event-biased): coverage gaps are rare and high-value.
			this.turnLatencyDroppedTotal.inc({ reason: e.reason });
		},
		onUserSpeechEnd: (e) => {
			if (e.turnId === undefined || !this.keepSession(e.sessionId)) return;
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
		onAgentReentry: (e) => {
			this.reentryLatencyMs.observe(e.reentryMs);
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
			if (!this.keepSession(e.sessionId)) return;
			this.ttsTtfbMs.observe({ provider: this.labelGuard.cap('provider', e.provider) }, e.ttfbMs);
		},
		onToolResult: (e) => {
			this.toolDurationMs.observe({ status: e.status }, e.durationMs);
			this.toolTotal.inc({ status: e.status });
		},
		onError: (e) => {
			// Always kept (event-biased): errors are rare and high-value.
			this.errorTotal.inc({
				component: this.labelGuard.cap('component', e.component),
				severity: e.severity,
			});
		},
	};
}
