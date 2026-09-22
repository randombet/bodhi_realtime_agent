# Bodhi + Hermes — Voice-Driven Remote Agent Demo

A voice assistant that uses **Gemini native audio** for conversation and delegates
complex work to your **Hermes agent** (by [Nous Research](https://github.com/NousResearch/hermes-agent))
running on a remote VPS. Unlike the OpenClaw demo — which speaks a custom
WebSocket/JSON-RPC protocol — Hermes exposes an **OpenAI-compatible HTTP API**, so
the integration is just the Vercel AI SDK OpenAI provider pointed at your Hermes
endpoint.

## Features

- **Voice interface**: Speak requests naturally via Chrome
- **Hermes delegation**: Routes coding, research, browsing, file, and productivity
  tasks to your remote Hermes agent (`ask_hermes`)
- **Persistent Hermes state**: Reuses a stable `X-Hermes-Session-Id` so Hermes'
  memory/skills persist across delegated turns within a session
- **Google Search**: Quick factual lookups via Gemini's built-in grounding
- **Interactive delegation**: Hermes can ask follow-up questions, relayed via voice
- **Transcript store**: Per-session WhatsApp-style markdown transcript

## Architecture

```
┌─────────────┐   WebSocket   ┌──────────────────┐   WebSocket   ┌─────────────┐
│  Browser UI │ ◄───────────► │  VoiceSession    │ ◄───────────► │ Gemini Live │
│ (web-client │  audio + JSON │  (agent server)  │  audio +      │    API      │
│   :8080)    │               │  (:9900)         │  tool calls   │             │
└─────────────┘               └────────┬─────────┘               └─────────────┘
                                       │
                                       │ HTTPS (OpenAI-compatible /v1)
                                       ▼
                              ┌──────────────────┐
                              │  Hermes API      │
                              │  server on VPS   │
                              │  (127.0.0.1:8642)│
                              └──────────────────┘
```

The `ask_hermes` tool is a `background` subagent whose `reasoningModel` is an
`@ai-sdk/openai` model bound to Hermes' base URL — so the framework's existing
subagent machinery (`AgentRouter`, interactive `ask_user` relay) works unchanged.

## Prerequisites

- Node.js 18+
- A [Google AI Studio](https://aistudio.google.com/) API key with Gemini Live API access
- A Hermes instance running on a server with its API server enabled
- Chrome (recommended for the web client)

## Setup

### 1. Enable the Hermes API server (on the VPS)

In `~/.hermes/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=<a-strong-random-secret>     # e.g. `openssl rand -hex 32`
```

`API_SERVER_KEY` is a shared secret **you choose** — clients send it back as
`Authorization: Bearer <key>`. Then start the gateway:

```bash
hermes gateway
```

The API server binds to `127.0.0.1:8642` (loopback only) by default.

### 2. Make the API reachable from your machine

Because Hermes listens on loopback, you need to bridge to it. Two good options:

**Option A — Tailscale (recommended, persistent).** On the VPS:

```bash
tailscale serve --bg 8642
tailscale serve status      # prints the https://<machine>.<tailnet>.ts.net URL
```

This fronts Hermes with HTTPS on port **443** at the tailnet hostname. Set
`HERMES_URL` to that URL — **`https://`, no port, no `/v1`**:

```bash
export HERMES_URL=https://<machine>.<tailnet>.ts.net
```

**Option B — SSH tunnel (zero VPS reconfig).** Run locally and keep it open:

```bash
ssh -N -L 8642:127.0.0.1:8642 <user>@<vps-ip>
export HERMES_URL=http://127.0.0.1:8642
```

### 3. Set environment variables

```bash
export GEMINI_API_KEY="your-gemini-api-key"
export HERMES_API_KEY="your-API_SERVER_KEY"     # must match the VPS value
export HERMES_URL="https://<machine>.<tailnet>.ts.net"   # or http://127.0.0.1:8642 via SSH tunnel

# Optional overrides:
# export HERMES_MODEL="hermes-agent"   # Hermes model/profile name (default)
# export PORT=9900                      # voice agent WebSocket port
# export HOST="0.0.0.0"                 # voice agent bind address
# export TRANSCRIPT_DIR="./transcripts" # per-session markdown transcripts
```

Verify the endpoint before running — this must return JSON, not `401`:

```bash
curl -sS "$HERMES_URL/v1/models" -H "Authorization: Bearer $HERMES_API_KEY"
```

### 4. Run the demo

```bash
# Terminal 1: Start the voice agent server
pnpm tsx examples/hermes/hermes-demo.ts

# Terminal 2: Start the shared web client
pnpm web-client

# Open http://localhost:8080 in Chrome and click Connect
```

## What to Try

| Prompt | What Happens |
|--------|--------------|
| "What is the weather in San Francisco?" | Google Search (Gemini native grounding) |
| "Ask Hermes to inspect my project files" | Hermes delegation (file ops) |
| "Have Hermes write a Python prime checker" | Hermes delegation (coding) |
| "Ask Hermes to research deployment options" | Hermes delegation (research) |
| "What time is it?" | Inline tool (`get_current_time`) |
| "Goodbye" | Graceful session close |

## Tool Routing

| Tool | Type | When Used |
|------|------|-----------|
| `ask_hermes` | background | Multi-step work — coding, research, browsing, file ops, productivity tasks |
| Google Search | native | Quick factual lookups — weather, news, "who is X" |
| `get_current_time` | inline | Current date/time |
| `end_session` | inline | User says goodbye |

## Files

| File | Description |
|------|-------------|
| `hermes-demo.ts` | Agent server — defines tools, the main agent, Hermes wiring, starts VoiceSession |
| `../lib/hermes-tools.ts` | `ask_hermes` tool + Hermes subagent factory (AI SDK OpenAI provider) |
| `../web-client.ts` | Browser UI for mic capture / playback (reused) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Google AI Studio API key for the voice/live model |
| `HERMES_API_KEY` | (required) | Hermes `API_SERVER_KEY` bearer token |
| `HERMES_URL` | `http://127.0.0.1:8642` | Hermes API base URL **without** `/v1` |
| `HERMES_MODEL` | `hermes-agent` | Hermes model/profile name |
| `PORT` | `9900` | Voice agent WebSocket port |
| `HOST` | `0.0.0.0` | Voice agent bind address |
| `TRANSCRIPT_DIR` | `./transcripts` | Per-session markdown transcript directory |

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to parse URL from <host>:8642/v1/...` | `HERMES_URL` has no scheme | Prefix with `http://` or `https://` |
| `connect ECONNREFUSED <ip>:8642` | Hitting the VPS port directly, but Hermes is loopback-only | Use the `tailscale serve` HTTPS URL (no `:8642`) or an SSH tunnel |
| `ECONNREFUSED` persists after changing the URL | Old value still exported (e.g. in `~/.zshrc`) and read by the running process | Fix the export, open a fresh shell / `source ~/.zshrc`, restart the demo |
| `401 Invalid API key` | `HERMES_API_KEY` doesn't match the VPS `API_SERVER_KEY` | Copy the exact value from `~/.hermes/.env` on the VPS |
| `404` on `/v1/...` | `tailscale serve` mapped a sub-path, or `/v1` included in `HERMES_URL` | Serve at root (`tailscale serve --bg 8642`); keep `/v1` out of `HERMES_URL` |
| No audio playback | Chrome audio context not started | Click Connect directly (Chrome requires a user gesture) |

> **Tip:** env vars are read once at process start. If you change `HERMES_URL`,
> restart the demo in the same shell where the new value is exported.

## Security Note

`API_SERVER_KEY` / `HERMES_API_KEY` is a plaintext shared secret — treat it like a
password. Keep Hermes bound to `127.0.0.1` and reach it over Tailscale or an SSH
tunnel rather than exposing port 8642 publicly. If you bind to `0.0.0.0`, the
bearer key is the only thing protecting the agent — make it long and random, and
firewall the port.
