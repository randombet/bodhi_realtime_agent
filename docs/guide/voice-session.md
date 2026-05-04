# VoiceSession

`VoiceSession` is the top-level runtime integration point.

**How this fits the two network legs** (browser or device vs cloud model):

```text
[Browser or device] ─── Leg 1 ───> [App server / VoiceSession] ─── Leg 2 ───> [Gemini or OpenAI]
```

- **Leg 1:** `IClientChannel` / `clientSender` / `clientMedia` — your app’s WebSocket (and optional WebRTC) to the user.
- **Leg 2:** `LLMTransport` — the server’s separate realtime session to the vendor. Independent of Leg 1’s encoding.

It manages:

- live transport connection
- agent/tool orchestration
- turn lifecycle
- subagent execution handoff
- optional memory/history/artifact integration

## Client connection modes

`VoiceSession` supports two ways to attach an end-user client:

1. **Local `ClientTransport` (default in simple examples)** — the framework listens on a TCP port; the client connects as the only peer.
2. **Server-owned WebSocket (`clientSender`)** — your app server holds the WebSocket and forwards **binary** and **JSON** into `feedAudioFromClient` / `feedJsonFromClient`, and calls `notifyClientConnected` / `notifyClientDisconnected` when the socket opens or closes.

When you use **`clientSender`**, you must also choose how **media** is carried:

- **`clientMedia: { kind: 'websocket' }`** (default) — PCM mic up and assistant PCM down on the **same WebSocket** as JSON (binary frames).
- **`clientMedia: { kind: 'direct_rtc', rtcAudio?: 'none' | 'werift_opus', … }`** — JSON (including `session.config`, transcripts, and **`rtc.offer` / `rtc.answer` / `rtc.ice_candidate`**) stays on the WebSocket; with **`rtcAudio: 'werift_opus'`**, mic and assistant audio use **Opus RTP** on a WebRTC peer connection owned inside the framework channel. This does **not** replace the **`LLMTransport`** socket to Gemini/OpenAI.

`direct_rtc` **requires** `clientSender` (the factory throws if it is missing).

## Typical setup (local `ClientTransport`)

```ts
const session = new VoiceSession({
  sessionId: 'session_1',
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!,
  agents: [mainAgent],
  initialAgent: 'main',
  model: google('gemini-2.5-flash'),
  port: 9900,
  orchestrationMode: 'actor',
});
```

## Typical setup (app server owns the WebSocket, PCM on socket)

```ts
const session = new VoiceSession({
  sessionId: 'session_1',
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!,
  agents: [mainAgent],
  initialAgent: 'main',
  model: google('gemini-2.5-flash'),
  clientSender: mySender, // implements SessionClientSender
  // clientMedia defaults to { kind: 'websocket' }
});
```

## Typical setup (app server owns the WebSocket, Opus RTP for audio)

```ts
const session = new VoiceSession({
  sessionId: 'session_1',
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!,
  agents: [mainAgent],
  initialAgent: 'main',
  model: google('gemini-2.5-flash'),
  clientSender: mySender,
  clientMedia: {
    kind: 'direct_rtc',
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    rtcAudio: 'werift_opus',
  },
});
```

The framework wires PCM rates and inbound PCM delivery when `rtcAudio === 'werift_opus'`; your server still implements **`clientSender`** and relays JSON frames unchanged.

## Related

- [Agents](/guide/agents)
- [Tools](/guide/tools)
- [Transport](/guide/transport) — **LLM transport** vs **client media** profiles
