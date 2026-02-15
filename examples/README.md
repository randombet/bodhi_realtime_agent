# Examples

## Gemini Realtime Voice Agent

A real-time voice assistant powered by the Gemini Live API demonstrating custom tools, multi-agent transfers, and lifecycle hooks.

### Prerequisites

- Node.js 18+
- A [Google AI Studio](https://aistudio.google.com/) API key with Gemini Live API access
- Chrome (recommended for the web client)

### Quick Start

```bash
# 1. Set your API key
export GEMINI_API_KEY="your-key-here"

# 2. Start the voice agent server
pnpm tsx examples/gemini-realtime-tools.ts

# 3. In a second terminal, start the web client
pnpm tsx examples/web-client.ts

# 4. Open http://localhost:8080 in Chrome and click Connect
```

### Architecture

```
┌─────────────┐   WebSocket (binary+text)   ┌──────────────────┐   WebSocket   ┌─────────────┐
│  Browser UI │ ◄──────────────────────────► │  VoiceSession    │ ◄───────────► │ Gemini Live │
│  (web-client│   PCM audio (binary frames)  │  (agent server)  │   audio +     │    API      │
│   :8080)    │   JSON events (text frames)  │  (:9900)         │   tool calls  │             │
└─────────────┘                              └──────────────────┘               └─────────────┘
```

**Audio format:**
- Mic input: 16 kHz, 16-bit PCM, mono
- Agent output: 24 kHz, 16-bit PCM, mono

**WebSocket frames:**
- Binary frames carry raw PCM audio in both directions
- Text frames carry JSON messages (transcripts, turn events, GUI events)

### Files

| File | Description |
|------|-------------|
| `gemini-realtime-tools.ts` | Agent server — defines tools, agents, and starts a `VoiceSession` |
| `web-client.ts` | Web client — serves a browser UI for mic capture, audio playback, and transcription |

### What to Try

Once connected, try saying:

| Prompt | What happens |
|--------|-------------|
| "What time is it?" | Calls the `get_current_time` tool |
| "What is 25 times 17?" | Calls the `calculate` tool |
| "I need help with complex math" | Transfers to the `math_expert` agent |
| "Transfer me back" (while with math expert) | Transfers back to the `main` agent |
| "Use slow search for AI news" | Calls `slow_web_search` (3s delay demo) |

### Agents

**`main`** — General-purpose voice assistant with access to all tools. Transfers complex math questions to the math expert.

**`math_expert`** — Specialized math agent with a professorial tone. Has the calculator tool and can transfer back to main.

### Tools

| Tool | Type | Description |
|------|------|-------------|
| `calculate` | inline | Evaluates math expressions (supports sqrt, sin, cos, log, pow, pi, etc.) |
| `get_current_time` | inline | Returns current date/time in any timezone |
| `slow_web_search` | inline | Simulates a 3-second web search (demo for slow tool handling) |
| `transfer_to_agent` | inline | Triggers agent transfer (intercepted by the framework) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Google AI Studio API key |
| `PORT` | `9900` | WebSocket port for the agent server |
| `CLIENT_PORT` | `8080` | HTTP port for the web client |
| `WS_URL` | `ws://localhost:9900` | Agent WebSocket URL (used by web client) |

### Web Client Features

- **Real-time audio**: Web Audio API with gapless playback scheduling
- **Live transcription**: Browser Speech Recognition API for user input; Gemini output transcription for agent responses
- **Conversation view**: Shows user and agent messages with turn boundaries
- **Debug log**: Timestamped events for audio, WebSocket, and speech recognition
- **Save Debug**: Downloads a JSON snapshot of session state and logs for troubleshooting

### Troubleshooting

**No audio playback:** Make sure you click the Connect button directly (Chrome requires a user gesture to enable audio). Check the debug log for `playChunk error` messages.

**No user transcription:** Speech Recognition requires Chrome and a working microphone. The interim text ("You (hearing): ...") should appear as you speak.

**Agent doesn't call tools:** Check the server terminal for `[Hook] Tool called:` messages. If no tool calls appear, the model may need a more explicit prompt.

**Transfer not triggering:** The model must invoke the `transfer_to_agent` function call, not just say it verbally. If transfers aren't happening, check that the agent server logs show `[Hook] Agent transfer:`.
