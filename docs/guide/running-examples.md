# Running the Server and Clients

The framework ships with a production WebSocket server and an optional browser client. This page describes how to run them and how clients connect.

## Prerequisites

- Node.js 22+
- `GEMINI_API_KEY` (Google AI Studio, with Gemini Live API access)

## Start the Server (Gemini)

```bash
export GEMINI_API_KEY=your-api-key
pnpm install
pnpm start
```

The server binds to `HOST:PORT` (default `0.0.0.0:9900`). Each WebSocket connection gets one `VoiceSession`; agents and tools come from `app/agents/bodhi-session.ts`.

## Client Connection

- **WebSocket URL:** `ws://<host>:<PORT>` (e.g. `ws://your-server:9900`).
- **Binary frames:** PCM 16-bit 16 kHz mono audio (input and output; output is 24 kHz from the model).
- **Text frames:** JSON. Server sends e.g. `session.ready`, transcripts, turn events, `gui.update`. Client can send JSON for UI or control.

After connecting, the server sends a `session.ready` message with `sessionId` and `userId`. Then the client can send audio and receive agent audio and events.

## Optional Web Client

A browser UI is included for testing or internal use:

```bash
pnpm tsx app/web-client.ts
```

It serves an HTTP page that connects to the agent WebSocket. The WebSocket URL is derived from the browser’s host. Configure `CLIENT_PORT` (default 8080) and `CLIENT_HOST` as needed.

## OpenAI Realtime (Alternative Transport)

An OpenAI Realtime API–based app exists at `app/openai-realtime-tools.ts`. Run it with `OPENAI_API_KEY`. Same client contract (WebSocket, binary audio + JSON); audio format is negotiated by the transport.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Required for Gemini server |
| `PORT` | `9900` | WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `CLIENT_PORT` | `8080` | Web client HTTP port (when running web-client) |
| `CLIENT_HOST` | `0.0.0.0` | Web client bind address |

For full server options (limits, auth), see **app/README.md**.
