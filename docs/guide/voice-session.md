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

## External TTS

`VoiceSession` can run with a pluggable `ttsProvider` in actor mode. When present, the realtime transport is configured for text responses (`responseModality: 'text'`), and `VoiceSession` forwards model text deltas into the provider. The provider returns PCM chunks through `onAudio`; `VoiceSession` resamples them to the client output rate when needed and delays turn-complete notifications until TTS audio is done.

Framework providers:

- `CartesiaTTSProvider`
- `ElevenLabsTTSProvider`
- `HumeTTSProvider`

Use native realtime-model audio by omitting `ttsProvider`.

### App-Level Selection

The framework accepts a `ttsProvider` instance; the app layer turns saved agent/UI choices into that instance.

In the Bodhi app:

- `/talk` shows one **Speech output** dropdown. **Use selected agent's saved speech output** sends no override; native Gemini/OpenAI voice choices send `ttsProvider=native` plus `geminiRealtimeVoice` or `openaiRealtimeVoice`; external TTS presets send generic `ttsProvider` query params; custom choices reveal provider-specific IDs.
- Agent Studio uses the same **Speech output** dropdown. Native choices persist as `geminiVoiceName` or `openaiVoice` with `ttsConfig.provider = "native"`; external choices persist as saved-agent `ttsConfig`.
- Signed-in users can store provider keys through the existing BYOK key table/API. Server environment keys are fallback credentials only.
- `BODHI_TTS_EMERGENCY_OVERRIDE` is the only env behavior override, and it is reserved for operator intervention.

The normal resolver order is emergency override, explicit query override, then saved `ttsConfig`; otherwise native realtime-model audio is used.

### Cartesia Presets

The app’s curated Cartesia choices use `sonic-3.5` by default. Cartesia documents Sonic 3.5 as its current streaming TTS model and recommends stable, realistic voices for voice agents, including Katie and Jameson. The app exposes those as named choices so users do not start from raw voice IDs.

Custom Cartesia setup is still available for advanced users and exposes:

- `sonic-3.5` for stable current behavior.
- `sonic-3.5-2026-05-04` for pinned behavior.
- `sonic-latest` for beta testing.
- `sonic-3` and `sonic-3-2026-01-12` for flows that need speed/emotion controls.

Speed and emotion fields are intentionally advanced/custom controls; curated presets keep the choice to one dropdown.

### ElevenLabs And Hume Presets

ElevenLabs custom setup mirrors the Cartesia pattern: users still can enter a custom voice ID, but model and language are dropdown choices. Current model choices are `eleven_flash_v2_5` for realtime agent use, `eleven_flash_v2`, `eleven_multilingual_v2` for high-fidelity multilingual output, and `eleven_v3` for expressive creative output. The curated ElevenLabs choices include Rachel, Alita, and George so normal users do not start from an empty voice-ID box.

Hume custom setup exposes voice name, voice ID, `HUME_AI` vs `CUSTOM_VOICE`, Octave version, speed, and acting instructions. Curated Hume choices include Ava Song on Octave 1, Ava Song on Octave 2 preview, and a prompt-guided warm assistant style. Raw Hume IDs are reserved for users who selected or created a specific Hume voice.

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
