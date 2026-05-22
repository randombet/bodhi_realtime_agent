# Transport

Transport abstracts provider-specific realtime APIs behind a common interface.

**Two legs (do not conflate them):**

```text
[Browser or device] ─── Leg 1 ───> [App server / VoiceSession] ─── Leg 2 ───> [Gemini or OpenAI]
```

- **Leg 2** in this doc’s main sections is **`LLMTransport`** — Gemini Live or OpenAI Realtime from **your server** to the **vendor**.
- **Leg 1** is **client media** (`IClientChannel`, `ClientMediaProfile`) — the **user’s** connection **into** your app / `VoiceSession`. See the section *Client media* below and [VoiceSession](/guide/voice-session).

## LLM transport (Gemini / OpenAI)

This is what most people mean by “transport” in the framework: the **`LLMTransport`** that connects **`VoiceSession`** to the **cloud realtime voice model** (Gemini Live or OpenAI Realtime).

### Providers

- Gemini Live transport
- OpenAI Realtime transport

### Responsibilities

- live session connect/disconnect
- turn and interruption handling
- tool call/result protocol mapping
- provider-specific session update and recovery logic

### STT/TTS

- Built-in transcription is supported via transport/provider capabilities.
- External STT/TTS providers can be attached at session level. For TTS, `VoiceSession` receives a framework `ttsProvider`; app/server code should resolve human-facing choices such as named Cartesia/ElevenLabs/Hume presets into provider config before constructing the session.
- Do not use provider API-key environment variables as provider selectors. They are fallback credentials only; product selection should come from saved agent config or an explicit session/query override.

---

## Client media (separate from LLM transport)

The **client ↔ framework** audio/control path is **not** the same socket as the LLM vendor connection. It is implemented by **`IClientChannel`** (see `createClientChannel` in the framework) and selected with **`ClientMediaProfile`** on **`VoiceSessionConfig`**.

| Profile | Meaning |
|---------|--------|
| **`websocket` (default)** | Mic and assistant PCM use **binary WebSocket** frames on the same connection as JSON control (or local `ClientTransport` when the server does not own the socket). |
| **`direct_rtc`** | **Split plane:** JSON control (and RTC signaling) stay on the **WebSocket** via **`SessionClientSender.sendJson`**; optional **Opus RTP** for mic/assistant audio when `rtcAudio: 'werift_opus'` is enabled. |

**Important:** `direct_rtc` does **not** replace **`VoiceSession`** or **`LLMTransport`**. Gemini/OpenAI still use their **existing** provider WebSockets from the server. Only the **device ↔ your app server ↔ `VoiceSession` input/output** audio encoding changes when you opt into direct RTC.

### Playback-state support

The playback gate needs one ordered path for assistant audio and JSON. It is
supported on WebSocket PCM surfaces that render audio through the buffered client
playback path. It is not supported when assistant audio is delivered over
`direct_rtc` Opus RTP, because the audio and `audio.done` JSON frame no longer
share ordering.

For server-owned sockets, expose this capability with
`SessionClientSender.supportsPlaybackStateProtocol` and implement
`sendJsonAfterAudio`. See [Playback Gate](/guide/playback-gate).

See also:

- [VoiceSession](/guide/voice-session) — `clientMedia`, `clientSender`, and session wiring
- [Playback Gate](/guide/playback-gate) — `audio.done` / `playback.ended` turn-completion gating
- [Architecture overview](/guide/architecture) — two independent realtime links (client leg vs vendor leg)

Internal implementation notes: `dev_docs/framework/low-signal-client-transport-implementation-plan.md` (repository path).
