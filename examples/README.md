# Examples

Standalone single-user demos for testing individual framework features. Each example runs independently — start the script and connect a client.

> These demos are for development and testing. The production multi-user server is in [`app/`](../app/).

## Quick Reference

| Demo | Feature | Entry Point | Run |
|------|---------|-------------|-----|
| OpenAI Realtime | OpenAI native-audio voice assistant with tools/subagents | `openai-realtime-tools.ts` | `pnpm tsx examples/openai-realtime-tools.ts` |
| Cartesia TTS | Custom voice synthesis via Cartesia Sonic | `cartesia-tts-demo.ts` | `pnpm tsx examples/cartesia-tts-demo.ts` |
| Twilio Human Transfer | Transfer live call to a real human and back | `twilio-demo.ts` | `pnpm tsx examples/twilio-demo.ts` |
| Twilio Inbound Bridge | Call a Twilio number to talk to any agent | `twilio-inbound-bridge.ts` | `pnpm tsx examples/twilio-inbound-bridge.ts` |
| OpenClaw | Multi-tool agent with search, images, video | `openclaw/openclaw-demo.ts` | `pnpm tsx examples/openclaw/openclaw-demo.ts` |
| SpatialReal Avatar Host Sync | Voice agent + avatar keyframe sync (host mode bridge) | `spatialreal_avatar_websdk/demo.ts` | `pnpm tsx examples/spatialreal_avatar_websdk/demo.ts` |
| Interviewer | Document-driven software interview with a planning subagent | `interviewer/interviewer-demo.ts` | `pnpm tsx examples/interviewer/interviewer-demo.ts` |
| Widget embed dump | Static page on port 8765 to test `wg_*` + `bodhi-widget.js` from another origin | `embed-widget-dump/server.mjs` | `pnpm examples:embed-widget-dump` |

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

Works with any running VoiceSession (including the production server on port 9900).

```bash
export TWILIO_WEBHOOK_URL="https://xxxx.ngrok-free.app"
pnpm tsx examples/twilio-inbound-bridge.ts
```

Configure your Twilio phone number webhook to `https://…/voice` (POST).

## OpenClaw

See [openclaw/OPENCLAW-README.md](openclaw/OPENCLAW-README.md) for gateway setup.

```bash
export GEMINI_API_KEY="your-gemini-key"
pnpm tsx examples/openclaw/openclaw-demo.ts
# In another terminal:
pnpm tsx examples/openclaw/web-client.ts
```

## SpatialReal Avatar Web SDK

See [spatialreal_avatar_websdk/README.md](spatialreal_avatar_websdk/README.md) for required env setup. Use the **single** Python venv under `app/lib/spatialreal/bridge/` (`./setup-venv.sh` once).

```bash
pnpm tsx examples/spatialreal_avatar_websdk/demo.ts
# In another terminal:
pnpm tsx examples/spatialreal_avatar_websdk/web-client.ts
```

## Interviewer

See [interviewer/README.md](interviewer/README.md) for the document-driven interview flow.

```bash
export GEMINI_API_KEY="your-gemini-key"
pnpm tsx examples/interviewer/interviewer-demo.ts
# In another terminal:
pnpm web-client:dev
```

## Publishable widget embed (cross-origin)

See [embed-widget-dump/README.md](embed-widget-dump/README.md). Run the Bodhi API + web client, then:

```bash
pnpm examples:embed-widget-dump
```
