# Running the Examples

The framework includes a full-featured demo with multiple agents, tools, image generation, and a web client with audio playback.

## Prerequisites

- Node.js 22+
- A Google API key with Gemini Live API access
- Chrome (recommended for the web client)

## Start the Agent Server

```bash
# Set your API key
export GEMINI_API_KEY="your-key-here"

# Start the voice agent
pnpm tsx app/gemini-realtime-tools.ts
```

You should see:

```
============================================================
Bodhi Realtime Agent — Gemini Voice Assistant
============================================================

  WebSocket audio server: ws://localhost:9900
  Session ID: session_1234567890

Connect a WebSocket audio client and try saying:
  - 'What time is it?'
  - 'What is 25 times 17?'
  - 'I need help with complex math' (transfers to math expert)
  - 'What's the weather in San Francisco?' (uses Google Search)
  - 'Use slow search for AI news'
  - 'Speak slower please' (changes speech speed)
  - 'Generate an image of a sunset' (creates and displays image)
  - 'I want to practice Spanish' (transfers to Spanish agent)

Press Ctrl+C to stop.
============================================================
```

## Start the Web Client

In a second terminal:

```bash
pnpm tsx app/web-client.ts
```

Open [http://localhost:8080](http://localhost:8080) in Chrome and click **Connect**.

## Things to Try

| Say this | What happens |
|----------|-------------|
| "What time is it?" | Calls `get_current_time` tool, speaks the result |
| "What is 25 times 17?" | Calls `calculate` tool with the expression |
| "I need help with complex math" | Transfers to the `math_expert` agent |
| "Transfer me back" (with math expert) | Returns to the `main` agent |
| "What's the weather in Tokyo?" | Uses Google Search grounding for real-time data |
| "Generate an image of a sunset" | Calls Imagen API, image appears in browser |
| "Speak slower please" | Adjusts playback rate via `set_speech_speed` tool |
| "I want to practice Spanish" | Transfers to `spanish_agent` (responds in Spanish) |
| "Use slow search for AI news" | Demonstrates 3-second slow tool (agent keeps talking) |

## Agents in the Demo

### Main Assistant

The default agent with access to all tools. Handles general conversation and routes specialized requests to other agents.

### Math Expert

A specialist with a professorial tone. Activated when you ask for help with complex math. Has the calculator tool and can transfer back to main.

### Spanish Agent

Speaks Spanish and helps with conversation practice. Activated when you want to practice Spanish. Configured with `language: 'es-ES'`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Google AI Studio API key |
| `PORT` | `9900` | WebSocket port for the agent server |
| `CLIENT_PORT` | `8080` | HTTP port for the web client |
| `WS_URL` | `ws://localhost:9900` | Agent WebSocket URL (used by web client) |

## Troubleshooting

### No audio playback

Make sure you click the **Connect** button directly — Chrome requires a user gesture to enable audio. Check the debug log for `playChunk error` messages.

### No user transcription

The web client uses Chrome's Speech Recognition API for user input transcription. This only works in Chrome with a working microphone. Server-side input transcription is also enabled by default.

### Agent doesn't call tools

Check the server terminal for `[Hook] Tool called:` messages. If no tool calls appear, try being more explicit: "Use the calculator to compute 25 times 17" instead of just "25 times 17".

### Transfer not triggering

The model must invoke the `transfer_to_agent` function call, not just say it verbally. If transfers aren't happening, check the server logs for `[Hook] Agent transfer:`.

### Image generation fails

Image generation uses the Imagen API (`imagen-3.0-generate-002`). Some API keys may not have access. Check the server logs for `[Tool] Imagen failed` messages.
