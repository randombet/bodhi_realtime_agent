# Examples

Standalone demos for testing framework features. Each example runs independently.

## Quick Reference

| Demo | Feature | Entry Point | Run |
|------|---------|-------------|-----|
| Gemini Realtime | Senior-friendly Gemini Live voice assistant with tools/transfers | `gemini-realtime-tools.ts` | `pnpm tsx examples/gemini-realtime-tools.ts` |
| Gemini + Deepgram STT | Gemini Live voice assistant with Deepgram Nova-3 live user transcription | `gemini-deepgram-streaming-stt.ts` | `pnpm tsx examples/gemini-deepgram-streaming-stt.ts` |
| Generic Web Client | Browser client for realtime voice demos | `web-client.ts` | `pnpm tsx examples/web-client.ts` |
| OpenAI Realtime | OpenAI native-audio voice assistant with tools/subagents | `openai-realtime-tools.ts` | `pnpm tsx examples/openai-realtime-tools.ts` |
| Cartesia TTS | Custom voice synthesis via Cartesia Sonic | `cartesia-tts-demo.ts` | `pnpm tsx examples/cartesia-tts-demo.ts` |
| Twilio Human Transfer | Transfer live call to a real human and back | `twilio-demo.ts` | `pnpm tsx examples/twilio-demo.ts` |
| Twilio Inbound Bridge | Call a Twilio number to talk to any agent | `twilio-inbound-bridge.ts` | `pnpm tsx examples/twilio-inbound-bridge.ts` |
| OpenClaw | Multi-tool agent with search, images, video | `openclaw/openclaw-demo.ts` | `pnpm tsx examples/openclaw/openclaw-demo.ts` |

## Gemini Realtime Voice Agent

```bash
export GEMINI_API_KEY="your-gemini-key"
pnpm tsx examples/gemini-realtime-tools.ts
pnpm tsx examples/web-client.ts
```

Then open `http://localhost:8080`, connect, and try:
- "What time is it?"
- "What is 25 times 17?"
- "I need help with harder math"
- "Speak slower please"
- "Draw me a picture of a sunset"

## Gemini Live + Deepgram Nova-3 STT

See [DEEPGRAM-STT-README.md](DEEPGRAM-STT-README.md) for setup details.

```bash
export GEMINI_API_KEY="your-gemini-key"
export DEEPGRAM_API_KEY="your-deepgram-key"
pnpm tsx examples/gemini-deepgram-streaming-stt.ts
pnpm tsx examples/web-client.ts
```

## OpenAI Realtime

```bash
export OPENAI_API_KEY="your-openai-key"
export GEMINI_API_KEY="your-gemini-key"
pnpm tsx examples/openai-realtime-tools.ts
```

## Cartesia TTS

See [CARTESIA-TTS-README.md](CARTESIA-TTS-README.md) for full setup and architecture.

```bash
export GEMINI_API_KEY="your-gemini-key"
export CARTESIA_API_KEY="your-cartesia-key"
pnpm tsx examples/cartesia-tts-demo.ts
```

## Twilio Human Transfer

See [TWILIO-README.md](TWILIO-README.md) for Twilio account setup and ngrok configuration.

```bash
export GEMINI_API_KEY="your-gemini-key"
export TWILIO_ACCOUNT_SID="ACxxxxxxxx"
export TWILIO_AUTH_TOKEN="xxxxxxxx"
export TWILIO_FROM_NUMBER="+1xxxxxxxxxx"
export HUMAN_AGENT_PHONE="+1xxxxxxxxxx"
export TWILIO_WEBHOOK_URL="https://xxxx.ngrok-free.app"
pnpm tsx examples/twilio-demo.ts
```

## Twilio Inbound Bridge

Works with any running VoiceSession (including demos on port 9900).

```bash
export TWILIO_WEBHOOK_URL="https://xxxx.ngrok-free.app"
pnpm tsx examples/twilio-inbound-bridge.ts
```

Configure your Twilio phone number webhook to `https://.../voice` (POST).

## OpenClaw

See [openclaw/OPENCLAW-README.md](openclaw/OPENCLAW-README.md) for gateway setup.

```bash
export GEMINI_API_KEY="your-gemini-key"
pnpm tsx examples/openclaw/openclaw-demo.ts
# In another terminal:
pnpm tsx examples/openclaw/web-client.ts
```
