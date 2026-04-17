// SPDX-License-Identifier: MIT

# Hosted Bodhi voice API

This document is for **teams building mobile or native apps** that call a **deployed** Bodhi realtime voice backend over the public internet. You do **not** need this repository or the TypeScript framework package in your app: use **HTTPS** for REST and **WSS** for the voice socket.

**Who this is for:** product engineers integrating against your production (or staging) **origin** — for example `https://voice.example.com`. Paths below are **relative to that origin**.

**Related:** Bodhi operators maintain reverse-proxy routing and TLS; see [internal routing notes](../../dev_docs/app/server/http-websocket-routing.md) in this repo (not required reading for app-only integrators).

---

## 1. Capabilities

| Surface | Purpose |
|---------|---------|
| **REST `/api/...`** | Session bootstrap, optional device context, session history, session teardown. |
| **WebSocket `/ws/mobile`** | Realtime **PCM audio** in both directions plus **JSON** control and transcripts. |

All sessions are keyed by a string **`userId`** resolved by the server (from your auth layer or, where explicitly supported, a documented query parameter). That id ties together **memory** and **conversation history** for the user.

---

## 2. Authentication

Your integration must match how **your** Bodhi deployment is configured:

- **Bearer token (typical production):** send `Authorization: Bearer <token>` on every HTTPS request and on the WebSocket upgrade if the deployment expects it.
- **Deployments that allow anonymous or dev-style access** may document a **`userId`** query parameter on REST; confirm with your operator — do not assume this is enabled in production.

Mobile voice bootstrap always uses the **same identity rules** as the rest of `/api/*`.

---

## 3. REST endpoints

Base path: **`https://<your-origin>/api/`**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/mobile/sessions` | Create a **short-lived session intent**. Optional JSON body: `agentProfile`, `deviceId`, `resumeSessionId`. Response includes `sessionIntentId`, `token`, `expiresAt`, `wsPath` (typically `/ws/mobile`). |
| `POST` | `/api/mobile/device-events` | Send **summarized** context while a voice session is **active** (e.g. location, motion, health aggregates). Body: `sessionId`, `eventType`, `payload` (object), optional `deviceId`, `timestamp`. Expect **`202`** when accepted. |
| `POST` | `/api/mobile/sessions/:sessionId/close` | Close that session for the authenticated user. |
| `GET` | `/api/users/me/sessions` | List sessions (when history/auth are configured on the deployment). |
| `GET` | `/api/users/me/sessions/:id` | Session metadata and conversation items. |
| `GET` | `/api/users/me/sessions/:id/export` | Same as above with download-friendly headers. |

**Device events:** Prefer **aggregates** computed on device (e.g. per second or per activity), not raw high-frequency sensor streams. Example `eventType` values you might standardize with your product team: `location.update`, `motion.summary`, `health.metric`.

**Operator note:** whether device events are injected into the live model depends on server version and configuration — confirm behavior with your backend team if the model must “see” sensor data without a spoken utterance.

---

## 4. WebSocket — mobile voice

### 4.1 URL

After a successful **`POST /api/mobile/sessions`**, open:

```text
wss://<your-origin>/ws/mobile?sessionIntentId=<id>&token=<token>
```

Use the **`sessionIntentId`** and **`token`** from the response. Treat the token as an **opaque secret** until the first successful connection.

**Scaling caveat:** intents may be stored **in process** on the node that created them. Multi-node deployments usually require **sticky routing** to the same instance or a future **signed intent** format — your operator confirms what applies.

### 4.2 Audio (binary frames)

Default contract when the realtime provider is Gemini-class:

| Direction | Format |
|-----------|--------|
| **Client → server** | Raw **PCM**, 16-bit **little-endian**, **mono**, **16 kHz**. One WebSocket **binary** message per chunk (e.g. 20–40 ms). **No** WAV header. |
| **Server → client** | Raw **PCM**, 16-bit LE, **mono**, **24 kHz**. |

If the deployment uses another LLM provider, the first JSON message **`session.config`** carries the authoritative `audioFormat` (sample rates, channels, `encoding: "pcm"`). Always honor that message when present.

### 4.3 JSON (text frames)

Each **text** frame is **one** UTF-8 JSON object.

**Server → client (examples):**

- `session.config` — audio format.
- `session.ready` — includes `userId`, `sessionId`, `agentProfile` when the voice session is live.
- `session.error` — `code`, `message`.
- `transcript` — user or assistant text; may include `"partial": true` while streaming.
- Additional types may include behavior catalogs, GUI updates, and turn/tool-related events aligned with the web client protocol.

**Client → server (examples):**

- `text_input` — user text to the model.
- `behavior.set`, `ui.response`, `file_upload` — when exposed by your deployment.

Voice-first apps usually send **only binary PCM** on the socket and use **`POST /api/mobile/device-events`** for structured context.

---

## 5. Session lifecycle (client view)

1. **`POST /api/mobile/sessions`** with your auth (or deployment-specific `userId` rules).
2. **Connect** `wss://.../ws/mobile?...` → wait for **`session.config`** then **`session.ready`** (note **`sessionId`**).
3. **Stream audio** until the user ends the session, the app backgrounds, or the server closes the socket.
4. Optionally **`POST /api/mobile/sessions/:sessionId/close`** for an explicit server-side end while the app still knows `sessionId`.

Treat **`session.error`**, HTTP **4xx/5xx**, and abnormal WebSocket close codes as **recoverable**: create a **new** intent and connect again. Respect **rate limits** and **max sessions per user** documented by your operator.

**Resume:** when supported, send **`resumeSessionId`** in the **`POST /api/mobile/sessions`** body to continue from stored history.

---

## 6. Example: create intent (HTTPS)

Replace `<your-origin>` and credentials with values from your environment.

```bash
curl -sS -X POST 'https://<your-origin>/api/mobile/sessions' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"agentProfile":"standard"}'
```

Example success shape (fields may vary by version):

```json
{
  "sessionIntentId": "…",
  "token": "…",
  "expiresAt": "2026-01-01T12:00:00.000Z",
  "wsPath": "/ws/mobile"
}
```

**List sessions (when enabled):**

```bash
curl -sS -H 'Authorization: Bearer <token>' \
  'https://<your-origin>/api/users/me/sessions'
```

---

## 7. Security expectations

- **API keys** for cloud LLMs stay **on the server** — never ship them in the mobile binary.
- **Intent tokens** are short-lived; do not log them in analytics in plain text.
- Use **TLS 1.2+** for all HTTP and WebSocket traffic (`https://` / `wss://`).

---

## 8. Quick reference

| Item | Value |
|------|-------|
| Mobile REST | `POST /api/mobile/sessions`, `POST /api/mobile/device-events`, `POST /api/mobile/sessions/:id/close` |
| Mobile voice | `wss://<your-origin>/ws/mobile?sessionIntentId=&token=` |
| Mic → server | PCM s16le mono **16 kHz** (unless `session.config` says otherwise) |
| Speaker ← server | PCM s16le mono **24 kHz** (default Gemini path) |
| Text frames | Single JSON object per message |

For **framework and server implementation** details (forking or self-hosting), this repository’s [app README](../../app/README.md) and internal [developer documentation](../../dev_docs/README.md) apply — they are not required reading for API-only integration.
