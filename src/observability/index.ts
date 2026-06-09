// SPDX-License-Identifier: MIT

/**
 * Optional observability module (`@bodhi_agent/realtime-agent-framework/observability`).
 *
 * Aggregates {@link FrameworkHooks} events into Prometheus-style metrics and
 * renders a `/metrics` exposition. Dependency-free; opt-in via subpath import so
 * the core stays zero-dependency.
 */

export {
	Counter,
	DEFAULT_LATENCY_BUCKETS_MS,
	Histogram,
	HistogramVec,
	labelKey,
} from './histogram.js';
export { MetricsCollector } from './metrics-collector.js';
export {
	createMetricsHandler,
	type MetricsExporter,
	type MetricsHttpResponse,
	PROMETHEUS_CONTENT_TYPE,
	PrometheusExporter,
	renderPrometheus,
} from './prometheus.js';
