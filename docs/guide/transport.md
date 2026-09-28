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
- External STT/TTS providers can be attached at session level. For TTS, `VoiceSession` receives a framework `ttsProvider`; your application code should resolve human-facing choices such as named Cartesia/ElevenLabs/Hume presets into provider config before constructing the session.
- Do not use provider API-key environment variables as provider selectors. They are fallback credentials only; product selection should come from saved agent config or an explicit session/query override.

---

## Client media (separate from LLM transport)

The **client ↔ framework** audio/control path is **not** the same socket as the LLM vendor connection. It is implemented by **`IClientChannel`** (see `createClientChannel` in the framework) and selected with **`ClientMediaProfile`** on **`VoiceSessionConfig`**.

| Profile | Meaning |
|---------|--------|
| **`websocket` (default)** | Mic and assistant PCM use **binary WebSocket** frames on the same connection as JSON control (or local `ClientTransport` when the server does not own the socket). |
| **`direct_rtc`** | **Split plane:** JSON control (and RTC signaling) stay on the **WebSocket** via **`SessionClientSender.sendJson`**; optional **Opus RTP** for mic/assistant audio when `rtcAudio: 'werift_opus'` is enabled. That profile loads the shipped engine, an internal module of the package and the only code that loads `werift` and `@evan/opus`, on the first `rtc.offer`, with no configuration change; a load failure is sent to the client as one `rtc.error` frame. The root `bodhi-realtime-agent` entry has no native dependencies. |

**Important:** `direct_rtc` does **not** replace **`VoiceSession`** or **`LLMTransport`**. Gemini/OpenAI still use their **existing** provider WebSockets from the server. Only the **device ↔ your app server ↔ `VoiceSession` input/output** audio encoding changes when you opt into direct RTC.

### Local `ClientTransport` connections

When your server does not own the socket, the local `ClientTransport` accepts
the WebSocket itself and holds one connection at a time. A second real client is
closed with `4409` `client-busy`. A `?probe=1` connection receives one
`probeState` frame (when that option is configured), then closes with `1000`
and never attaches. A `?verify=1` connection attaches as a verifier that never
counts as the client and is preempted with `4411` when a real client arrives. A
`?takeover=1` connection closes the attached real client with `4410` and takes
its place. Outbound frames go to whichever connection holds the slot, including
a verifier. See
[Local client connection roles](/guide/voice-session#local-client-connection-roles).

### Playback-state support

The playback gate needs one ordered path for assistant audio and JSON. It is
supported on WebSocket PCM surfaces that render audio through the buffered client
playback path. It is not supported when assistant audio is delivered over
`direct_rtc` Opus RTP, because the audio and `audio.done` JSON frame no longer
share ordering.

For server-owned sockets, expose this capability with
`SessionClientSender.supportsPlaybackStateProtocol` and implement
`sendJsonAfterAudio`. See [Playback Gate](/guide/playback-gate).

### Custom frames from your app

`VoiceSession.sendJsonToClient`, `ToolContext.sendJsonToClient` and
`ClientTransport.sendJsonToClient` send a JSON text frame to the connected
client. Besides the core frames and any frames registered on
`ClientProtocolServerExtensions`, they accept an **application frame**: any JSON
object whose `type`, if it has one, is **not** a core frame type. The frame is
serialized verbatim. Pass the object literal directly; no frame type needs to
be imported.

```ts
session.sendJsonToClient({ type: 'session_end' });           // app frame
session.sendJsonToClient({ type: 'agent.state', seq: 1 });   // app frame
context.sendJsonToClient?.({ type: 'tool.progress', percent: 50 }); // inside a tool

session.sendJsonToClient({ type: 'audio.done', playbackId: 7 }); // core frame, well-formed
// session.sendJsonToClient({ type: 'audio.done' });          // compile error: missing playbackId
// session.sendJsonToClient({ type: 'turn.end', turnId: 5 }); // compile error: turnId is a string
```

The rule: a frame that reuses a core `type` must match that core frame's shape,
so a misspelled or incomplete core frame still fails to compile. Pick your own
`type` names for application frames (a prefix such as `app.` avoids future
collisions). The lower-level `IClientChannel.sendJsonToClient` and
`SessionClientSender.sendJson` contracts stay strict: a server-owned sender
still receives only core and registered frames in its type, while application
frames reach it at runtime unchanged.

See also:

- [VoiceSession](/guide/voice-session) — `clientMedia`, `clientSender`, and session wiring
- [Playback Gate](/guide/playback-gate) — `audio.done` / `playback.ended` turn-completion gating
- [Architecture overview](/guide/architecture) — two independent realtime links (client leg vs vendor leg)
