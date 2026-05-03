# Direct RTC + Gemini Live (end-to-end voice)

Minimal **voice companion** over **WebSocket control + Opus RTP** (`clientMedia: { kind: 'direct_rtc', rtcAudio: 'werift_opus' }`). One `MainAgent`, **no tools, no subagents**. Uses **Gemini Live** for real speech in/out.

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- Optional: `GEMINI_LIVE_MODEL` (default `gemini-2.5-flash-native-audio-preview-12-2025`), `GEMINI_VOICE`, `DIRECT_RTC_DEMO_TEXT_MODEL` (Vercel AI model for the session router; default `gemini-2.5-flash`), `DIRECT_RTC_STUN`, `DIRECT_RTC_DEMO_PORT`

## Run

```bash
export GEMINI_API_KEY="your-key"
pnpm demo:direct-rtc
```

Open **http://127.0.0.1:8788/** → allow microphone → **Connect WebSocket** → **Start WebRTC** → talk. You should hear a short greeting, then a normal voice back-and-forth.

If you see transcripts but **no sound**: the browser must negotiate **`sendrecv`** on the audio m-line (the page sets `transceiver.direction = 'sendrecv'` before the offer). If the server’s answer still shows only `recvonly`, check the browser console and try headphones to rule out echo cancellation muting the remote track.

## Layout

| Path | Role |
|------|------|
| `server.ts` | HTTP + WebSocket, `VoiceSession` + Gemini |
| `public/index.html` | Browser: mic + `RTCPeerConnection`, play remote assistant track |
