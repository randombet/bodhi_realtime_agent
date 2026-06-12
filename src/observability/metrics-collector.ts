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

	/** Latest unconsumed speech-end anchor for stop-to-transcript. Sequential
	 *  join, NOT turnId-keyed: speech end usually precedes turn allocation, so
	 *  hook events frequently carry no turnId. Provider replaces client (fills
	 *  the quiet-mic coverage gap; receipt-time bias documented in §11);
	 *  consumed on use; staleness bounded by the plausibility guard. */
	private pendingS2T: { atMs: number; source: 'provider' | 'client-vad' } | null = null;
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
			if (!this.keepSession(e.sessionId)) return;
			const source = e.source ?? 'client-vad';
			// Provider replaces anything; client never downgrades a provider anchor
			// (tracker-consistent precedence).
			if (
				this.pendingS2T === null ||
				source === 'provider' ||
				this.pendingS2T.source !== 'provider'
			) {
				this.pendingS2T = { atMs: e.atMs, source };
			}
		},
		onTranscriptReady: (e) => {
			const anchor = this.pendingS2T;
			if (anchor === null) return;
			this.pendingS2T = null; // consume-on-use — never reused for a later transcript
			const deltaMs = e.atMs - anchor.atMs;
			// Plausibility guard: drop, don't clamp (a negative/huge span means the
			// anchor belonged to a different utterance).
			if (deltaMs < 0 || deltaMs > 10_000) return;
			this.stopToTranscriptMs.observe(deltaMs);
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
