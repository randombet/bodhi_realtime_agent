# Subagents

Subagents run in the background using the Vercel AI SDK while the voice model continues speaking to the user. They handle long-running operations that would otherwise block the voice stream.

## Why Subagents?

The Realtime API is real-time — when you call an inline tool, the voice stream pauses until the tool returns. For operations that take more than a couple of seconds (report generation, multi-step workflows, coding tasks), subagents let the conversation continue naturally:

```
User: "Generate a sales report for Q4"

Without subagents:     [silence for 15 seconds...]  "Here's your report."
With subagents:        "I'm generating that report now." [continues chatting] "Your report is ready!"
```

## Architecture

Subagents are the **background layer** of Bodhi's two-level agent model:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         VoiceSession                                │
│                                                                     │
│  ┌─────────────┐   tool call    ┌──────────────┐                   │
│  │  Main Agent  │ ────────────► │ ToolCallRouter│                   │
│  │  (Gemini /   │               │              │                   │
│  │   OpenAI)    │ ◄──────────── │  inline: run  │                   │
│  └─────────────┘   tool result  │  background:  │                   │
│                                 │   handoff ──► AgentRouter         │
│                                 └──────────────┘       │            │
│                                                        ▼            │
│                                               ┌────────────────┐   │
│                                               │  runSubagent() │   │
│                                               │  (Vercel AI    │   │
│                                               │   generateText)│   │
│                                               └────────────────┘   │
│                                                        │            │
│                                              ┌─────────┴─────────┐ │
│                                              │ SubagentConfig     │ │
│                                              │ .tools (AI SDK)    │ │
│                                              │ .instructions      │ │
│                                              │ .maxSteps          │ │
│                                              └───────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Key separation:** Main agents own the voice session (bidirectional audio). Subagents are text-only LLM calls that run concurrently and report results back through the main agent.

## Subagent Lifecycle

### Non-Interactive (Task) Subagent

The simplest lifecycle — fire, execute, deliver result:

```
1. User speaks → Main LLM calls background tool
2. ToolCallRouter sends pendingMessage to LLM immediately
3. LLM says "Working on it..." while subagent runs
4. ToolCallRouter records tool call in ConversationContext
5. AgentRouter.handoff() assembles context snapshot
6. runSubagent() runs Vercel AI SDK generateText() with tools
7. onStepFinish fires hooks.onSubagentStep per LLM step
8. Result returned → ToolCallRouter delivers via NotificationQueue
9. NotificationQueue flushes at next turn boundary
10. Main LLM speaks the result to user
```

**Result delivery** uses one of two strategies:
- **With `pendingMessage`**: LLM already responded with "working on it". The result is injected as a system notification, queued until the LLM finishes its current turn, then flushed one at a time.
- **Without `pendingMessage`**: Result sent as a deferred tool response (`scheduling: 'when_idle'`). The LLM processes it at the next natural pause.

### Interactive Subagent

Extends the task lifecycle with bidirectional user communication. The subagent can ask the user questions via voice and wait for answers.

```
 ┌─────────────────────────────────────────────────────┐
 │                  SubagentSession                     │
 │                                                     │
 │  State machine:                                     │
 │                                                     │
 │  running ──► waiting_for_input ──► running ──► ...  │
 │      │              │                          │    │
 │      │              ▼                          ▼    │
 │      └──────► cancelled          completed          │
 │                                                     │
 └─────────────────────────────────────────────────────┘
```

**Additional steps beyond the task lifecycle:**

1. `AgentRouter.handoff()` creates a `SubagentSessionImpl` when `config.interactive === true`.
2. `runSubagent()` injects an `ask_user` tool into the subagent's tool set at runtime.
3. When the subagent calls `ask_user`:
   - The question is delivered to the main LLM as a system notification
   - `InteractionModeManager` activates — user transcript is now routed to the subagent instead of the main LLM
   - If structured `options` are provided, a UI payload is sent to the client for button rendering
4. User responds (voice or button click):
   - Voice: `TranscriptManager` routes finalized text to `SubagentSession.sendToSubagent()`
   - Button: `EventBus` routes `subagent.ui.response` → `session.resolveOption()` → `session.sendToSubagent()`
5. `InteractionModeManager` deactivates — transcript routing returns to main LLM
6. The `ask_user` tool returns `{ userResponse: "..." }` and the subagent continues

**Interaction mode queue:** Only one subagent can own user transcript at a time. If multiple subagents try to ask questions concurrently, they're queued FIFO. Each waits for `activate()` to resolve before `ask_user` delivers its question.

**Timeout and retry:** Each `waitForInput()` call has a 2-minute timeout. On timeout, the tool returns an error message to the subagent (not thrown). After 3 consecutive timeouts, the subagent is aborted.

## SubagentConfig Reference

```typescript
interface SubagentConfig {
  /** Unique identifier for this subagent. */
  name: string;

  /** System prompt — tells the subagent what to do. */
  instructions: string;

  /** Vercel AI SDK tool() definitions available to the subagent. */
  tools: Record<string, unknown>;

  /** Max LLM reasoning steps (default: 5). */
  maxSteps?: number;

  /** Total execution timeout in ms (default: 600,000 — 10 min). */
  timeout?: number;

  /** Override the LLM model for this subagent. */
  model?: string;

  /** Enable interactive user communication via SubagentSession. */
  interactive?: boolean;

  /**
   * Factory that returns an isolated config instance per handoff.
   * Use when subagent state must not be shared across concurrent runs.
   */
  createInstance?: () => SubagentConfig;

  /** Cleanup hook — called on completion, error, or abort. */
  dispose?: () => Promise<void> | void;
}
```

**Interactive extensions** (when `interactive: true`):

```typescript
interface InteractiveSubagentConfig extends SubagentConfig {
  /** Per-question timeout in ms (default: 120,000 — 2 min). */
  inputTimeout?: number;
  /** Max consecutive timeouts before abort (default: 3). */
  maxInputRetries?: number;
}
```

## Context Snapshot

Every subagent receives a `SubagentContextSnapshot` assembled from `ConversationContext`:

```typescript
interface SubagentContextSnapshot {
  task: SubagentTask;                 // Tool name, args, and description
  conversationSummary: string | null; // Compressed history (if available)
  recentTurns: ConversationItem[];    // Last 10 turns
  relevantMemoryFacts: MemoryFact[];  // Persistent user facts
  agentInstructions: string;          // Subagent's own instructions
}
```

This is assembled into a system prompt:

```
# Instructions
<subagent instructions>

# Task
Execute tool: ask_claude
# Task Arguments
{ "task": "Fix the bug in auth.py" }

# Conversation Summary
User asked about their project. Discussed auth module.

# Recent Conversation
[user]: Can you fix the auth bug?
[assistant]: I'll have Claude look into that.

# Relevant Memory
- User prefers TypeScript
- Project uses PostgreSQL
```

## Patterns

### Pattern 1: Task Subagent

Fire-and-forget background work. The simplest pattern.

```typescript
import { z } from 'zod';
import { tool } from 'ai';
import type { ToolDefinition, SubagentConfig } from '@bodhi_agent/realtime-agent-framework';

// Background tool the model calls
const generateReport: ToolDefinition = {
  name: 'generate_report',
  description: 'Generate an analytics report for a date range',
  parameters: z.object({
    dateRange: z.string().describe('e.g. "last 7 days", "Q4 2024"'),
  }),
  execution: 'background',
  pendingMessage: "I'm generating the report now. I'll let you know when it's ready.",
  async execute(args) {
    return { dateRange: args.dateRange };
  },
};

// Subagent that does the work
const reportSubagent: SubagentConfig = {
  name: 'report_generator',
  instructions: 'You are a data analyst. Generate clear, actionable reports.',
  tools: {
    query_analytics: tool({
      description: 'Query the analytics database',
      parameters: z.object({ dateRange: z.string() }),
      execute: async ({ dateRange }) => {
        const data = await analytics.query(dateRange);
        return { summary: data.summary, rows: data.rows };
      },
    }),
  },
  maxSteps: 5,
  timeout: 60_000,
};

// Wire them together in VoiceSession
const session = new VoiceSession({
  agents: [mainAgent],
  subagentConfigs: {
    generate_report: reportSubagent, // key matches tool name
  },
});
```

### Pattern 2: Interactive Subagent

Background work that can ask the user questions via voice. The framework injects an `ask_user` tool automatically when `interactive: true`.

```typescript
const bookRide: ToolDefinition = {
  name: 'book_ride',
  description: 'Book a ride for the user',
  parameters: z.object({
    destination: z.string(),
  }),
  execution: 'background',
  pendingMessage: 'Let me set up that ride for you.',
  async execute(args) {
    return { destination: args.destination };
  },
};

const rideSubagent: SubagentConfig = {
  name: 'ride_booker',
  instructions: `You book rides. Steps:
1. Call get_ride_options with the destination.
2. Call ask_user to let the user pick an option. Pass structured options.
3. Call confirm_ride with their choice.`,
  tools: {
    get_ride_options: tool({
      description: 'Get available ride options',
      parameters: z.object({ destination: z.string() }),
      execute: async ({ destination }) => {
        return [
          { id: 'economy', name: 'Economy', price: '$12', eta: '5 min' },
          { id: 'premium', name: 'Premium', price: '$24', eta: '3 min' },
        ];
      },
    }),
    confirm_ride: tool({
      description: 'Confirm and book the selected ride',
      parameters: z.object({ rideType: z.string() }),
      execute: async ({ rideType }) => ({ status: 'confirmed', rideType }),
    }),
    // ask_user is injected automatically — do not define it
  },
  interactive: true,   // Enables SubagentSession + ask_user injection
  maxSteps: 10,
  timeout: 300_000,
};
```

The subagent calls `ask_user` like any other tool:

```
Subagent LLM step 1: calls get_ride_options → gets options
Subagent LLM step 2: calls ask_user({
  question: "I found two options: Economy at $12 (5 min) or Premium at $24 (3 min). Which do you prefer?",
  options: [
    { id: "opt_0", label: "Economy", description: "$12, arrives in 5 min" },
    { id: "opt_1", label: "Premium", description: "$24, arrives in 3 min" }
  ]
})
→ User hears the question via voice
→ Client shows buttons (if UI supports it)
→ User says "Economy" or clicks the button
→ ask_user returns { userResponse: "Economy" }
Subagent LLM step 3: calls confirm_ride({ rideType: "economy" })
Subagent LLM step 4: returns summary text
```

### Pattern 3: Relay Subagent

A **relay subagent** bridges the voice assistant to a stateful external agent. It manages the external agent's session lifecycle and translates between the voice event-driven model and the external agent's request-response model.

This pattern is used when:
- The external agent is stateful (multi-turn, session-based)
- The external agent may ask follow-up questions
- You need per-handoff session isolation

```
Main LLM (Gemini)
  │ tool call: ask_claude
  ▼
ToolCallRouter → AgentRouter.handoff()
  │
  ▼
Relay Subagent (Vercel AI SDK generateText)
  │ tools: agent_start, agent_respond, ask_user
  │
  ▼
External Agent SDK (e.g. Claude Agent SDK)
  │ query() / respond()
  ▼
Local filesystem, APIs, MCP servers, etc.
```

**Relay subagent tools:**
- `agent_start` — Create a new external session, send the task, return result or question
- `agent_respond` — Send user's answer to a paused session, return result or next question
- `ask_user` — (injected by framework) Relay questions from external agent to user via voice

**Relay workflow:**
1. Relay calls `agent_start({ task })` → external agent runs
2. If external agent completes → relay summarizes result
3. If external agent asks a question → relay calls `ask_user` to get user's answer
4. Relay calls `agent_respond({ sessionId, response })` → external agent continues
5. Repeat until complete

**Session isolation with `createInstance()`:**

When the main LLM re-issues a background tool (e.g., on a new user turn while the first run is still in progress), each handoff needs its own session state. The `createInstance()` factory creates a fresh config with isolated internal state:

```typescript
export function createMyRelayConfig(options: MyOptions): SubagentConfig {
  // Each call creates a fresh sessions Map — no cross-talk
  const sessions = new Map<string, ExternalSession>();

  return {
    name: 'my-relay',
    instructions: RELAY_INSTRUCTIONS,
    tools: {
      agent_start: tool({ /* ... uses sessions Map */ }),
      agent_respond: tool({ /* ... uses sessions Map */ }),
    },
    interactive: true,
    createInstance: () => createMyRelayConfig(options), // Fresh instance per handoff
    async dispose() {
      // Abort all active external sessions
      await Promise.allSettled([...sessions.values()].map(s => s.abort()));
      sessions.clear();
    },
  };
}
```

See [Claude Code Demo](#claude-code-demo) for a complete relay subagent implementation.

### Pattern 4: Service Subagent

Service subagents monitor external systems and proactively notify the user. They run for the entire session, reacting to webhooks, database changes, or polling results.

```typescript
import type { ServiceSubagentConfig, EventSourceConfig } from '@bodhi_agent/realtime-agent-framework';

const orderEvents: EventSourceConfig = {
  name: 'order-webhook',
  start(emit, signal) {
    const server = createWebhookListener((event) => {
      emit({
        source: 'webhook',
        type: 'order.status_changed',
        data: event,
        priority: event.urgent ? 'urgent' : 'normal',
      });
    });
    signal.addEventListener('abort', () => server.close());
  },
};

const orderMonitor: ServiceSubagentConfig = {
  agent: {
    name: 'order_monitor',
    instructions: 'Monitor order status and notify user of important updates.',
    tools: {},
    maxSteps: 3,
  },
  eventSources: [orderEvents],
  shouldInvoke: (event) => event.type === 'order.status_changed',
};
```

**Event priority:** `normal` events are queued and delivered at the next turn boundary. `urgent` events may interrupt the current turn (transport-dependent).

## Concurrent Execution

Multiple background tools can run in parallel. Each gets its own `AbortController` and (if interactive) `SubagentSession`:

```
User: "Fix the auth bug and generate an image of a sunset"

Main LLM: calls ask_claude and generate_image simultaneously

ask_claude subagent ──────────────────────► result queued
                                                ↓
generate_image subagent ──────► result queued   ↓
                                    ↓           ↓
                                    flush at turn boundary (one at a time)
```

**Isolation:** Use `createInstance()` when subagent state must not leak between concurrent runs. Without it, all runs of the same tool share the same `SubagentConfig` object (and its closures).

**Notification pacing:** Results are flushed one per turn boundary to avoid overwhelming the user with a burst of audio notifications.

## Error Handling

| Error | Behavior |
|-------|----------|
| Subagent timeout | `AbortController` fires → `generateText` aborted → error tool result delivered |
| `ask_user` input timeout | Returns `{ error: "..." }` to subagent (retryable). After 3 consecutive timeouts → abort |
| User disconnect | `SubagentSession.cancel()` → rejects pending `waitForInput()` → `CancelledError` |
| Agent transfer mid-subagent | Subagent continues running (tracked by `toolCallId`, not agent name) |
| `dispose()` guarantee | Always called in `runSubagent()` finally block — success, error, or abort |

## Observability

Track subagent execution via the `onSubagentStep` hook:

```typescript
hooks: {
  onSubagentStep: (e) => {
    console.log(
      `[${e.subagentName}] Step ${e.stepNumber}: ${e.toolCalls.join(', ')} (${e.tokensUsed} tokens)`
    );
  },
}
```

## Claude Code Demo

The `examples/claude_code/claude-demo.ts` example implements a complete relay subagent that delegates coding tasks to Claude Code (Anthropic's AI coding agent). Claude has full codebase access — read, edit, create files, run commands, search code, and send emails via Apple Mail.

### Architecture

```
User speaks ──► Gemini Live (main LLM)
                    │
                    │ tool call: ask_claude({ task: "Fix the auth bug" })
                    ▼
              ToolCallRouter
                    │ background handoff (with createInstance isolation)
                    ▼
              Relay Subagent (Gemini Flash via Vercel AI SDK)
                    │
                    │ tool call: claude_code_start({ task: "Fix the auth bug" })
                    ▼
              ClaudeCodeSession (wraps Claude Agent SDK query())
                    │
                    │ Claude Code runs: reads files, edits code, runs tests
                    │
                    ├── completed → relay summarizes for voice
                    ├── needs_input → relay calls ask_user → user answers via voice
                    └── error → relay reports error
```

### Key Components

**`ClaudeCodeSession`** (`examples/claude_code/claude-code-client.ts`) — Stateful wrapper around the Claude Agent SDK's `query()` function. Manages the async generator lifecycle and translates SDK messages into simple `{ status, text, question }` results.

**`createClaudeCodeSubagentConfig()`** (`examples/claude_code/claude-code-tools.ts`) — Factory that creates the relay `SubagentConfig` with `claude_code_start` and `claude_code_respond` tools, plus `createInstance()` for concurrent isolation.

**MCP integration** — Claude Code can use MCP (Model Context Protocol) servers for additional capabilities. The demo includes an email MCP server that sends email via Apple Mail.app:

```typescript
const claudeSubagent = createClaudeCodeSubagentConfig({
  projectDir: PROJECT_DIR,
  mcpServerFactory: () => ({
    email: createSdkMcpServer({
      name: 'email',
      tools: [mcpTool('send_email', 'Send email via Mail.app', schema, handler)],
    }),
  }),
  extraAllowedTools: ['mcp__email__*'],
});
```

`mcpServerFactory` creates fresh MCP Protocol instances per session because the SDK's Protocol can only be connected to one transport at a time.

### Running the Demo

```bash
# Set API keys
export GEMINI_API_KEY="your-gemini-key"
export ANTHROPIC_API_KEY="your-anthropic-key"

# Optional: set Claude's working directory
export PROJECT_DIR="/path/to/your/project"

# Start the voice agent
pnpm tsx examples/claude_code/claude-demo.ts

# In another terminal, start the web client
pnpm tsx examples/web-client.ts

# Open http://localhost:8080 in Chrome
```

### Things to Try

| Say this | What happens |
|----------|-------------|
| "Fix the bug in auth.py" | Claude reads files, edits code, runs tests |
| "Add input validation to the login form" | Claude creates/modifies files |
| "Run the tests and fix any failures" | Claude runs commands and iterates |
| "Summarize the README and email it to me" | Claude reads files + sends email via Mail.app |
| "What's the weather in San Francisco?" | Google Search (handled by Gemini natively) |
| "Draw me a picture of a sunset" | Image generation subagent |
| "Goodbye" | Graceful session end |
