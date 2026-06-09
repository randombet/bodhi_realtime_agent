// SPDX-License-Identifier: MIT

import type { Meter } from '@opentelemetry/api';
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

	const bargeIn = meter.createCounter('voice.bargein.total');
	const turns = meter.createCounter('voice.turns.total');
	const turnsInterrupted = meter.createCounter('voice.turns.interrupted');
	const bargeInRecovered = meter.createCounter('voice.bargein.recovered');
	const jumpIn = meter.createCounter('voice.jumpin.total');
	const toolTotal = meter.createCounter('voice.tool.total');
	const errorTotal = meter.createCounter('voice.error.total');

	const speechEnds = new Map<string, number>();
	let awaitingRecovery = false;

	return {
		onTurnLatency: (ev) => {
			e2e.record(ev.segments.totalE2EMs);
			if (ev.segments.geminiProcessingMs !== undefined)
				providerProc.record(ev.segments.geminiProcessingMs);
			if (ev.segments.backendToClientMs !== undefined)
				backendToClient.record(ev.segments.backendToClientMs);
		},
		onUserSpeechEnd: (ev) => {
			if (ev.turnId !== undefined) speechEnds.set(ev.turnId, ev.atMs);
		},
		onTranscriptReady: (ev) => {
			if (ev.turnId === undefined) return;
			const start = speechEnds.get(ev.turnId);
			if (start === undefined) return;
			speechEnds.delete(ev.turnId);
			s2t.record(Math.max(0, ev.atMs - start));
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
