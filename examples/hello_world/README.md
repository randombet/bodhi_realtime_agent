# Hello World — Multi-Agent Voice Assistant

A minimal example showing key features of the Bodhi Realtime Agent Framework.

## Running

```bash
# From the repository root:
pnpm install

# Full example (voice pacing, agent transfer, Google Search, image & video generation):
GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent.ts

# Or use the web client for a browser-based UI:
pnpm tsx examples/hello_world/web-client.ts
# Then open http://localhost:8080 in Chrome
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

---

## Background Subagent Test

Video generation via Veo has a low daily request quota. Use `agent-background-test.ts` to test the non-blocking background tool flow without consuming API quotas — it uses `sleep()` delays instead of real generation calls.

### Running

```bash
GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent-background-test.ts
```

Then connect via the web client or a WebSocket audio client on `ws://localhost:9900`.

### What It Tests

This example exercises the full background subagent lifecycle:

1. **Pending notification** — Gemini speaks a pending message immediately while the task runs in the background
2. **Notification queuing** — If the task finishes while Gemini is mid-sentence, the completion notification is queued and delivered after the current turn
3. **Concurrent tasks** — Multiple background tasks can run in parallel; each completes independently
4. **Error handling** — A deliberate failure path tests that error notifications are spoken to the user

### Things to Try

| Say this | What happens |
|----------|-------------|
| "Run a 10 second task" | Starts a background sleep(10s), Gemini keeps chatting |
| "Run a failing task" | Starts a task that errors after 3s — tests error notification |
| "Run two tasks at once" | Fires two concurrent background tools |
| (keep chatting while tasks run) | Tests notification queuing — completion is spoken after Gemini's current turn |
