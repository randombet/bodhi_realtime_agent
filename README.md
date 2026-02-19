# Bodhi Realtime Agent Framework

TypeScript framework for building real-time voice agent applications using the Google Gemini Live API.

## Features

- **Real-time voice**: Bidirectional audio streaming with Gemini Live API and server-side turn detection
- **Multi-agent**: Define multiple agents with distinct personas and tool sets; transfer between them mid-conversation
- **Function tools**: Inline (blocking) and background (non-blocking) tool execution with Zod validation
- **Background subagents**: Long-running tool calls hand off to Vercel AI SDK subagents while Gemini keeps talking
- **Memory**: Automatic extraction and persistence of durable user facts across sessions
- **Session resumption**: Transparent reconnection via Gemini resumption handles and audio buffering
- **Observability**: Type-safe EventBus and lifecycle hooks for logging, metrics, and debugging

## Requirements

- Node.js >= 22
- A Google API key with Gemini Live API access
- pnpm (recommended)

## Installation

```bash
pnpm add @bodhi_agent/realtime-agent-framework
```

## Quick Start

```typescript
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { VoiceSession } from '@bodhi_agent/realtime-agent-framework';
import type { MainAgent, ToolDefinition } from '@bodhi_agent/realtime-agent-framework';

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
  model: google('gemini-2.0-flash'),
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
import { MarkdownMemoryStore, MemoryDistiller } from '@bodhi_agent/realtime-agent-framework';

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
app/                 # Usage examples
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

### Running the Example

```bash
export GOOGLE_API_KEY=your_api_key
pnpm tsx app/gemini-realtime-tools.ts
```

Then connect a WebSocket audio client to `ws://localhost:9900` sending PCM 16-bit 16kHz mono audio.

### Integration Tests

E2E tests require a Google API key and are skipped by default:

```bash
GOOGLE_API_KEY=your_key pnpm test
```

## License

[MIT](LICENSE)
