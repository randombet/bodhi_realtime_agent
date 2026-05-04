# Architecture Overview

At a high level:

1. Client streams audio/text to `VoiceSession`.
2. Transport handles live model IO (Gemini/OpenAI).
3. Main agent decides tool calls and transfers.
4. Tool layer executes inline/background work.
5. Subagents handle long-running tasks.
6. Events/hooks expose observability and integration points.

## Realtime links: client media vs LLM transport

There are **three** links in a typical deployment — not one monolithic “voice socket”:

1. **Client or device ↔ your Bodhi app server** — capture, playback, and JSON control (and optional WebRTC signaling) on paths you own.
2. **App server ↔ `VoiceSession`** — your server forwards WebSocket binary/JSON (or decoded PCM from an RTC bridge) into the framework.
3. **`VoiceSession` / `LLMTransport` ↔ Gemini or OpenAI realtime** — the **vendor** WebSocket(s); unchanged when you change how the browser talks to your server.

Framework option **`clientMedia: { kind: 'direct_rtc' }`** only affects **link (1)** (optional Opus RTP for audio when `rtcAudio: 'werift_opus'`). It does **not** replace link (3). See [Transport](/guide/transport) and [VoiceSession](/guide/voice-session).

## Key runtime modes

- `legacy`: classic router-based orchestration
- `actor`: actor-runtime orchestration

See [Actor Runtime Pattern](/guide/actor-pattern) for details.

## Main components

- `VoiceSession` (session lifecycle and wiring)
- `LLMTransport` implementations
- `ToolExecutor` + router
- `AgentRouter` / transfer flow
- Memory + history stores
- EventBus + hooks
