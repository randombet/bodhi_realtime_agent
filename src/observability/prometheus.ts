import type { Counter, Histogram, HistogramVec } from './histogram.js';
import type { MetricsCollector } from './metrics-collector.js';

/** Prometheus text exposition content type (version 0.0.4). */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * A metrics exporter turns a {@link MetricsCollector} snapshot into output. The
 * Prometheus exporter renders text exposition here; the OTel exporter (Phase 2)
 * implements the same seam so consumers can register their own.
 */
export interface MetricsExporter {
	readonly contentType: string;
	render(collector: MetricsCollector): string;
}

function fmtLe(le: number): string {
	return le === Number.POSITIVE_INFINITY ? '+Inf' : String(le);
}

/** Escape a label value per the Prometheus exposition format. */
function escapeLabel(v: string): string {
	return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelStr(labels: Record<string, string>): string {
	const keys = Object.keys(labels);
	if (keys.length === 0) return '';
	return `{${keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',')}}`;
}

function header(name: string, help: string, type: string): string {
	return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
}

function histogramBody(name: string, hist: Histogram, base: Record<string, string> = {}): string {
	let out = '';
	for (const { le, count } of hist.buckets()) {
		out += `${name}_bucket${labelStr({ ...base, le: fmtLe(le) })} ${count}\n`;
	}
	out += `${name}_sum${labelStr(base)} ${hist.sum}\n`;
	out += `${name}_count${labelStr(base)} ${hist.count}\n`;
	return out;
}

function renderHistogram(name: string, help: string, hist: Histogram): string {
	return header(name, help, 'histogram') + histogramBody(name, hist);
}

function renderHistogramVec(name: string, help: string, vec: HistogramVec): string {
	let out = header(name, help, 'histogram');
	for (const { labels, hist } of vec.entries()) out += histogramBody(name, hist, labels);
	return out;
}

function renderCounter(name: string, help: string, counter: Counter): string {
	let out = header(name, help, 'counter');
	for (const { labels, value } of counter.entries()) out += `${name}${labelStr(labels)} ${value}\n`;
	return out;
}

/** Render the full Prometheus exposition for a collector snapshot. */
export function renderPrometheus(c: MetricsCollector): string {
	return [
		renderHistogram(
			'voice_turn_latency_e2e_ms',
			'End-to-end stop-to-first-audio latency (ms). Provider-anchored samples are a bounded-bias LOWER BOUND (anchor = provider VAD event receipt time).',
			c.turnE2eMs,
		),
		renderCounter(
			'voice_turn_latency_dropped_total',
			'Turns that produced no latency sample, by reason (measurement coverage — see observability design §11).',
			c.turnLatencyDroppedTotal,
		),
		renderHistogram(
			'voice_turn_provider_processing_ms',
			'User-stop to provider-response-start (≈TTFT, ms).',
			c.turnProviderProcessingMs,
		),
		renderHistogram(
			'voice_turn_backend_to_client_ms',
			'Provider-response-start to first-audio-out (ms).',
			c.turnBackendToClientMs,
		),
		renderHistogram(
			'voice_stop_to_transcript_ms',
			'Stop-to-transcript latency (ms).',
			c.stopToTranscriptMs,
		),
		renderHistogram(
			'voice_bargein_cancel_latency_ms',
			'Barge-in detect→cancel-actuation latency (ms).',
			c.bargeInCancelLatencyMs,
		),
		renderCounter(
			'voice_bargein_total',
			'Barge-ins by outcome (successful=actuated).',
			c.bargeInTotal,
		),
		renderCounter(
			'voice_turns_total',
			'Finalized turns (interruption-rate denominator).',
			c.turnsTotal,
		),
		renderCounter(
			'voice_turns_interrupted_total',
			'Finalized turns that were interrupted.',
			c.turnsInterruptedTotal,
		),
		renderCounter(
			'voice_bargein_recovered_total',
			'Interrupted turns followed by a clean turn (recovery).',
			c.bargeInRecoveredTotal,
		),
		renderCounter(
			'voice_jumpin_total',
			'Agent took the floor while the user was still speaking (jump-ins).',
			c.jumpInTotal,
		),
		renderHistogram(
			'voice_reentry_latency_ms',
			'Pause from a yield (interrupt) to the agent re-entering with audio (ms).',
			c.reentryLatencyMs,
		),
		renderHistogramVec(
			'voice_tts_ttfb_ms',
			'TTS time-to-first-byte by provider (ms).',
			c.ttsTtfbMs,
		),
		renderHistogramVec(
			'voice_tool_duration_ms',
			'Tool execution duration by status (ms).',
			c.toolDurationMs,
		),
		renderCounter('voice_tool_total', 'Tool results by status.', c.toolTotal),
		renderCounter('voice_error_total', 'Framework errors by component and severity.', c.errorTotal),
	].join('\n');
}

/** The Prometheus exporter (implements {@link MetricsExporter}). */
export class PrometheusExporter implements MetricsExporter {
	readonly contentType = PROMETHEUS_CONTENT_TYPE;
	render(collector: MetricsCollector): string {
		return renderPrometheus(collector);
	}
}

/** Minimal response shape a `/metrics` handler writes to (Node `http` compatible). */
export interface MetricsHttpResponse {
	statusCode?: number;
	setHeader(name: string, value: string): void;
	end(body: string): void;
}

/**
 * Build a host-mountable `/metrics` request handler. The framework owns no HTTP
 * server — the host app mounts this (e.g. on its existing Node `http` server or
 * an Express route). Renders the current snapshot on each call.
 */
export function createMetricsHandler(
	collector: MetricsCollector,
	exporter: MetricsExporter = new PrometheusExporter(),
): (_req: unknown, res: MetricsHttpResponse) => void {
	return (_req, res) => {
		res.statusCode = 200;
		res.setHeader('Content-Type', exporter.contentType);
		res.end(exporter.render(collector));
	};
}
