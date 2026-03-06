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

To integrate the framework into your own backend: use `MultiClientTransport` to accept WebSockets, build a `SessionClientSender` per connection, and create a `VoiceSession` with that sender plus your agents and tools. A reference app (server + web client) lives in **app/** — see **app/README.md** for how to run it.

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

The memory system automatically extracts durable facts about the user from conversation using a merge-on-write strategy — each extraction produces the complete updated fact list (deduped, contradictions resolved):

```typescript
import { JsonMemoryStore } from '@bodhi_agent/realtime-agent-framework';

const session = new VoiceSession({
  // ...required config
  memory: {
    store: new JsonMemoryStore('./memory'),
  },
});
```

Facts are persisted as JSON files (`memory/{userId}.json`) with structured directives and categorized facts:

```json
{
  "directives": { "pacing": "slow" },
  "facts": [
    { "content": "Prefers dark mode", "category": "preference" },
    { "content": "Works at Acme Corp", "category": "entity" }
  ]
}
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
    json-memory-store.ts      # JSON file-based memory persistence
    memory-distiller.ts       # LLM-powered fact extraction (merge-on-write)
    prompts.ts                # Extraction prompt template
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

### Integration Tests

E2E tests require a Google API key and are skipped by default:

```bash
GOOGLE_API_KEY=your_key pnpm test
```

## License

UNLICENSED
