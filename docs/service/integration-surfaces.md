// SPDX-License-Identifier: MIT

# Bodhi integration surfaces

This document defines the **two external integration surfaces** for Agent Studio agents on a hosted Bodhi deployment. Pick **one primary surface** per product integration; they are intentionally separate.

---

## Surface A — Programmable API (full control)

**Audience:** Mobile, native, or web teams that **own** networking, UI, and session lifecycle.

**What you integrate:**

| Piece | Role |
|-------|------|
| **HTTPS** `POST /api/mobile/sessions` (and related REST) | Authenticated bootstrap; returns short-lived **session intent** + token. |
| **WSS** `/ws/mobile` | Realtime PCM + JSON control after connecting with intent query params. |

**Identifiers:**

- Saved agent id: **`ua_*`** (16 hex), chosen at bootstrap time.
- Auth: Supabase session and/or **Bodhi integration API key** `bsk_*` per [Hosted Bodhi voice API](./hosted-voice-api.md).

**You implement:** mic capture, playback, transcripts UI, reconnect policy, and any avatar/visual layer yourself.

---

## Surface B — Publishable widget (hosted UI)

**Audience:** Web teams that want a **one-line** or **iframe** embed with Bodhi-managed Talk UI, bootstrap, WebSocket wiring, and optional Spatial Real avatar.

**What you integrate:**

| Piece | Role |
|-------|------|
| **Published widget id** **`wg_*`** | Public handle mapped to a saved `ua_*` agent (configured in Agent Studio). |
| **Snippet or iframe** | Load [`bodhi-widget.js`](./widget-embed.md) or open the hosted `/embed/avatar` URL with params from bootstrap. |

**Public bootstrap (no user login on the visitor’s site):**

- `POST /api/embed/widget-sessions` with `{ "widgetId": "wg_..." }`  
- Server checks **published** state and widget **mode** (`voice` vs `voice_avatar`) against the saved agent.  
- Response mirrors the short-lived embed intent shape ([widget embed](./widget-embed.md)).

**You do not expose** raw `ua_*`, long-lived `bsk_*`, or manual WS assembly to the **visitor’s browser** for the default widget path—only the short-lived embed intent/token pair.

---

## Choosing between surfaces

| Need | Use |
|------|-----|
| Native app, custom UI, wearable hooks | **Surface A** — [Hosted Bodhi voice API](./hosted-voice-api.md) |
| Marketing site / SaaS embed with minimal code | **Surface B** — [Widget embed](./widget-embed.md) |
| Web app with full control but browser-only | **Surface A** using the same REST + `/ws` contract as documented, or npm **`@bodhi/web-sdk`** (see package READMEs under `packages/`). |

---

## Relationship to internal embed APIs

Endpoints such as `POST /api/embed/avatar-sessions` remain the **programmable, authenticated** path for developers who already have **Supabase session or `bsk_*`** and want to drive `/embed/avatar` explicitly. They are **foundational** for tooling and advanced flows; the **productized** external embed path for third-party sites is **`wg_*`** + `POST /api/embed/widget-sessions`.

See [Avatar integration](../../app/docs/avatar-integration.md) (repo path `app/docs/avatar-integration.md`) for app-layer avatar wiring details.
