# Design: Gemini Demo with Deepgram Nova-3 Live STT

**Date:** 2026-04-27  
**Status:** Design only, not implemented  
**Reference example:** `examples/gemini-realtime-tools.ts`

## Goal

Create a new Gemini Live demo based on `examples/gemini-realtime-tools.ts` that keeps the existing agent, tool, hook, and audio-session behavior, but replaces `GeminiBatchSTTProvider` with a new Deepgram Nova-3 live streaming `STTProvider`.

The demo should prove that Bodhi can use an external low-latency streaming transcription provider while Gemini Live remains the realtime LLM/audio transport.

Use Deepgram **Nova-3 live transcription** over `/v1/listen` for the first implementation. Flux is explicitly out of scope for this demo because it is a turn-detection product, not just a transcript provider.

## Non-Goals

- Do not replace Gemini Live turn detection or audio generation.
- Do not introduce an orchestration/runtime pattern.
- Do not move existing examples or change their behavior.
- Do not read `~/.zshrc` from application code. The demo should read `process.env.DEEPGRAM_API_KEY`; users can source/export it before running.
- Do not add the Deepgram SDK unless it provides a clear benefit over the existing `ws` dependency.

## Deepgram Docs Findings

Deepgram has two relevant streaming STT products:

1. **Nova-3 live transcription** over `wss://api.deepgram.com/v1/listen`.
   - Auth uses `Authorization: Token <API_KEY>` or bearer token headers.
   - Raw audio is sent as binary WebSocket frames.
   - Raw PCM needs `encoding=linear16`, `sample_rate`, and `channels`.
   - `interim_results=true` emits evolving partial transcripts.
   - `endpointing=<ms>` finalizes transcripts after speech pauses and marks results with `speech_final`.
   - `Finalize`, `CloseStream`, and `KeepAlive` are JSON control messages.
   - `KeepAlive` must be sent as a text frame every 3-5 seconds during silence to avoid the 10-second timeout.

2. **Flux turn-based voice-agent STT** over `wss://api.deepgram.com/v2/listen`.
   - Uses models such as `flux-general-en` and emits turn-level events like `EndOfTurn`.
   - This is attractive for a future mode where Deepgram owns user turn detection.
   - It does not map cleanly to the current `STTProvider` role, because Bodhi currently lets the realtime LLM transport own turn detection and calls `STTProvider.commit(turnId)` at model-turn boundaries.

Recommendation: use **Nova-3 live transcription** for this demo. It maps directly to `STTProvider` without changing `VoiceSession`.

## Proposed Files

- `src/transport/deepgram-stt-provider.ts`
- `test/transport/deepgram-stt-provider.test.ts`
- `examples/gemini-deepgram-streaming-stt.ts`
- `src/transport/index.ts` export updates
- Optional later docs update under `docs/guide/transport.md`

## Execution Steps

Implementation should be done in small, reviewable steps. No single step should modify more than three files.

1. **Add provider test scaffold**
   - Create `test/transport/deepgram-stt-provider.test.ts`.
   - Mock `ws` using the same style as `test/transport/elevenlabs-stt-provider.test.ts`.
   - Add tests for constructor validation, `configure()`, connection URL params, and auth headers.
   - Expected files changed: `test/transport/deepgram-stt-provider.test.ts`.

2. **Add provider skeleton**
   - Create `src/transport/deepgram-stt-provider.ts`.
   - Add `DeepgramSTTConfig`, constructor defaults, `configure()`, `start()`, and `stop()`.
   - Connect to `wss://api.deepgram.com/v1/listen` with `model=nova-3`, `encoding=linear16`, `sample_rate`, `channels=1`, and `interim_results=true`.
   - Resolve `start()` on WebSocket `open`.
   - Expected files changed: `src/transport/deepgram-stt-provider.ts`, `test/transport/deepgram-stt-provider.test.ts`.

3. **Implement audio and control messages**
   - Make `feedAudio(base64Pcm)` decode base64 and send binary PCM.
   - Make `commit(turnId)` store the pending turn id and send `{ "type": "Finalize" }` as text JSON.
   - Make `stop()` send `{ "type": "CloseStream" }` before closing when the socket is open.
   - Add a 3-second text-frame keepalive with `{ "type": "KeepAlive" }`.
   - Expected files changed: provider and provider test only.

4. **Implement Deepgram result mapping**
   - Parse `Results` messages from Nova-3 live.
   - Map `is_final === false` to `onPartialTranscript(text)`.
   - Map `is_final === true` to `onTranscript(text, turnId)`.
   - Use a queued turn id from `commit(turnId)` when present; otherwise pass `undefined`.
   - Ignore empty transcripts and malformed JSON.
   - Log `Metadata`, `UtteranceEnd`, and `SpeechStarted` without changing turn ownership.
   - Expected files changed: provider and provider test only.

5. **Implement reconnect buffering**
   - Add `idle`, `connecting`, `connected`, `reconnecting`, and `stopped` states.
   - Buffer about two seconds of base64 audio while reconnecting.
   - Use exponential backoff from 1s to 10s.
   - Drop oldest buffered audio when the reconnect buffer is full.
   - Stop reconnect timers cleanly in `stop()`.
   - Expected files changed: provider and provider test only.

6. **Export the provider**
   - Export `DeepgramSTTProvider` and `DeepgramSTTConfig` from `src/transport/index.ts`.
   - Confirm package barrel exports expose it through `src/index.ts`.
   - Expected files changed: `src/transport/index.ts`.

7. **Add the Gemini Nova-3 live STT demo**
   - Create `examples/gemini-deepgram-streaming-stt.ts` from `examples/gemini-realtime-tools.ts`.
   - Import `DeepgramSTTProvider` instead of `GeminiBatchSTTProvider`.
   - Require `DEEPGRAM_API_KEY` from `process.env`.
   - Configure `DeepgramSTTProvider` with `model: 'nova-3'`.
   - Set `inputAudioTranscription: false` so the visible transcript path is clearly Deepgram.
   - Keep all Gemini Live tools, agents, hooks, and speech config unchanged.
   - Expected files changed: `examples/gemini-deepgram-streaming-stt.ts`.

8. **Add user-facing docs only after the demo works**
   - Update `docs/guide/transport.md` with a short Deepgram STT example.
   - Mention that Deepgram receives the transport input PCM format through `configure()`.
   - Mention that the Gemini demo disables built-in input transcription for clearer validation.
   - Expected files changed: `docs/guide/transport.md`.

9. **Run focused verification**
   - Run `pnpm test -- test/transport/deepgram-stt-provider.test.ts`.
   - Run `pnpm typecheck`.
   - Run `pnpm lint`.
   - For manual validation, run:

```bash
source ~/.zshrc
pnpm tsx examples/gemini-deepgram-streaming-stt.ts
```

10. **Manual demo checklist**
    - Connect the existing WebSocket audio client.
    - Confirm partial user transcripts appear during speech.
    - Confirm final user transcripts appear at turn boundaries.
    - Ask "What time is it?" and confirm tool execution is unchanged.
    - Ask for a math transfer and confirm transcript streaming continues after agent transfer.
    - Stop with Ctrl+C and confirm both Gemini and Deepgram sockets close cleanly.

## Demo Shape

Create `examples/gemini-deepgram-streaming-stt.ts` as a close copy of `examples/gemini-realtime-tools.ts`.

Keep:

- `VoiceSession`
- Gemini Live native audio
- `geminiModel`
- existing calculator/time/search/image tools
- math expert transfer
- `speechConfig`
- event logging and hooks

Change:

```typescript
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? '';
if (DEEPGRAM_API_KEY.length === 0) {
  console.error('Error: DEEPGRAM_API_KEY environment variable is required');
  process.exit(1);
}
```

Replace:

```typescript
sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-3-flash-preview' }),
```

With:

```typescript
sttProvider: new DeepgramSTTProvider({
  apiKey: DEEPGRAM_API_KEY,
  model: 'nova-3',
  language: 'en-US',
  endpointingMs: 300,
  utteranceEndMs: 1000,
  punctuate: true,
  smartFormat: true,
}),
inputAudioTranscription: false,
```

Set `inputAudioTranscription: false` in the demo so the transcript visible in logs and clients clearly comes from Deepgram, not Gemini's built-in post-hoc correction path. Production examples can omit this if they want Gemini correction layered on top of Deepgram.

Run command:

```bash
source ~/.zshrc
pnpm tsx examples/gemini-deepgram-streaming-stt.ts
```

## Provider Design

`DeepgramSTTProvider` should implement the existing `STTProvider` interface.

Configuration:

```typescript
export interface DeepgramSTTConfig {
  apiKey: string;
  model?: string; // default: 'nova-3'
  language?: string; // default: 'en-US'
  endpointingMs?: number | false; // default: 300
  utteranceEndMs?: number; // default: 1000
  punctuate?: boolean; // default: true
  smartFormat?: boolean; // default: true
  keyterms?: string[];
}
```

Connection URL:

```text
wss://api.deepgram.com/v1/listen
  ?model=nova-3
  &encoding=linear16
  &sample_rate=<VoiceSession transport input sample rate>
  &channels=1
  &interim_results=true
  &punctuate=true
  &smart_format=true
  &endpointing=300
  &utterance_end_ms=1000
  &vad_events=true
```

For the Gemini demo, `VoiceSession` will call `configure()` with Gemini Live input audio: 16-bit, mono, 16 kHz PCM. The provider should still accept 24 kHz so it also works with `OpenAIRealtimeTransport` later.

Lifecycle:

- `configure(audio)` validates `bitDepth === 16`, `channels === 1`, stores `sampleRate`.
- `start()` opens a `ws` connection and resolves on WebSocket `open`.
- `feedAudio(base64Pcm)` decodes base64 to `Buffer` and sends binary audio.
- `commit(turnId)` records the turn id and sends `{ "type": "Finalize" }` as a text frame.
- `handleInterrupted()` is a no-op for the first version.
- `handleTurnComplete()` clears transient commit bookkeeping but keeps the WebSocket open.
- `stop()` sends `{ "type": "CloseStream" }`, closes the socket, stops keepalive, and clears reconnect buffers.

Keepalive:

- Start a timer after `open`.
- Send `JSON.stringify({ type: 'KeepAlive' })` every 3 seconds when the socket is open.
- Always send keepalive as a text WebSocket frame, not binary.

Reconnection:

- Match the existing `ElevenLabsSTTProvider` pattern.
- States: `idle`, `connecting`, `connected`, `reconnecting`, `stopped`.
- Buffer at most about two seconds of audio while reconnecting.
- Use exponential backoff from 1s to 10s.
- Drop oldest buffered audio when the reconnect buffer is full.

## Message Mapping

Deepgram `Results` messages contain the transcript at:

```typescript
msg.channel.alternatives[0].transcript
```

Mapping:

- Empty transcript: ignore.
- `is_final === false`: call `onPartialTranscript(text)`.
- `is_final === true`: call `onTranscript(text, turnId)`.
- Prefer a pending `turnId` from the most recent `commit(turnId)` when the final result is caused by `Finalize`.
- If Deepgram finalizes before `commit()`, call `onTranscript(text, undefined)`. `VoiceSession` already accepts undefined turn ids for streaming provider auto-commits.
- `UtteranceEnd` and `SpeechStarted`: log at debug level only in the first version.
- `Metadata`: log request id/model info.
- Error messages or WebSocket errors: log and reconnect if not stopped.

Do not concatenate final transcripts inside the provider. Deepgram final results represent finalized audio ranges, and `TranscriptManager.handleInput()` already accumulates final input text for the current turn.

## Why Not Flux First?

Deepgram's Flux path is purpose-built for voice agents and provides end-of-turn events with tunable thresholds. That is useful, but it would be a larger framework change because Bodhi's current turn lifecycle is driven by the realtime LLM transport:

- Gemini Live detects model turns and interruptions.
- `VoiceSession` calls `sttProvider.commit(turnId)` when the model starts responding.
- `TranscriptManager` uses STT output for display and conversation context, not for deciding when Gemini should respond.

Flux should be considered later as a separate design: `TurnDetectionProvider` or an expanded `STTProvider` that can publish turn-start/turn-end signals. That should not be mixed into this demo.

## Expected Behavior

When running the new demo:

- User audio still streams to Gemini Live immediately.
- The same audio also streams to Deepgram.
- The client receives partial user transcript updates during speech.
- Final user transcripts are committed to `ConversationContext` at turn end.
- Gemini answers with native audio as before.
- Tool calls, agent transfers, image generation, and session shutdown behave like `examples/gemini-realtime-tools.ts`.

## Risks

- Deepgram final transcripts can arrive before Bodhi's `commit(turnId)`, so some final transcripts may have `turnId === undefined`. This is acceptable for streaming providers, but tests should cover it.
- `Finalize` is not guaranteed to return a final result if there is not enough buffered audio. The provider must not hang waiting for a finalize response.
- If Gemini built-in input transcription remains enabled, it may correct or replace Deepgram text, making the demo hard to validate. The demo should disable it.
- Deepgram `utterance_end_ms` is simple gap detection and is not the same as semantic turn completion. It should not control Gemini response timing in this demo.
- KeepAlive sent as binary can be mishandled by Deepgram, so tests should assert it is sent as JSON text.

## Test Plan

Unit tests for `DeepgramSTTProvider`:

- Constructor rejects an empty API key.
- `configure()` accepts 16 kHz and 24 kHz mono PCM16.
- `configure()` rejects non-16-bit audio and stereo audio.
- `start()` opens `wss://api.deepgram.com/v1/listen` with the expected query params and `Authorization: Token <key>`.
- `feedAudio()` sends decoded binary audio, not base64 JSON.
- `commit(turnId)` sends `{ "type": "Finalize" }`.
- `stop()` sends `{ "type": "CloseStream" }` and clears timers/buffers.
- Non-final `Results` calls `onPartialTranscript`.
- Final `Results` calls `onTranscript`.
- Final results before `commit()` use `turnId === undefined`.
- Final results after `commit(7)` use turn id `7`.
- Malformed JSON is ignored without throwing.
- WebSocket close schedules reconnect and buffers audio while reconnecting.
- KeepAlive sends text JSON every 3 seconds and stops after `stop()`.

Manual demo validation:

1. `source ~/.zshrc`
2. `pnpm tsx examples/gemini-deepgram-streaming-stt.ts`
3. Connect the existing WebSocket audio client.
4. Speak a short sentence and confirm partial transcript updates appear before Gemini finishes responding.
5. Ask for a calculator result and confirm tool behavior is unchanged.
6. Transfer to the math expert and confirm Deepgram transcript continues across agent transfer.
