# Voice Agent — Direct RTC

End-to-end voice agent: **Gemini Live** for conversation, **Opus WebRTC** for mic + assistant audio (no LiveKit, no SFU). Transcripts and control messages stay on the same WebSocket as every other Bodhi example.

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY`

## Run

```bash
export GEMINI_API_KEY="your-key"
pnpm demo:direct-rtc
```

Open **http://127.0.0.1:8788/** → click **Connect** → allow microphone → talk. You should hear the agent greet you and respond.

## Optional env

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` | Gemini Live model |
| `DIRECT_RTC_DEMO_TEXT_MODEL` | `gemini-2.5-flash` | Text model (session router) |
| `GEMINI_VOICE` | `Puck` | Gemini speech voice |
| `DIRECT_RTC_DEMO_PORT` | `8788` | HTTP + WebSocket port |
| `DIRECT_RTC_STUN` | `stun:stun.l.google.com:19302` | STUN server |

## Architecture

```
Browser                          Server
┌──────────┐  Opus RTP (WebRTC)  ┌──────────────┐  WebSocket  ┌───────────┐
│ mic/spkr ├─────────────────────┤ VoiceSession ├────────────┤ Gemini    │
└──────────┘                     │ (werift +    │            │ Live API  │
    ▲                            │  @evan/opus) │            └───────────┘
    │  JSON (WebSocket)          └──────┬───────┘
    └───────────────────────────────────┘
        transcripts, session.config, turn signals
```

Audio path: `getUserMedia` → browser Opus encode → RTP → werift decode → PCM 16 kHz → Gemini Live. Return path: Gemini 24 kHz PCM → Opus encode → RTP → browser decode → speakers.

## Layout

| Path | Role |
|------|------|
| `server.ts` | HTTP, WebSocket, VoiceSession + Gemini Live |
| `public/index.html` | Browser client: RTC audio + transcript UI |
