

# Bodhi publishable web widget (`wg_*`)

This document describes **Surface B** — the **public embed widget** flow for third-party websites. For the programmable REST + WebSocket surface (**Surface A**), see [Hosted Bodhi voice API](./hosted-voice-api.md) and [Integration surfaces](./integration-surfaces.md).

---

## Mental model

| Concept | Meaning |
|---------|---------|
| **`wg_*` widget id** | Opaque public id minted in Agent Studio; maps to one saved agent **`ua_*`**. |
| **Published** | Only published widgets can call **`POST /api/embed/widget-sessions`**. |
| **Mode** | `voice` — embed shows voice-only phone card; `voice_avatar` — Spatial Real avatar in the phone card (requires server + saved agent avatar config). |

Visitors never receive raw **`ua_*`** or long-lived **`bsk_*`** tokens — only a **short-lived embed intent** (same family as authenticated `POST /api/embed/avatar-sessions`).

---

## 1. Authoring in Agent Studio (Docs tab: **Publishable widget**)

Open **Agent Studio → Docs** (or **Advanced & testing**) and use **Publishable widget (`wg_*`)** while signed in with Supabase.

### 1.1 Save the agent first

1. **Build** tab: create or edit the agent and use **Create** / save so you have a stable **`ua_*`** id.
2. **Advanced & testing** tab: click **Save advanced changes** after editing **Knowledge base** or **Avatar** — uploads and widget actions expect a persisted agent.

### 1.2 Voice + avatar widgets

For **`voice + avatar`** (or switching an existing widget to that mode):

1. Server must have avatar authoring enabled (`BODHI_AVATAR_ENABLED` + Spatial Real bridge env — see `env.example_avatar` and `app/docs/avatar-integration.md`).
2. Under **Avatar**, turn **Use avatar for this saved agent** on, pick **Avatar provider** and **Character**, then **Save advanced changes**.
3. The **New voice + avatar widget** button stays disabled until the saved agent actually has **`avatarConfig`** with a preset; if the UI shows a character but the button is still disabled, save again from **Advanced & testing**.

### 1.3 Create and publish the widget

1. Under **Publishable widget**, use **New voice widget** or **New voice + avatar widget** (when enabled).
2. Set **allowed origins** for production sites, then toggle **Published** when you want visitor sites to call **`POST /api/embed/widget-sessions`**. An empty allowlist is permissive for local/dev compatibility; configured origins are enforced from the browser `Origin`/`Referer`.

You can change **Mode** on an existing row with the dropdown; updates use **`PATCH`** to the same API origin as the rest of Agent Studio.

---

## 2. Public bootstrap API

**`POST /api/embed/widget-sessions`**

- **Auth:** none (visitor browser).
- **Body:**

```json
{ "widgetId": "wg_0123456789abcdef" }
```

- **Validation:** widget must exist, be **published**, and match **mode** (for `voice_avatar`, the saved agent must have avatar enabled + preset on the server).
- **Origin allowlist:** when `allowedOrigins` is non-empty, the request origin must match one configured HTTP(S) origin exactly.

**Success (200)** — short-lived embed intent plus metadata:

```json
{
  "embedSessionIntentId": "emb_…",
  "embedToken": "…",
  "expiresAt": "…",
  "agentProfile": "ua_…",
  "widgetId": "wg_…",
  "embedMode": "voice_avatar",
  "avatarPresetId": "…",
  "spatialAvatarId": "…",
  "avatarProviderId": "spatialreal",
  "embedPagePath": "/embed/avatar"
}
```

For `embedMode: "voice"`, `avatarPresetId`, `spatialAvatarId`, and `avatarProviderId` are `null`. Load **`/embed/avatar`** on your **web** host with query params:

- `embedSessionIntentId`, `embedToken`, `agentProfile`
- `embedMode` (`voice` | `voice_avatar`)
- `avatarProviderId` and `avatarPresetId` when avatar mode (`spatialAvatarId` is still accepted for Spatial Real compatibility)

---

## 3. One-line install (hosted script)

Ship **`bodhi-widget.js`** from your Bodhi **web** deployment (`app/web-client/public/bodhi-widget.js`). Third-party sites add:

```html
<script
  src="https://YOUR_BODHI_WEB_HOST/bodhi-widget.js"
  data-bodhi-widget-id="wg_0123456789abcdef"
  data-bodhi-api-base="https://YOUR_BODHI_API_ORIGIN"
  async
></script>
```

| Attribute | Role |
|-----------|------|
| **`src`** | Where **`bodhi-widget.js`** is served (usually the same public host as your SPA). The loader uses this origin to open the **`/embed/avatar`** iframe. |
| **`data-bodhi-api-base`** | Bodhi **API** origin used for **`POST …/api/embed/widget-sessions`** (often the same hostname as production, or e.g. `http://127.0.0.1:9900` locally). |

Optional: **`data-bodhi-container="dom-id"`** mounts the iframe into that element.

---

## 4. Iframe-only integration

Call **`POST /api/embed/widget-sessions`** (from the visitor browser with the widget script, or from your backend if you proxy), then set:

`iframe.src = https://YOUR_BODHI_WEB_HOST/embed/avatar?embedSessionIntentId=…&embedToken=…&agentProfile=…&embedMode=…&avatarProviderId=…&avatarPresetId=…`

---

## 5. Relationship to programmatic `/api/embed/*`

| Endpoint | Audience |
|----------|----------|
| `POST /api/embed/avatar-sessions` | Authenticated integrators (Supabase session or **`bsk_*`**) — **Surface A**. |
| `POST /api/embed/widget-sessions` | Visitor browsers with a **published** **`wg_*`** — **Surface B**. |

---

## 6. HTTPS / reverse proxy (nginx on EC2)

The widget does **not** introduce a new network service. It uses:

- Existing **HTTPS** (or HTTP) to your **API** for `POST /api/embed/widget-sessions` and the voice **WebSocket** (same paths you already expose).
- Existing **HTTPS** to your **web** host for **`bodhi-widget.js`** and **`/embed/avatar`**.

If nginx already terminates TLS and proxies to your Bodhi **app server** and **web client** the same way you do today, you typically **do not** add new server blocks or certificates **unless** you put the script or API on a **new hostname** or port. Same-origin vs split API/web hosts only affect the two URL values in the snippet (`src` vs `data-bodhi-api-base`), not the number of TLS fronts.

---

## 7. Database

Supabase migration: `app/server/supabase/009_agent_embed_widgets.sql`.
Local dev without Supabase uses JSON files under **`./embed-widgets/`** on the server.
