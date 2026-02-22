# VoiceSession

VoiceSession is the top-level orchestrator of the framework. Think of it as what `express()` is to Express.js — your single entry point that wires everything together.

It manages the Gemini connection, client WebSocket server, agent routing, tool execution, and conversation context in a single object.

## Basic Usage

```typescript
import { google } from '@ai-sdk/google';
import { VoiceSession } from '@bodhi_agent/realtime-agent-framework';
import type { MainAgent } from '@bodhi_agent/realtime-agent-framework';

const agent: MainAgent = {
  name: 'assistant',
  instructions: 'You are a helpful voice assistant.',
  tools: [],
};

const session = new VoiceSession({
  sessionId: `session_${Date.now()}`,
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!,
  agents: [agent],
  initialAgent: 'assistant',
  port: 9900,
  model: google('gemini-2.0-flash'),
});

await session.start();
```

## Configuration

Here's a complete configuration with all options annotated:

```typescript
const session = new VoiceSession({
  // --- Required ---
  sessionId: `session_${Date.now()}`,     // Unique session identifier
  userId: 'user_1',                        // User identifier (used for memory)
  apiKey: process.env.GEMINI_API_KEY!,     // Gemini API key
  agents: [mainAgent, expertAgent],        // All agents in this session
  initialAgent: 'main',                    // Agent to start with
  port: 9900,                              // WebSocket port for client connections
  model: google('gemini-2.0-flash'),       // Vercel AI SDK model (for subagents)

  // --- Optional: Gemini model ---
  geminiModel: 'gemini-2.5-flash-native-audio-preview',  // Native audio model

  // --- Optional: Voice ---
  speechConfig: { voiceName: 'Puck' },    // Gemini voice preset

  // --- Optional: Transcription ---
  inputAudioTranscription: true,           // Server-side user speech transcription (default: true)

  // --- Optional: Observability ---
  hooks: {
    onSessionStart: (e) => console.log(`Started: ${e.sessionId}`),
    onSessionEnd: (e) => console.log(`Ended: ${e.sessionId} (${e.reason})`),
    onToolCall: (e) => console.log(`Tool: ${e.toolName} (${e.execution})`),
    onToolResult: (e) => console.log(`Result: ${e.status} in ${e.durationMs}ms`),
    onAgentTransfer: (e) => console.log(`Transfer: ${e.fromAgent} → ${e.toAgent}`),
    onError: (e) => console.error(`[${e.component}] ${e.error.message}`),
  },

  // --- Optional: Behaviors ---
  // behaviors: [speechSpeed(), verbosity()],  // See /guide/behaviors

  // --- Optional: Persistence ---
  // memoryStore: new MarkdownMemoryStore('./memory'),
  // conversationHistoryStore: myHistoryStore,
  // sessionStore: new InMemorySessionStore(),
});
```

::: tip
You only need `sessionId`, `userId`, `apiKey`, `agents`, `initialAgent`, `port`, and `model` to get started. Everything else has sensible defaults.
:::

## Lifecycle

```
new VoiceSession(config)    →  session created, nothing running
    │
await session.start()       →  connects to Gemini, starts WebSocket server
    │
    ▼
  ACTIVE                    →  audio flowing, tools available, agents ready
    │
await session.close()       →  disconnects Gemini, stops WebSocket server
    │
    ▼
  CLOSED                    →  all resources released
```

## Session State Machine

The underlying `SessionManager` tracks connection state:

```
CREATED ──→ CONNECTING ──→ ACTIVE ──→ RECONNECTING ──→ ACTIVE
                             │                            │
                         TRANSFERRING ──→ ACTIVE        CLOSED
                             │
                           CLOSED
```

- **RECONNECTING** — Triggered by GoAway signals or unexpected disconnects. Client audio is buffered and replayed after reconnection.
- **TRANSFERRING** — Active during [agent transfers](/guide/agents). Client audio is buffered until the new agent's Gemini session is ready.

## Audio Fast-Path

Audio flows directly between the client and Gemini, bypassing the EventBus for minimal latency:

```
Client WebSocket  ──binary frames──→  ClientTransport  ──→  GeminiLiveTransport  ──→  Gemini
                  ←─binary frames──                    ←──                       ←──
```

Everything else (tool calls, agent transfers, transcripts, GUI events) goes through the control plane.

## Accessing Components

After creating a VoiceSession, you can access its components directly:

```typescript
// EventBus for subscribing to events
session.eventBus.subscribe('agent.transfer', (payload) => {
  console.log(`${payload.fromAgent} → ${payload.toAgent}`);
});

// Session state
console.log(session.sessionManager.state); // 'ACTIVE'

// Conversation context
const items = session.conversationContext.items;
```

## Shutdown

Always close sessions cleanly to release resources:

```typescript
const shutdown = async () => {
  await session.close('user_hangup');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```
