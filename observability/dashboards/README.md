# Voice-agent observability dashboards

Turnkey self-hosted stack for the HAI voice metrics: **Prometheus scrapes the
app's `/metrics` endpoint, Grafana renders the dashboard.**

## 1. Expose `/metrics` from your app

The framework owns no HTTP server — mount the handler on yours:

```ts
import { MetricsCollector, createMetricsHandler } from '@bodhi_agent/realtime-agent-framework/observability';

const collector = new MetricsCollector();
const session = new VoiceSession({ /* ...config */, hooks: collector.hooks });

// On your existing Node http server (default scrape port below is 8787):
const metrics = createMetricsHandler(collector);
httpServer.on('request', (req, res) => {
  if (req.url === '/metrics') return metrics(req, res);
  // ...your other routes
});
```

## 2. Point Prometheus at it

Edit `prometheus.yml` → `scrape_configs[0].targets` to your app's `host:port`
(default `host.docker.internal:8787`).

## 3. Run the stack

```bash
docker compose -f observability/dashboards/docker-compose.yml up
```

- Grafana → http://localhost:3000 (anonymous admin) — the **Bodhi Voice Agent —
  HAI Metrics** dashboard is auto-provisioned.
- Prometheus → http://localhost:9090 (alert rules from `alert-rules.yml` loaded).

## What's live vs. offline

| Layer | Panels | Source |
|-------|--------|--------|
| 1 Infrastructure | E2E latency P50/95/99, TTFT, TTS ttfb | live (Phase 1) |
| 2 Execution | tool result rate, error rate | live (Phase 1) |
| 3 User behavior | barge-in cancel P95, recovery rate, interruption/jump-in | live (Phase 1.5) |
| 2/4 Quality & business | WER, MOS, TSR, FCR, sentiment | **offline** — Phase 5 ingestion (placeholder panel) |

## OpenTelemetry (Phase 2, optional)

To use the OTLP push path instead of direct scraping, uncomment the
`otel-collector` service in `docker-compose.yml` and the `otel-collector:8889`
job in `prometheus.yml`, wire your app with `createOtelMetricsHooks` (see
`../otel-config.yml`), and for traces add the `otel-config.traces.yml` pipeline
plus a Tempo/Jaeger backend.

## Alerting

`alert-rules.yml` ships **example templates only** (E2E P95 > 800ms, barge-in
cancel P95 > 60ms, recovery < 90%). Running Alertmanager / delivering
notifications is the operator's responsibility.
