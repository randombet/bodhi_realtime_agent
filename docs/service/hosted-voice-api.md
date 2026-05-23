// SPDX-License-Identifier: MIT

# Hosted Bodhi voice API

This document is for **teams building mobile or native apps** that call a **deployed** Bodhi realtime voice backend over the public internet. You do **not** need this repository or the TypeScript framework package in your app: use **HTTPS** for REST and **WSS** for the voice socket.

**Who this is for:** product engineers calling **hosted Bodhi** over the public internet. The production API host is **`https://bodhiagent.live`**; all paths below are **relative to that origin**. If you use a **self‑hosted** deployment with another public HTTPS origin, substitute your host (same path layout: `/api/...`, `/ws/mobile`).

**Related:** Bodhi operators maintain reverse-proxy routing and TLS; see [internal routing notes](../../dev_docs/app/server/http-websocket-routing.md) in this repo (not required reading for app-only integrators).

**Integration surfaces:** This page documents **Surface A — programmable API** (REST + WebSocket, full control). For **Surface B — publishable browser widget** (`wg_*`, allowlisted origins, hosted `/embed/avatar`), see [Integration surfaces](./integration-surfaces.md) and [Widget embed](./widget-embed.md).

### First time here? How the two connections fit

**Same session, two “legs” to remember** (hosted mobile path is Leg 1 only; the cloud model is Leg 2 inside Bodhi):

```text
[Your mobile / web app] ─── Leg 1 ───> [Bodhi app / VoiceSession] ─── Leg 2 ───> [Gemini or OpenAI]
```

On **`bodhiagent.live`**, your client only speaks **Leg 1** (HTTPS bootstrap + **`/ws/mobile`** PCM + JSON). **Leg 2** (vendor realtime) runs **inside** Bodhi’s backend — you do not open a second WebSocket to Google/OpenAI from your app.

- **Two layers on Leg 1:** **HTTPS** (`/api/...`) for **bootstrap** and **WSS** (`/ws/mobile`) for **realtime voice and control**. The `POST` that creates a session **intent** does **not** open the WebSocket for you and does **not** carry audio. Your client performs **both** the HTTPS call **and** the WebSocket connect.

- **Typical order:** (1) `POST /api/mobile/sessions` with auth → you get `sessionIntentId`, `token`, and usually `wsPath` (`/ws/mobile`). (2) Your app **opens** `wss://bodhiagent.live/ws/mobile?sessionIntentId=...&token=...` (same `Authorization: Bearer` on the upgrade if your client sends it for `bsk_` or other tokens). (3) On the socket, wait for **`session.config`** (audio format) then **`session.ready`** (gives a real `sessionId`, `userId`, `agentProfile`). (4) **Stream** user mic as **binary** WebSocket messages; **receive** assistant audio as **binary** and UI/transcripts as **JSON** text frames.

- **“Starting” the call:** The live session is established after **`session.ready`**. You do not need a special JSON “start call” event for voice. After the socket is ready, send **microphone PCM** as **binary** frames (and optionally **`text_input`** and other supported JSON message types in **text** frames). If you only use voice, you may send **only** binary PCM on the wire.

- **Ending:** Stop streaming, **close** the WebSocket, and optionally `POST /api/mobile/sessions/:sessionId/close` with `sessionId` from `session.ready`.

---

## 1. Capabilities

| Surface | Purpose |
|---------|---------|
| **REST `/api/...`** | Session bootstrap, optional device context, session history, session teardown. |
| **WebSocket `/ws/mobile`** | Realtime **PCM audio** in both directions plus **JSON** control and transcripts. |

All sessions are keyed by a string **`userId`** resolved by the server (from your auth layer or, where explicitly supported, a documented query parameter). That id ties together **memory** and **conversation history** for the user.

### Current hosted contract vs framework `direct_rtc`

**What hosted Bodhi documents and supports today:** **`/ws/mobile`** is **PCM over WebSocket** (binary frames) plus **JSON** text frames for control and transcripts, as described in §4. Do **not** assume a public **hosted** WebRTC/Opus-RTP leg exists until your operator ships and documents it.

The TypeScript framework separately supports **`clientMedia: { kind: 'direct_rtc' }`** for **self-hosted** or custom app servers that wire `SessionClientSender`, relay **`rtc.*`** JSON on the same WebSocket, and own STUN/TURN policy. That is **orthogonal** to the vendor **`LLMTransport`** socket to Gemini/OpenAI — see [Transport](/guide/transport) and [Client voice transport (app server)](../../app/docs/client-voice-transport.md) (repo path).

---

## 2. Authentication

Your integration must match how **your** Bodhi deployment is configured:

- **Bearer token (typical production):** send `Authorization: Bearer <token>` on every HTTPS request and on the WebSocket upgrade if the deployment expects it.
- **Deployments that allow anonymous or dev-style access** may document a **`userId`** query parameter on REST; confirm with your operator — do not assume this is enabled in production.

Mobile voice bootstrap always uses the **same identity rules** as the rest of `/api/*`.

### 2.1 User-defined agents (`ua_*`) — Bodhi integration API keys (optional)

When your operator enables **Agent Studio** with **Supabase** and **hosted integration keys**, a signed-in builder can mint a **Bodhi integration API key** in Agent Studio. Keys look like `bsk_<uuid>_<random>`; the **full string** is the secret (shown once at creation).

Use that key as the Bearer token on **`POST /api/mobile/sessions`** and when opening **`/ws/mobile`** (same `Authorization` header on the WebSocket upgrade, if your stack supports it).

**Rules (additive — existing deployments keep working as before):**

- **First-party catalog** profiles (`standard`, and other ids from your deployment’s profile catalog) keep using whatever Bearer / auth model you already use.
- **`agentProfile` set to a saved Agent Studio id** (`ua_` + 16 hex characters) **must** use a valid **Bodhi integration key** for the **same Supabase user** that owns that saved agent. Other Bearer tokens for `ua_*` receive **403** (`integration_api_key_required`) on session create (and the WebSocket bind is rejected for defense in depth).
- A **malformed or unknown** `bsk_...` token is rejected with **401** (`invalid_integration_key`) and is **not** interpreted as another auth method (prevents accidental fallback to weaker identity).

Managing keys (create / list metadata / revoke) is done in **Agent Studio** while signed in with the normal web session, under **Hosted API access keys**. Integrators do not need those URLs unless they are also the account owner.

---

## 3. REST endpoints

Base path (hosted): **`https://bodhiagent.live/api/`** — use your own origin if self-hosting.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/mobile/sessions` | Create a **short-lived session intent**. Optional JSON body: `agentProfile` (a registered catalog id from `app/agents/agent-profiles-catalog.ts` — unknown values are treated as `standard` — **or**, when enabled on your deployment, a saved Agent Studio id `ua_` + 16 hex with a **Bodhi integration key**, see §2.1), `deviceId`, `resumeSessionId`, `speechOutput`. Response includes `sessionIntentId`, `token`, `expiresAt`, `wsPath` (typically `/ws/mobile`). |
| `POST` | `/api/mobile/device-events` | Send **summarized** context while a voice session is **active** (e.g. location, motion, health aggregates). Body: `sessionId`, `eventType`, `payload` (object), optional `deviceId`, `timestamp`. Expect **`202`** when accepted. |
| `POST` | `/api/mobile/sessions/:sessionId/close` | Close that session for the authenticated user. |
| `GET` | `/api/voice/speech-output-options` | Return supported native voices, TTS providers, featured presets, model choices, and required BYOK key names. |
| `GET` | `/api/users/me/sessions` | List sessions (when history/auth are configured on the deployment). |
| `GET` | `/api/users/me/sessions/:id` | Session metadata and conversation items. |
| `GET` | `/api/users/me/sessions/:id/export` | Same as above with download-friendly headers. |

**Device events:** Prefer **aggregates** computed on device (e.g. per second or per activity), not raw high-frequency sensor streams. Example `eventType` values you might standardize with your product team: `location.update`, `motion.summary`, `health.metric`.

**Operator note:** whether device events are injected into the live model depends on server version and configuration — confirm behavior with your backend team if the model must “see” sensor data without a spoken utterance.

### 3.1 Speech output

Omit `speechOutput` to use the saved agent or server default.

Native live-model speech:

```jsonc
{
  "agentProfile": "ua_...",
  "speechOutput": {
    "mode": "native",
    "provider": "gemini",
    "voiceName": "Puck"
  }
}
```

External TTS:

```jsonc
{
  "agentProfile": "ua_...",
  "speechOutput": {
    "mode": "tts",
    "provider": "elevenlabs",
    "voiceId": "21m00Tcm4TlvDq8ikWAM",
    "modelId": "eleven_flash_v2_5"
  }
}
```

Provider credentials still live on the server. For saved Agent Studio agents, user BYOK keys win over server fallback environment keys.

---

## 4. WebSocket — mobile voice

### 4.1 URL

After a successful **`POST /api/mobile/sessions`**, open:

```text
wss://bodhiagent.live/ws/mobile?sessionIntentId=<id>&token=<token>
```

Use the **`sessionIntentId`** and **`token`** from the response. Treat the token as an **opaque secret** until the first successful connection.

**Optional profile context (same as browser `/ws`):** if you previously called `POST /api/profile-session-context/draft` with `{ "kind": "structured_screening", "payload": { … } }` (or `structured_interview`), append the returned token as **`profileContextToken=<token>`** on the WebSocket URL. The server resolves it into `profileSessionInputs` and passes it into the same `createBodhiSessionConfig` path as every other voice connection. Legacy per-profile query keys (`recruitingContextToken`, `interviewContextToken`) are still accepted but new integrations should use the single `profileContextToken`.

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
- `audio.done` — end of a turn's audio, when the optional playback-state protocol is enabled (see §4.4).
- Additional types may include behavior catalogs, GUI updates, and turn/tool-related events aligned with the web client protocol.

**Client → server (examples):**

- `text_input` — user text to the model.
- `behavior.set`, `ui.response`, `file_upload` — when exposed by your deployment.
- `playback.ended` — reports turn audio finished playing, when the optional playback-state protocol is enabled (see §4.4).

Voice-first apps usually send **only binary PCM** on the socket and use **`POST /api/mobile/device-events`** for structured context.

**Forward compatibility:** a client **MUST ignore** any JSON text frame whose `type` it does not recognize. New message types are added over time; an unknown `type` is never an error.

### 4.4 Playback-state protocol (optional)

This is an **optional** two-message handshake that lets the server know exactly when your device has finished *playing* a turn's audio — not just when it finished *sending* it. The server uses it to keep the barge-in (interrupt) window open precisely while audio is audible, which matters most when the server's text-to-speech runs faster than realtime (it cannot otherwise know your playback clock).

It is **opt-in per deployment**. If your deployment has not enabled it you will simply never receive `audio.done`; ignore this section. If you do not implement it, nothing breaks — see *Fallback* below.

**Server → client:**

```json
{ "type": "audio.done", "playbackId": 7 }
```

Sent **after the last binary audio frame** of a turn, only when the turn produced audio. Treat `playbackId` as an **opaque token**: it identifies one turn's audio within the current live session — it changes per turn and on each interrupt — and is meaningful only for that session. Do **not** assume it is globally unique or monotonic across reconnects; the counter restarts when the session does, so an id from a prior connection can collide with a new one. Echo it back unchanged in the matching `playback.ended`, and discard any outstanding `audio.done` when the connection drops.

**Client → server:**

```json
{ "type": "playback.ended", "playbackId": 7 }
```

Send this **once** per turn, when **both** of these are true:

1. You have received `audio.done` for that `playbackId`, **and**
2. Your audio output buffer for the turn has fully drained (all PCM has been played).

Echo back the **exact** `playbackId` from the matching `audio.done`. A short settle delay after buffer drain (covering the OS/hardware output buffer) before sending is recommended so a tail barge-in's microphone frame reaches the server first.

**Ordering precondition.** `audio.done` always arrives after the final audio frame of its turn. You **must** wait for `audio.done` before sending `playback.ended` — never send it on buffer-drain alone. A mid-turn synthesis stall can drain the buffer momentarily; without the `audio.done` gate you would report the turn finished early and lose the rest of it.

**`playbackId` correlation.** The server ignores a `playback.ended` whose `playbackId` is not the current turn's (e.g. a late signal for a turn the user already barged in on). Stale or duplicate `playback.ended` frames are harmless.

**Fallback.** If the server never receives `playback.ended` (client does not implement the protocol, a dropped frame, a disconnect), it completes the turn on its own internal timer. The protocol is therefore **safe to skip** — you get a slightly less precise barge-in window, nothing more.

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

Replace host only if you are not on hosted Bodhi; always use real credentials from your environment.

```bash
curl -sS -X POST 'https://bodhiagent.live/api/mobile/sessions' \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"agentProfile":"standard"}'
```

**Same endpoint with a saved Agent Studio agent** (when §2.1 applies; use the full `bsk_...` secret from Agent Studio):

```bash
curl -sS -X POST 'https://bodhiagent.live/api/mobile/sessions' \
  -H 'Authorization: Bearer bsk_<uuid>_<secret>' \
  -H 'Content-Type: application/json' \
  -d '{"agentProfile":"ua_0123456789abcdef"}'
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
  'https://bodhiagent.live/api/users/me/sessions'
```

### Related: browser avatar embed (Spatial Real)

For a **first-party web embed** (iframe or hosted page on the same Bodhi origin) that shows the Spatial Real face plus voice on **`/ws`** (not `/ws/mobile`), see **`app/docs/avatar-integration.md` §2.5–2.6**: `POST /api/embed/avatar-sessions`, `POST /api/embed/spatial-session-token`, and the **`/embed/avatar`** route. That path uses short-lived **embed intents** on the WebSocket instead of shipping a long-lived `bsk_` secret to an untrusted browser. **§2.6** contrasts this with the normal **`/api/users/me/agents`** CRUD API (persistence vs bootstrap-only).

### Related: remote coding worker from Agent Studio

If you use Agent Studio with `remote_persistent_worker` (main voice agent in Bodhi, coding worker on your own server), follow:

- [Remote persistent worker setup](./remote-persistent-worker-setup.md)
- [Example bridge server](../../examples/remote-persistent-worker/server.mjs)

---

## 7. Security expectations

- **API keys** for cloud LLMs stay **on the server** — never ship them in the mobile binary.
- **Bodhi integration keys (`bsk_`)** are **server-to-server or per-device secrets** for *your* product to call Bodhi on behalf of a builder’s account. Prefer storing them in your backend or secure device vault, not in screenshots or shared chat.
- **Intent tokens** are short-lived; do not log them in analytics in plain text.
- Use **TLS 1.2+** for all HTTP and WebSocket traffic (`https://` / `wss://`).

---

## 8. Quick reference

| Item | Value |
|------|-------|
| Mobile REST | `POST /api/mobile/sessions`, `POST /api/mobile/device-events`, `POST /api/mobile/sessions/:id/close` |
| Mobile voice | `wss://bodhiagent.live/ws/mobile?sessionIntentId=&token=` |
| Mic → server | PCM s16le mono **16 kHz** (unless `session.config` says otherwise) |
| Speaker ← server | PCM s16le mono **24 kHz** (default Gemini path) |
| Text frames | Single JSON object per message |

For **framework and server implementation** details (forking or self-hosting), this repository’s [app README](../../app/README.md) and internal [developer documentation](../../dev_docs/README.md) apply — they are not required reading for API-only integration.
