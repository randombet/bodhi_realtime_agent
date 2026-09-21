# Playback Gate

The playback gate keeps a voice turn open until the user's device has finished
playing the assistant's audio. This matters because model audio and external TTS
often generate faster than realtime: the server can finish sending audio while
the browser is still playing buffered speech.

Without the gate, a user who starts speaking over that buffered tail can be
treated as starting a new turn while stale assistant audio continues to play. With
the gate, `VoiceSession` keeps the current turn interruptible until playback
actually ends, then completes it cleanly.

## How it works

The framework uses a small playback-state handshake:

1. `VoiceSession` sends all binary audio frames for the turn.
2. `VoiceSession` sends JSON after the final audio frame:

```json
{ "type": "audio.done", "playbackId": 7 }
```

3. The client waits until it has received `audio.done` and its audio output
   buffer has drained.
4. The client sends:

```json
{ "type": "playback.ended", "playbackId": 7 }
```

5. `VoiceSession` completes the turn, unless a client-audio VAD segment is
   currently resolving as a possible barge-in.

`playbackId` is an opaque per-session token. Echo it back unchanged. Do not treat
it as globally unique, and discard any outstanding id when the connection closes.

If `playback.ended` is never received, the server falls back to an internal
playback estimate plus a safety margin, so the protocol is safe to skip on
surfaces that cannot report playback completion.

## Enable it

For a local example that uses the built-in `ClientTransport`, opt in on the
session:

```ts
const session = new VoiceSession({
  // ...
  playbackStateProtocol: 'audio_done',
});
```

For a server-owned WebSocket, the app's sender must preserve audio/JSON ordering
and declare that it can participate:

```ts
const sender = {
  supportsPlaybackStateProtocol: true,
  sendAudio(chunk: Buffer) {
    ws.send(chunk);
  },
  sendJson(message: Record<string, unknown>) {
    ws.send(JSON.stringify(message));
  },
  sendJsonAfterAudio(message: Record<string, unknown>) {
    ws.send(JSON.stringify(message));
  },
};

const session = new VoiceSession({
  // ...
  clientSender: sender,
  playbackStateProtocol: 'audio_done',
});
```

Only set `supportsPlaybackStateProtocol: true` when the client renders assistant
audio through the same ordered, buffered PCM path that receives `audio.done`.
Ordering is the key guarantee: `audio.done` must not overtake the final audio
bytes for the turn.

## Client behavior

A participating client should:

- track the latest `audio.done.playbackId`;
- send one `playback.ended` for that id after all active audio sources finish;
- add a short settle delay after the Web Audio graph drains, covering hardware
  output latency and the next mic capture quantum;
- clear pending playback ids on `turn.end`, `turn.interrupted`, disconnect, or a
  new `session.config`;
- ignore unknown JSON message types for forward compatibility.

The first-party web client implements this in its buffered PCM playback path.

## Supported surfaces

| Surface | Playback gate support |
| --- | --- |
| Built-in `ClientTransport` over WebSocket PCM | Supported when `playbackStateProtocol: 'audio_done'` is set. |
| Server-owned WebSocket PCM via `clientSender` | Supported when the sender implements `sendJsonAfterAudio` and sets `supportsPlaybackStateProtocol: true`. |
| `direct_rtc` with `rtcAudio: 'none'` | Supported because assistant audio still renders over ordered WebSocket PCM. |
| `direct_rtc` with `rtcAudio: 'werift_opus'` | Not supported; audio and JSON use different paths, so `audio.done` ordering cannot be guaranteed. |
| Twilio, mobile, Spatial Avatar, or custom sinks that cannot report playback completion | Leave disabled; the server uses its fallback timing. |

## TTS and native audio

External TTS uses the playback gate after the TTS provider reports synthesis done.
The turn does not complete immediately; it completes when the client reports that
audio playback ended, or when the fallback timer fires.

Native model audio depends on the provider. Gemini Live's native turn-complete
signal is already playback-gated by the provider (its transport reports
`playbackGatedTurnComplete: true`), so the gate stays off for it and no extra
configuration is needed. OpenAI Realtime over WebSocket finishes a response when
audio *generation* has completed, while the client still owns playback; set
`nativePlaybackGating: true` (alongside `playbackStateProtocol: 'audio_done'`) to
route its native turns through the same `audio.done` / `playback.ended` contract.

## Barge-in behavior

While the playback gate is pending, user speech is treated as barge-in. A valid
barge-in finalizes the current turn as interrupted and clears the pending
playback id so late `playback.ended` messages are ignored.

The server also defers clean completion if the client playback signal arrives
while a short client-audio VAD segment is still being classified. If the segment
turns into real speech, the turn is interrupted; if it resolves as silence, the
turn completes cleanly.

## Related

- [VoiceSession](/guide/voice-session)
- [Transport](/guide/transport)
- [Hosted voice API playback-state protocol](/service/hosted-voice-api#44-playback-state-protocol-optional)
