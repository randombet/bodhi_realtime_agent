# Cartesia TTS Voice Demo

A voice assistant that uses **Cartesia Sonic** for speech synthesis instead of Gemini's native audio output. Demonstrates the framework's pluggable `TTSProvider` interface with custom voice, speed, and emotion controls.

## How It Works

```
User (mic) → WebSocket → Gemini Live API (text output) → Cartesia Sonic (TTS) → WebSocket → User (speaker)
```

1. The Gemini Live API runs with `responseModalities: ['AUDIO', 'TEXT']` (or AUDIO-only for native-audio models, using output transcription as the text source).
2. The framework intercepts the text stream and routes it to the Cartesia TTS provider.
3. Cartesia synthesizes speech via its WebSocket streaming API and returns PCM audio chunks.
4. Audio is sent to the client in real-time with word-boundary events for caption sync.
5. Gemini's own audio output is silently discarded — only Cartesia's voice is heard.

## Prerequisites

- Node.js 22+
- A [Google AI Studio](https://aistudio.google.com/) API key (Gemini)
- A [Cartesia](https://cartesia.ai/) API key
- pnpm

## Quick Start

### Standalone example (`examples/cartesia-tts-demo.ts`)

```bash
# 1. Set environment variables
export GEMINI_API_KEY=your_gemini_key
export CARTESIA_API_KEY=your_cartesia_key

# 2. Start the voice backend
pnpm tsx examples/cartesia-tts-demo.ts

# 3. In another terminal, start the web client
pnpm web-client:dev

# 4. Open http://localhost:8080 in Chrome and click Connect
```

### Production Bodhi app (`pnpm start`)

The same Cartesia pipeline is wired into `createBodhiSessionConfig()` when `CARTESIA_TTS_ENABLED=true` and `CARTESIA_API_KEY` are set in `.env`. Without `CARTESIA_TTS_ENABLED=true`, the production server uses native Gemini audio even if the key is present. Use `pnpm start` and `pnpm web-client:dev`; optional voice/speed/emotion overrides are available in the Talk page under **Output voice (Cartesia)** (query params: `cartesiaVoiceId`, `cartesiaSpeed`, `cartesiaEmotion`). Not used when `LLM_PROVIDER=openai` (OpenAI Realtime supplies its own audio).

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes | — | Google AI Studio API key |
| `CARTESIA_TTS_ENABLED` | For Bodhi app | *(unset)* | Set `true` on the production server to use Cartesia; otherwise native Gemini audio |
| `CARTESIA_API_KEY` | Yes (demo / when enabled) | — | Cartesia API key |
| `CARTESIA_VOICE_ID` | No | `a0e99841-...` (Barbershop Man) | Cartesia voice ID |
| `CARTESIA_SPEED` | No | `normal` | `slowest` / `slow` / `normal` / `fast` / `fastest` |
| `CARTESIA_EMOTION` | No | *(none)* | Comma-separated emotions, e.g. `cheerful,friendly` |
| `GEMINI_LIVE_MODEL` | No | `gemini-2.5-flash-native-audio-preview-12-2025` | Gemini Live model for bidiGenerateContent |
| `PORT` | No | `9900` | WebSocket server port |
| `HOST` | No | `0.0.0.0` | Bind address |

## Voice Customization

### Changing the Voice

Browse voices at [play.cartesia.ai](https://play.cartesia.ai/), copy the voice ID, and set:

```bash
export CARTESIA_VOICE_ID=your_voice_id
```

### Speed Control

```bash
export CARTESIA_SPEED=fast    # slowest / slow / normal / fast / fastest
```

### Emotion Tags

Cartesia's experimental emotion controls add emotional inflection to the voice:

```bash
export CARTESIA_EMOTION=cheerful,friendly
```

## Available Tools

The demo agent ("Bodhi") comes with three inline tools:

| Tool | Description |
|---|---|
| `calculate` | Evaluates math expressions (sqrt, sin, cos, log, pow, etc.) |
| `get_current_time` | Returns the current date/time with optional timezone |
| `end_session` | Gracefully ends the voice session |

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────────────────────────────┐
│  Browser /   │◄──────────────────►│  VoiceSession (actor mode)               │
│  web-client  │   audio + JSON     │                                          │
└─────────────┘                     │  ┌──────────────┐  ┌──────────────────┐  │
                                    │  │ Gemini Live   │  │ CartesiaTTS      │  │
                                    │  │ Transport     │  │ Provider         │  │
                                    │  │               │  │                  │  │
                                    │  │ text output ──┼──► synthesize()     │  │
                                    │  │ (audio muted) │  │ onAudio() ───────┼──► client
                                    │  └──────┬───────┘  └──────────────────┘  │
                                    │         │ WebSocket                       │
                                    │         ▼                                │
                                    │  Gemini Live API                         │
                                    └──────────────────────────────────────────┘
```

Key components:
- **VoiceSession** in `actor` orchestration mode — enables the pluggable TTS pipeline
- **CartesiaTTSProvider** — streams text to Cartesia via WebSocket, receives PCM audio chunks
- **SentenceBuffer** — buffers LLM tokens and emits at sentence boundaries for natural prosody
- **GeminiBatchSTTProvider** — transcribes user speech for display (separate from TTS)

## Troubleshooting

**Connection refused on port 9900**
The backend isn't running. Start it with `pnpm tsx app/cartesia-tts-demo.ts`.

**No audio playback in browser**
Chrome requires user interaction before playing audio. Click the Connect button — don't automate the connection.

**Cartesia WebSocket error**
Verify your `CARTESIA_API_KEY` is valid and has available credits.

**Gemini 1011 / 1007 / 1008 errors**
The Gemini Live model may not be available for your API key or region. Try setting `GEMINI_LIVE_MODEL` to a different model that supports `bidiGenerateContent`.
