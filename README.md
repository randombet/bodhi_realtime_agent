<p align="center">
  <img src="docs/images/icon_graphic_only.png" alt="Bodhi Agent" width="120" />
</p>

# Bodhi Realtime Agent Framework

[![npm version](https://img.shields.io/npm/v/bodhi-realtime-agent.svg)](https://www.npmjs.com/package/bodhi-realtime-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Your voice agent keeps talking while background tasks run in parallel.** No other framework does this out of the box.

<p align="center">
  <a href="https://www.youtube.com/watch?v=zkjBKwQu54s">
    <img src="https://img.youtube.com/vi/zkjBKwQu54s/maxresdefault.jpg" alt="Watch the demo" width="700" />
  </a>
  <br />
  <em>Click to watch the demo</em>
</p>

Most voice agent frameworks block conversation while tools execute. User says "generate me a video" and the agent goes silent for two minutes. Bodhi splits the work: **main agents** handle the live conversation (Gemini Live API), while **background subagents** (Vercel AI SDK) run long tasks in parallel. When a task finishes, the agent naturally announces it.

```
User: "Make me a video of a sunset AND search for weather in Tokyo"

Main Agent (Gemini Live — realtime voice):
  "I'm generating your video and looking up the weather..."
  │
  ├─ Subagent 1: Video generation (2 min, Veo API)
  ├─ Subagent 2: Web search (3 sec, Gemini)
  │
  "What else can I help with?"      ← keeps talking
  │
  [3s]  "The weather in Tokyo is..."  ← search result arrives
  [2m]  "Your video is ready!"        ← video arrives
```

**Zero infrastructure.** No LiveKit server, no media SFU, no platform subscription. Just your Node.js server talking directly to Gemini Live API over WebSocket.

### OpenClaw Integration — Voice-Driven AI Agent

The [OpenClaw demo](examples/openclaw/openclaw-demo.ts) shows a full-featured voice assistant backed by an **interactive background subagent**. Say "write a Python prime checker" or "summarize today's tech news by email" — the request is delegated to the OpenClaw agent which can code, browse the web, send emails, and more. If OpenClaw needs clarification, it asks the user via voice mid-task, then continues. Meanwhile, Gemini handles quick lookups (Google Search), image/video generation, and keeps the conversation flowing.

```
User: "Write me a Python script that scrapes Hacker News"

Main Agent (voice):  "I'm sending that to my agent now..."  ← keeps talking
  │
  └─ OpenClaw subagent (background, interactive):
       Step 1: openclaw_chat("Write a Python HN scraper")
       Step 2: ask_user("Should I include comments or just titles?")  ← voice question
       Step 3: openclaw_chat(user's answer)
       Step 4: returns summary
  │
Main Agent: "Done! The script is saved as hn_scraper.py..."  ← announces result
```

## Features

- **Background subagents**: Mark any tool as `execution: 'background'` — it hands off to a background runtime (`ai_sdk` by default, or `claude_code` via Claude Code CLI). Subagents can be **interactive** — asking the user follow-up questions via voice mid-task
- **Real-time voice**: Bidirectional audio streaming with Gemini Live API, server-side VAD and turn detection
- **Multi-agent transfers**: Define specialist agents with distinct personas and tools; transfer mid-conversation with context replay and audio buffering
- **Inline + background tools**: `inline` tools block the turn (fast lookups); `background` tools run async (image/video generation, data analysis)
- **Behaviors**: Declarative presets for speech speed, verbosity, language — auto-generates tools, manages state, syncs with client
- **Google Search**: Built-in grounded web search via Gemini with source citations
- **Image & video generation**: Generate media with Gemini/Veo and push to the client in real time
- **Memory**: LLM-powered fact extraction and persistence across sessions with pluggable storage
- **Session resumption**: Transparent reconnection via Gemini resumption handles and audio buffering
- **Observability**: Type-safe EventBus and lifecycle hooks for logging, metrics, and debugging

## How It Compares

| | **Bodhi** | **LiveKit Agents** | **Pipecat** | **OpenAI Realtime Agents** | **ElevenLabs** |
|---|---|---|---|---|---|
| **Parallel background subagents** | Yes — built-in, each with own tool loop | No — manual async | No — manual frame injection | No — tools block | No |
| **Voice keeps talking during tools** | Yes — `execution: 'background'` | No | No | No | No |
| **Zero infrastructure** | Yes — direct to Gemini | No — requires LiveKit SFU | No — requires transport | Yes — but browser-only | No — hosted platform |
| **Server-side tool execution** | Yes | Yes | Yes | No — browser sandbox | Yes — via webhooks |
| **Multi-agent transfers** | Yes — with context replay | Yes — `updateAgent()` | Manual | Yes — declarative handoffs | Yes — visual editor |
| **Provider support** | Gemini Live | OpenAI, Gemini, XAI | 60+ services | OpenAI only | Multiple LLMs |
| **Memory / fact extraction** | Built-in | No | No | No | Platform-managed |
| **Language** | TypeScript | TypeScript / Python | Python | TypeScript | REST API |

Bodhi's sweet spot: **single-user voice agents with complex background processing** (AI assistants, research bots, creative tools). If you need multi-participant rooms or provider flexibility, look at LiveKit Agents or Pipecat.

## Requirements

- Node.js >= 22
- A Google API key with Gemini Live API access
- pnpm (recommended)

## Installation

```bash
pnpm add bodhi-realtime-agent
```

## Quick Start

```typescript
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { VoiceSession } from 'bodhi-realtime-agent';
import type { MainAgent, ToolDefinition } from 'bodhi-realtime-agent';

// 1. Define tools
const getCurrentTime: ToolDefinition = {
  name: 'get_current_time',
  description: 'Get the current date and time.',
  parameters: z.object({
    timezone: z.string().optional().describe('Timezone name'),
  }),
  execution: 'inline',
  execute: async (args) => {
    const { timezone } = args as { timezone?: string };
    const now = new Date();
    return {
      time: now.toLocaleString('en-US', {
        timeZone: timezone ?? undefined,
        dateStyle: 'full',
        timeStyle: 'long',
      }),
    };
  },
};

// 2. Define agents
const mainAgent: MainAgent = {
  name: 'main',
  instructions: 'You are a helpful voice assistant.',
  tools: [getCurrentTime],
};

// 3. Create and start a session
const session = new VoiceSession({
  sessionId: `session_${Date.now()}`,
  userId: 'user_1',
  apiKey: process.env.GOOGLE_API_KEY!,
  agents: [mainAgent],
  initialAgent: 'main',
  port: 9900,
  model: createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY! })('gemini-2.5-flash'),
});

await session.start();
// Connect a WebSocket audio client to ws://localhost:9900
```

## Core Concepts

### VoiceSession

The top-level integration hub. It wires together all framework components and manages the full session lifecycle:

```
Client App  <--WebSocket-->  ClientTransport  <--audio-->  GeminiLiveTransport  <--WebSocket-->  Gemini Live API
                                    |                              |
                                    +--------- VoiceSession -------+
                                    |    (audio fast-path relay)    |
                                    |                              |
                              AgentRouter    ToolExecutor    ConversationContext
```

Audio flows on a **fast-path** directly between the client and Gemini transports, bypassing the EventBus for minimal latency.

### Agents

Agents are the top-level personas that Gemini assumes. Each agent has its own system instructions and tool set.

```typescript
const mainAgent: MainAgent = {
  name: 'main',
  instructions: 'You are a helpful assistant.',
  tools: [myTool],
  onEnter: async (ctx) => { /* agent activated */ },
  onExit: async (ctx) => { /* agent deactivated */ },
  onTurnCompleted: async (ctx, transcript) => { /* turn finished */ },
};
```

**Agent transfers** are triggered by a special `transfer_to_agent` tool. The framework intercepts this tool call automatically, disconnects from Gemini, reconnects with the new agent's config, and replays conversation context:

```typescript
const transferToExpert: ToolDefinition = {
  name: 'transfer_to_agent',
  description: 'Transfer to the expert agent.',
  parameters: z.object({
    agent_name: z.literal('expert'),
  }),
  execution: 'inline',
  execute: async () => ({ status: 'transferred' }),
};
```

### Tools

Tools are declared with a Zod schema (for both Gemini declaration and runtime validation) and an execution mode:

| Mode | Behavior |
|------|----------|
| `inline` | Gemini waits for the result before continuing to speak |
| `background` | Handed off to a subagent; Gemini continues speaking while it runs |

```typescript
const myTool: ToolDefinition = {
  name: 'lookup',
  description: 'Look up information.',
  parameters: z.object({ query: z.string() }),
  execution: 'inline', // or 'background'
  timeout: 10_000,      // optional, default 30s
  execute: async (args, ctx) => {
    // ctx.abortSignal is triggered on cancellation/timeout
    return { answer: '42' };
  },
};
```

### Session State Machine

Sessions follow a strict state machine:

```
CREATED --> CONNECTING --> ACTIVE --> RECONNECTING --> ACTIVE
                            |                           |
                        TRANSFERRING --> ACTIVE       CLOSED
                            |
                          CLOSED
```

- **RECONNECTING**: Triggered by GoAway signals or unexpected disconnects. Audio is buffered and replayed.
- **TRANSFERRING**: Active during agent transfers. Client audio is buffered until the new agent is connected.

### EventBus

A type-safe, synchronous event bus for loose coupling between components:

```typescript
session.eventBus.subscribe('agent.transfer', (payload) => {
  console.log(`Transfer: ${payload.fromAgent} -> ${payload.toAgent}`);
});

session.eventBus.subscribe('tool.result', (payload) => {
  console.log(`Tool ${payload.toolName}: ${payload.result}`);
});
```

Available events: `session.start`, `session.close`, `session.stateChange`, `session.goaway`, `turn.start`, `turn.end`, `turn.interrupted`, `agent.enter`, `agent.exit`, `agent.transfer`, `agent.handoff`, `tool.call`, `tool.result`, `tool.cancel`, `gui.update`, `gui.notification`.

### GUI Events

The client WebSocket carries both audio and GUI events on the same connection using the native binary/text frame distinction:

- **Binary frames**: Raw PCM audio (16-bit, 16 kHz, mono)
- **Text frames**: JSON messages for GUI events

**Server → Client** (text frames):

```json
{ "type": "gui.update",       "payload": { "sessionId": "...", "data": { ... } } }
{ "type": "gui.notification",  "payload": { "sessionId": "...", "message": "..." } }
{ "type": "ui.payload",       "payload": { "type": "choice", "requestId": "...", "data": { ... } } }
```

**Client → Server** (text frames):

```json
{ "type": "ui.response", "payload": { "requestId": "...", "selectedOptionId": "..." } }
```

GUI events published on the EventBus (`gui.update`, `gui.notification`, `subagent.ui.send`) are automatically forwarded to the connected client. Client `ui.response` messages are published back to the EventBus as `subagent.ui.response` events, closing the loop for interactive subagent UIs.

### Hooks

Lifecycle hooks for observability (logging, metrics, alerting):

```typescript
const session = new VoiceSession({
  // ...
  hooks: {
    onSessionStart: (e) => console.log(`Session started: ${e.sessionId}`),
    onSessionEnd: (e) => console.log(`Session ended after ${e.durationMs}ms`),
    onToolCall: (e) => console.log(`Tool: ${e.toolName} (${e.execution})`),
    onToolResult: (e) => console.log(`Result: ${e.status} in ${e.durationMs}ms`),
    onAgentTransfer: (e) => console.log(`${e.fromAgent} -> ${e.toAgent}`),
    onError: (e) => console.error(`[${e.component}] ${e.error.message}`),
  },
});
```

### Memory

The memory system automatically extracts durable facts about the user from conversation:

```typescript
import { MarkdownMemoryStore, MemoryDistiller } from 'bodhi-realtime-agent';

const memoryStore = new MarkdownMemoryStore('./memory');
const distiller = new MemoryDistiller(
  conversationContext,
  memoryStore,
  hooksManager,
  model,
  { userId: 'user_1', sessionId: 'session_1' },
);

// Triggers extraction every 5 turns
distiller.onTurnEnd();

// Force extraction at checkpoints (agent transfer, session close)
distiller.onCheckpoint();

// Merge duplicate/contradictory facts
await distiller.consolidate();
```

Facts are persisted as Markdown files (`memory/{userId}.md`) organized by category:

```markdown
## Preferences
- Prefers dark mode
- Likes concise answers

## Entities
- Works at Acme Corp
```

## Project Structure

```
src/
  core/              # Central orchestration
    voice-session.ts     # Top-level integration hub
    session-manager.ts   # Session state machine
    event-bus.ts         # Type-safe event system
    conversation-context.ts  # Conversation timeline + context
    conversation-history-writer.ts  # EventBus-driven persistence
    hooks.ts             # Lifecycle hook manager
    session-store.ts     # Session checkpoint persistence
    errors.ts            # Error class hierarchy
  agent/             # Agent management
    agent-router.ts      # Agent transfers and subagent handoffs
    agent-context.ts     # Runtime context for agent hooks
    subagent-runner.ts   # Background subagent execution (AI SDK)
  tools/             # Tool execution
    tool-executor.ts     # Zod validation, timeout, cancellation
  transport/         # Network layer
    gemini-live-transport.ts  # Gemini Live API WebSocket
    client-transport.ts       # Client-facing WebSocket server
    audio-buffer.ts           # Bounded ring buffer for audio
    zod-to-schema.ts          # Zod → Gemini JSON Schema converter
  memory/            # User memory
    markdown-memory-store.ts  # File-based memory persistence
    memory-distiller.ts       # LLM-powered fact extraction
    prompts.ts                # Extraction/consolidation prompt templates
  types/             # TypeScript interfaces and type definitions
test/                # Unit and integration tests (mirrors src/ structure)
examples/            # Usage examples
```

## Development

```bash
pnpm install        # Install dependencies
pnpm build          # Build with tsup (ESM + CJS + declarations)
pnpm test           # Run tests with vitest
pnpm test:watch     # Run tests in watch mode
pnpm lint           # Check with Biome
pnpm lint:fix       # Auto-fix lint issues
pnpm typecheck      # TypeScript type checking
```

### Running the Examples

```bash
# Hello World — voice pacing, agent transfer, Google Search, image/video generation
GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent.ts

# OpenClaw — voice-driven AI agent (coding, research, email, web browsing)
# Requires an OpenClaw gateway running at ws://127.0.0.1:18789
pnpm tsx examples/openclaw/openclaw-demo.ts
```

Then start the web client (`pnpm tsx examples/openclaw/web-client.ts`) and open http://localhost:8080 in Chrome. See [hello_world](examples/hello_world/) and [openclaw](examples/openclaw/) for details.

### Integration Tests

E2E tests require a Google API key and are skipped by default:

```bash
GOOGLE_API_KEY=your_key pnpm test
```

## License

[MIT](LICENSE)
