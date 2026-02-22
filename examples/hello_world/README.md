# Hello World — Multi-Agent Voice Assistant

A minimal example demonstrating the core features of the Bodhi Realtime Agent Framework.

## What This Shows

| Feature | How It Works |
|---------|-------------|
| **Inline tools** | `get_time` returns the current time synchronously — Gemini waits for the result |
| **Voice pacing** | `set_speech_speed` injects an active directive that is reinforced every turn |
| **Image generation** | `generate_image` calls Gemini's image model and pushes base64 to the web client |
| **Background subagent** | `deep_research` is a background tool — it spawns a Vercel AI SDK subagent that runs while Gemini keeps talking |
| **Agent transfer** | Saying "I need help with math" triggers `transfer_to_agent`, which disconnects from Gemini and reconnects with the math expert's config |

## Prerequisites

- Node.js >= 22
- pnpm
- A Google API key with access to the Gemini Live API

## Running

```bash
# From the repository root:
pnpm install

# Start the voice agent
GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent.ts

# In a second terminal, start the web client
pnpm tsx examples/hello_world/web-client.ts
```

Then open <http://localhost:8080> in Chrome and click **Connect**.

## Things to Try

| Say this | What happens |
|----------|-------------|
| "What time is it?" | Calls the `get_time` inline tool |
| "What time is it in Tokyo?" | Same tool, with a timezone argument |
| "Speak slower please" | Calls `set_speech_speed` → injects a pacing directive |
| "Draw me a cat in a spacesuit" | Calls `generate_image` → image appears in the web client |
| "Research quantum computing" | Calls `deep_research` → background subagent runs while Gemini keeps talking |
| "I need help with complex math" | Triggers `transfer_to_agent` → math expert takes over |
| "Take me back to the main assistant" | Math expert transfers back to main |

## Architecture

```
Browser (web-client.ts)
  │  PCM audio + JSON text frames
  │
  ▼
ClientTransport (ws://localhost:9900)
  │
  ▼
VoiceSession ─── AgentRouter ─── ToolExecutor
  │                                    │
  ▼                                    ▼
GeminiLiveTransport              SubagentRunner
  │                              (Vercel AI SDK)
  ▼
Gemini Live API
```

- **Audio fast-path**: Mic → ClientTransport → GeminiLiveTransport → Gemini (and back). No EventBus on this path.
- **Tool calls**: Gemini emits tool calls → VoiceSession routes them → inline tools respond immediately, background tools spawn a subagent.
- **Agent transfer**: `transfer_to_agent` → disconnect from Gemini → reconnect with new agent config → replay conversation context.

## File Structure

```
examples/hello_world/
  agent.ts        ← Voice agent with tools and agents (this example)
  web-client.ts   ← Browser-based audio client
  README.md       ← You are here
```
