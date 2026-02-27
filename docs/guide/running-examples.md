# Running the Examples

The framework includes full-featured demos for both Gemini and OpenAI, with multiple agents, tools, image generation, and a web client with audio playback.

## Prerequisites

- Node.js 22+
- A Google API key with Gemini Live API access, **or** an OpenAI API key
- Chrome (recommended for the web client)

## Start the Agent Server (Gemini)

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
  - Try speaking in any language — the assistant replies in kind

Press Ctrl+C to stop.
============================================================
```

## Start the Agent Server (OpenAI)

Alternatively, run the same tools and agents with OpenAI's Realtime API:

```bash
# Set your API key
export OPENAI_API_KEY="your-key-here"

# Start the voice agent
pnpm tsx app/openai-realtime-tools.ts
```

The OpenAI example has the same tools (calculator, current time, image generation, slow search) and agents (main, math expert) as the Gemini example. The web client works with either server without changes — audio format is negotiated automatically via `session.config`.

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
| "Use slow search for AI news" | Demonstrates 3-second slow tool (agent keeps talking) |
| Speak in any language | The assistant automatically replies in the same language |

## Agents in the Demo

### Main Assistant

The default agent with access to all tools. Handles general conversation and routes specialized requests to other agents.

### Math Expert

A specialist with a professorial tone. Activated when you ask for help with complex math. Has the calculator tool and can transfer back to main.

### Multilingual

The main assistant is multilingual by default — speak in any language and it replies in kind. No separate agent needed; Gemini's native audio model handles language detection and response automatically.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Google AI Studio API key (for Gemini example) |
| `OPENAI_API_KEY` | — | OpenAI API key (for OpenAI example) |
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
