# Deepgram Streaming STT Demo

This demo runs Gemini Live as the realtime voice transport and uses Deepgram Nova-3 live streaming as the external `STTProvider`.

## What It Shows

- Gemini Live still receives user audio and produces native audio responses.
- Deepgram receives the same PCM audio stream for low-latency partial and final user transcripts.
- Gemini built-in input transcription is disabled in this demo so transcript output clearly comes from Deepgram.
- Existing tools, agent transfer, Google Search grounding, image generation, hooks, and session shutdown behavior stay the same as `gemini-realtime-tools.ts`.

## Requirements

- `GEMINI_API_KEY`
- `DEEPGRAM_API_KEY`
- Node.js 22+
- Installed dependencies with `pnpm install`

If `DEEPGRAM_API_KEY` is in `~/.zshrc`, source it before running:

```bash
source ~/.zshrc
```

## Run

From the repository root:

```bash
source ~/.zshrc
pnpm tsx examples/gemini-deepgram-streaming-stt.ts
```

In another terminal, run the browser client:

```bash
pnpm tsx examples/web-client.ts
```

Open `http://localhost:8080`, connect, and speak into the mic.

## Things To Try

| Say this | What happens |
|----------|--------------|
| "What time is it?" | Calls the time tool |
| "What is 25 times 17?" | Calls the calculator tool |
| "I need help with harder math" | Transfers to the math expert agent |
| "What is the weather today?" | Uses Gemini Google Search grounding |
| "Speak slower please" | Applies the speech speed directive |
| "Draw me a sunset" | Generates an image and sends it to the client |
| "Goodbye" | Ends the session gracefully |

## Audio And STT Flow

The client sends PCM 16-bit 16 kHz mono audio to the Bodhi WebSocket server. `VoiceSession` forwards that audio to Gemini Live and also calls `DeepgramSTTProvider.feedAudio()`.

`DeepgramSTTProvider` sends raw binary `linear16` audio to:

```text
wss://api.deepgram.com/v1/listen?model=nova-3
```

Partial Deepgram `Results` messages become partial user transcripts. Final Deepgram `Results` messages become final user transcripts and are committed into the session's conversation context at turn boundaries.

## Notes

- The demo uses Deepgram Nova-3 live transcription, not Flux.
- Flux is better treated as future turn-detection work because it can emit turn events, while this demo keeps Gemini Live in charge of the conversation turn lifecycle.
- KeepAlive messages are sent to Deepgram during silence so the streaming connection stays open.

