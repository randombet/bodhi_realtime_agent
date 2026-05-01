# Widget Embed Tester (cross-origin smoke test)

Standalone page on a **different port** from the Bodhi app. Use it to verify a published widget actually works when embedded on an external site.

## Prerequisites

1. Bodhi **API server** running (default `http://127.0.0.1:9900` — `pnpm dev`).
2. Bodhi **web client** running so `bodhi-widget.js` is served (default `http://127.0.0.1:8080` — `pnpm dev:client`).
3. A **published** widget in Agent Studio (toggle Published on).

## Quick start

```bash
# From the repo root:
pnpm examples:embed-widget-dump
```

Open the URL printed in the terminal (default `http://127.0.0.1:8765/`).

The page has a form — paste your `wg_*` widget ID, hit **Test Embed**, and watch the activity log. It will:

1. Call `POST /api/embed/widget-sessions` and show the raw response (status, body, errors).
2. If successful, inject `bodhi-widget.js` and mount the iframe — exactly like a real external site would.

## Troubleshooting

| Error | Meaning | Fix |
|-------|---------|-----|
| **Network error** | Can't reach the API server | Start the Bodhi server (`pnpm dev`) |
| **404 widget_not_found** | Widget ID doesn't exist or isn't published | Check ID; toggle Published in Studio |
| **Failed to load bodhi-widget.js** | Vite dev server isn't running | Start it (`pnpm dev:client`) |

## Env / port override

| Variable | Default |
|----------|---------|
| `HOST` | `127.0.0.1` |
| `PORT` | `8765` (auto-falls-back to an ephemeral port if busy) |

```bash
PORT=8766 pnpm examples:embed-widget-dump
```
