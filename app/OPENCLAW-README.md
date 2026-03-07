# Bodhi + OpenClaw — Voice-Driven AI Agent Demo

A voice assistant that combines Gemini's native capabilities (search, image/video generation) with OpenClaw's general-purpose agent for coding, research, writing, emails, and more.

## Features

- **Voice interface**: Speak requests naturally via Chrome
- **OpenClaw agent**: Delegates complex tasks (coding, research, email, file operations, multi-step tasks)
- **Google Search**: Real-time web search via Gemini's built-in grounding
- **Image generation**: Creates images via Gemini (`gemini-2.5-flash-image`)
- **Video generation**: Creates short videos via Veo (`veo-3.1-generate-preview`)
- **Interactive delegation**: OpenClaw can ask follow-up questions relayed via voice

## Architecture

```
┌─────────────┐   WebSocket   ┌──────────────────┐   WebSocket   ┌─────────────┐
│  Browser UI │ ◄───────────► │  VoiceSession    │ ◄───────────► │ Gemini Live │
│  (web-client│   audio + JSON│  (agent server)  │   audio +     │    API      │
│   :8080)    │               │  (:9900)         │   tool calls  │             │
└─────────────┘               └────────┬─────────┘               └─────────────┘
                                       │
                                       │ WebSocket (JSON-RPC)
                                       ▼
                              ┌──────────────────┐
                              │  OpenClaw        │
                              │  Gateway         │
                              │  (:18789)        │
                              └──────────────────┘
```

## Prerequisites

- Node.js 18+
- A [Google AI Studio](https://aistudio.google.com/) API key with Gemini Live API access
- An OpenClaw instance with gateway running (local or remote)
- Chrome (recommended for the web client)

## Setup

### 1. Network Access to OpenClaw Gateway

If OpenClaw runs on a remote server, the gateway binds to `127.0.0.1` (loopback only) by default. Use an SSH tunnel to forward the port:

```bash
# In a terminal (keep running):
ssh -L 18789:127.0.0.1:18789 user@your-server-ip
```

Now `ws://127.0.0.1:18789` on your local machine reaches the remote gateway.

If OpenClaw is running locally, no tunnel is needed.

### 2. Get Your Gateway Auth Token

On the machine where OpenClaw runs:

```bash
openclaw config get gateway.authToken
```

If no token is set, create one:

```bash
openclaw config set gateway.authToken "your-secret-token"
sudo systemctl restart openclaw-gateway
```

### 3. Set Environment Variables

```bash
export GEMINI_API_KEY="your-gemini-api-key"
export OPENCLAW_TOKEN="your-gateway-auth-token"

# Optional overrides:
# export OPENCLAW_URL="ws://127.0.0.1:18789"  # default
# export PORT=9900                              # voice agent WebSocket port
# export HOST="0.0.0.0"                         # voice agent bind address
```

### 4. Run the Demo

```bash
# Terminal 1: Start the voice agent server
pnpm tsx app/openclaw-demo.ts

# Terminal 2: Start the web client
pnpm tsx app/web-client.ts

# Open http://localhost:8080 in Chrome and click Connect
```

On first run, a device keypair is generated at `~/.bodhi/device-identity.json`. This is used for Ed25519 challenge-response authentication with the gateway. The keypair is reused on subsequent runs.

### 5. Approve the Device (if needed)

For **local connections** (loopback or SSH tunnel), the gateway auto-approves new devices.

If you see a connection rejection, approve the device on the OpenClaw server:

```bash
openclaw gateway devices list
openclaw gateway devices approve <device-id>
```

The device ID is printed in the demo startup log (first 16 characters of the SHA-256 fingerprint).

## What to Try

| Prompt | What Happens |
|--------|--------------|
| "What is the weather in San Francisco?" | Google Search (Gemini native grounding) |
| "Draw me a picture of a sunset" | Image generation via Gemini subagent |
| "Make a short video of ocean waves" | Video generation via Veo subagent |
| "Write a Python prime checker" | OpenClaw agent (coding) |
| "Summarize today's tech news by email" | OpenClaw agent (research + email) |
| "What time is it?" | Inline tool (`get_current_time`) |
| "Goodbye" | Graceful session close |

## Tool Routing

The voice agent routes requests to the appropriate tool:

| Tool | Type | When Used |
|------|------|-----------|
| Google Search | native | Quick factual lookups — weather, news, sports, "who is X" |
| `generate_image` | background | Any picture, image, card, or illustration request |
| `generate_video` | background | Any video, animation, or movie clip request |
| `ask_openclaw` | background | Complex tasks — coding, writing, research, email, file ops, anything else |
| `get_current_time` | inline | Current date/time |
| `end_session` | inline | User says goodbye |

When unsure, the agent routes to OpenClaw.

## Files

| File | Description |
|------|-------------|
| `openclaw-demo.ts` | Agent server — defines tools, agents, OpenClaw integration, starts VoiceSession |
| `web-client.ts` | Web client — browser UI for mic capture, audio playback, transcription |
| `lib/openclaw-client.ts` | WebSocket client for OpenClaw Gateway JSON-RPC protocol |
| `lib/openclaw-tools.ts` | Tool definitions and subagent config for OpenClaw delegation |
| `lib/openclaw-device-identity.ts` | Ed25519 device identity — keygen, persistence, challenge signing |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Google AI Studio API key |
| `OPENCLAW_TOKEN` | `""` | OpenClaw gateway auth token |
| `OPENCLAW_URL` | `ws://127.0.0.1:18789` | OpenClaw gateway WebSocket URL |
| `PORT` | `9900` | Voice agent WebSocket port |
| `HOST` | `0.0.0.0` | Voice agent bind address |

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `connect ECONNREFUSED 127.0.0.1:18789` | Gateway not reachable | Set up SSH tunnel or check gateway is running |
| `Connection rejected` | Wrong auth token | Verify `OPENCLAW_TOKEN` matches `openclaw config get gateway.authToken` |
| `device signature invalid` | Payload format mismatch | Delete `~/.bodhi/device-identity.json` and retry |
| `device signature expired` | Clock skew > 10 min | Sync system clocks (NTP) |
| `device-id-mismatch` | Corrupted identity file | Delete `~/.bodhi/device-identity.json` and retry |
| No audio playback | Chrome audio context not started | Click Connect directly (Chrome requires user gesture) |
| OpenClaw not responding | Gateway connected but agent idle | Check OpenClaw server logs; ensure the agent process is running |

## Authentication Details

The demo uses Ed25519 challenge-response authentication:

1. Client opens WebSocket to gateway
2. Gateway sends `connect.challenge` with `nonce` and `ts`
3. Client signs a v2 payload (`v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce`) with the Ed25519 private key
4. Gateway verifies the signature and accepts/rejects the connection

The device identity (keypair + device ID) is persisted at `~/.bodhi/device-identity.json` with `0600` permissions. Delete this file to regenerate.
