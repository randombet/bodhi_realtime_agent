import { type Meter, type Tracer, context, trace } from '@opentelemetry/api';
import type { FrameworkHooks } from '../types/hooks.js';

/**
 * OpenTelemetry metrics integration for the observability module
 * (`@bodhi_agent/realtime-agent-framework/observability/opentelemetry`).
 *
 * Requires `@opentelemetry/api` as an **optional peerDependency** (plus an SDK
 * + exporter, e.g. `@opentelemetry/sdk-metrics` and
 * `@opentelemetry/exporter-metrics-otlp-http`, configured by the host). Importing
 * this subpath without the peer installed fails module resolution with a clear
 * `Cannot find module '@opentelemetry/api'` — install it to use OTel.
 *
 * Unlike the Prometheus path (pull, in-process aggregation), this records raw
 * observations into OTel instruments; a host-configured `MetricReader` exports
 * them via OTLP to a Collector. Use one OR the other.
 *
 *     import { MeterProvider } from '@opentelemetry/sdk-metrics';
 *     const meter = new MeterProvider({ readers: [reader] }).getMeter('voice-agent');
 *     new VoiceSession({ ...cfg, hooks: createOtelMetricsHooks(meter) });
 */
export function createOtelMetricsHooks(meter: Meter): FrameworkHooks {
	const e2e = meter.createHistogram('voice.turn.latency.e2e', {
		unit: 'ms',
		description: 'End-to-end stop-to-first-audio latency.',
	});
	const providerProc = meter.createHistogram('voice.turn.provider_processing', {
		unit: 'ms',
		description: 'User-stop to provider-response-start (≈TTFT).',
	});
	const backendToClient = meter.createHistogram('voice.turn.backend_to_client', { unit: 'ms' });
	const s2t = meter.createHistogram('voice.stop_to_transcript', { unit: 'ms' });
	const cancelLatency = meter.createHistogram('voice.bargein.cancel_latency', { unit: 'ms' });
	const reentry = meter.createHistogram('voice.reentry.latency', { unit: 'ms' });
	const ttsTtfb = meter.createHistogram('voice.tts.ttfb', { unit: 'ms' });
	const toolDuration = meter.createHistogram('voice.tool.duration', { unit: 'ms' });

	const latencyDropped = meter.createCounter('voice.turn.latency.dropped');
	const bargeIn = meter.createCounter('voice.bargein.total');
	const turns = meter.createCounter('voice.turns.total');
	const turnsInterrupted = meter.createCounter('voice.turns.interrupted');
	const bargeInRecovered = meter.createCounter('voice.bargein.recovered');
	const jumpIn = meter.createCounter('voice.jumpin.total');
	const toolTotal = meter.createCounter('voice.tool.total');
	const errorTotal = meter.createCounter('voice.error.total');

	// Sequential S2T anchor (not turnId-keyed — speech end precedes turn
	// allocation); provider precedence + consume-on-use + plausibility guard,
	// mirroring MetricsCollector.
	let pendingS2T: { atMs: number; source: string } | null = null;
	let awaitingRecovery = false;

	return {
		onTurnLatency: (ev) => {
			e2e.record(ev.segments.totalE2EMs);
			if (ev.segments.geminiProcessingMs !== undefined)
				providerProc.record(ev.segments.geminiProcessingMs);
			if (ev.segments.backendToClientMs !== undefined)
				backendToClient.record(ev.segments.backendToClientMs);
		},
		onTurnLatencyDropped: (ev) => latencyDropped.add(1, { reason: ev.reason }),
		onUserSpeechEnd: (ev) => {
			const source = ev.source ?? 'client-vad';
			if (pendingS2T === null || source === 'provider' || pendingS2T.source !== 'provider') {
				pendingS2T = { atMs: ev.atMs, source };
			}
		},
		onTranscriptReady: (ev) => {
			const anchor = pendingS2T;
			if (anchor === null) return;
			pendingS2T = null;
			const deltaMs = ev.atMs - anchor.atMs;
			if (deltaMs < 0 || deltaMs > 10_000) return;
			s2t.record(deltaMs);
		},
		onBargeInDetected: (ev) => {
			cancelLatency.record(ev.latencyMs);
			bargeIn.add(1, { successful: String(ev.successful) });
		},
		onTurnFinalized: (ev) => {
			turns.add(1);
			if (ev.interrupted) {
				turnsInterrupted.add(1);
				awaitingRecovery = true;
			} else if (awaitingRecovery) {
				bargeInRecovered.add(1);
				awaitingRecovery = false;
			}
		},
		onJumpIn: () => jumpIn.add(1),
		onAgentReentry: (ev) => reentry.record(ev.reentryMs),
		onTTSSynthesis: (ev) => ttsTtfb.record(ev.ttfbMs, { provider: ev.provider }),
		onToolResult: (ev) => {
			toolDuration.record(ev.durationMs, { status: ev.status });
			toolTotal.add(1, { status: ev.status });
		},
		onError: (ev) => errorTotal.add(1, { component: ev.component, severity: ev.severity }),
	};
}

/**
 * OPTIONAL turn-waterfall tracing. Reconstructs a `voice_turn` span with
 * `provider_processing` / `backend_to_client` child spans from the per-turn
 * timing (correlating `onUserSpeechEnd` → `onTurnLatency` by turnId). Off unless
 * the host opts in by registering these hooks.
 *
 * Requires a **trace backend** (Tempo/Jaeger) and a configured tracer; Prometheus
 * stores metrics only. Assumes an epoch-millisecond clock (the default `nowMs`);
 * a monotonic `performance.now()` clock would mis-place spans on the wall-clock.
 *
 * Compose with the metrics hooks via `mergeHooks(metricsHooks, tracingHooks)`.
 */
export function createOtelTracingHooks(tracer: Tracer): FrameworkHooks {
	const speechEnds = new Map<string, number>();
	return {
		onUserSpeechEnd: (ev) => {
			if (ev.turnId !== undefined) speechEnds.set(ev.turnId, ev.atMs);
		},
		onTurnLatency: (ev) => {
			if (ev.turnId === undefined) return;
			const start = speechEnds.get(ev.turnId);
			if (start === undefined) return;
			speechEnds.delete(ev.turnId);
			const s = ev.segments;
			const turnSpan = tracer.startSpan('voice_turn', { startTime: start });
			turnSpan.setAttribute('turn.id', ev.turnId);
			turnSpan.setAttribute('latency.e2e_ms', s.totalE2EMs);
			const ctx = trace.setSpan(context.active(), turnSpan);
			let cursor = start;
			if (s.geminiProcessingMs !== undefined) {
				const child = tracer.startSpan('provider_processing', { startTime: cursor }, ctx);
				cursor += s.geminiProcessingMs;
				child.end(cursor);
			}
			if (s.backendToClientMs !== undefined) {
				const child = tracer.startSpan('backend_to_client', { startTime: cursor }, ctx);
				cursor += s.backendToClientMs;
				child.end(cursor);
			}
			turnSpan.end(start + s.totalE2EMs);
		},
	};
}

// Re-exported for backward compatibility — mergeHooks is dependency-free and
// lives in the core observability module (it is useful without OTel, e.g. to
// combine the MetricsCollector's hooks with app-level logging hooks).
export { mergeHooks } from './merge-hooks.js';
