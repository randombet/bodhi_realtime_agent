# Hello World — Multi-Agent Voice Assistant

A minimal example showing four key features of the Bodhi Realtime Agent Framework.

## Running

```bash
# From the repository root:
pnpm install
GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent.ts
```

Connect a WebSocket audio client to `ws://localhost:9900` sending PCM 16-bit 16kHz mono audio.

## Features in Action

### Voice Pacing

Say **"Speak slower please"** — the `speechSpeed()` behavior preset auto-generates a `set_speech_speed` tool. When called, it injects a pacing directive that is reinforced every turn.

<p align="center">
  <img src="voice_pace_control.png" alt="Voice pace control" width="600">
</p>

### Google Search

Say **"What is the weather today?"** — with `googleSearch: true`, Gemini uses grounded web search to answer with real-time data and sources.

<p align="center">
  <img src="realtime_search_tool.png" alt="Google Search grounding" width="600">
</p>

### Image Generation

Say **"Draw me a green dog"** — the `generate_image` tool calls Gemini's image model and pushes the result to the client as base64.

<p align="center">
  <img src="image_generation.png" alt="Image generation" width="600">
</p>

### Agent Transfer

Say **"I need help with math"** — triggers `transfer_to_agent`, which disconnects from Gemini and reconnects with the math expert's config. Say **"Take me back"** to return.

## Things to Try

| Say this | What happens |
|----------|-------------|
| "Speak slower please" | Calls `set_speech_speed` — pacing directive injected |
| "I need help with math" | Transfers to math expert agent |
| "Take me back" | Math expert transfers back to main |
| "What is the weather today?" | Google Search grounding |
| "Draw me a cat in a spacesuit" | Image generated and sent to client |
