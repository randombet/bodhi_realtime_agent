# Subagent Patterns

Subagents run in the background using the Vercel AI SDK while the voice model continues speaking to the user. They handle long-running operations that would otherwise block the voice stream.

## Why Subagents?

The Realtime API is real-time — when you call an inline tool, the voice stream pauses until the tool returns. For operations that take more than a couple of seconds (report generation, multi-step workflows, image creation), subagents let the conversation continue naturally:

```
User: "Generate a sales report for Q4"

Without subagents:     [silence for 15 seconds...]  "Here's your report."
With subagents:        "I'm generating that report now." [continues chatting] "Your report is ready!"
```

## Three Patterns

The framework supports three subagent patterns, each for a different use case:

| Pattern | Use Case | Trigger | Example |
|---------|----------|---------|---------|
| **Task** | Fire-and-forget background work | Background tool call | Generate report, process file |
| **Interactive** | Background work with UI | Background tool call + GUI events | Show confirmation dialog, display image |
| **Service** | Persistent event monitoring | External events (webhooks, polling) | Order notifications, alert monitoring |

## Pattern 1: Task Subagent

The simplest pattern. A background tool triggers a subagent that runs to completion and sends the result back to the voice model.

### Setup

Define a background tool and a `SubagentConfig`:

```typescript
import { z } from 'zod';
import type { ToolDefinition, SubagentConfig } from '@bodhi_agent/realtime-agent-framework';

// The tool the model calls
const generateReport: ToolDefinition = {
  name: 'generate_report',
  description: 'Generate an analytics report for a date range',
  parameters: z.object({
    dateRange: z.string().describe('e.g. "last 7 days", "Q4 2024"'),
    format: z.enum(['summary', 'detailed']).default('summary'),
  }),
  execution: 'background',
  pendingMessage: 'I\'m generating the report now. I\'ll let you know when it\'s ready.',
  timeout: 60_000,
  async execute(args) {
    const data = await analytics.query(args.dateRange);
    return { summary: data.summary, chartUrl: data.chartUrl };
  },
};

// The subagent that runs the tool
const reportSubagent: SubagentConfig = {
  name: 'report_generator',
  instructions: 'You are a data analyst. Generate clear, actionable reports.',
  tools: { /* Vercel AI SDK tool definitions */ },
  maxSteps: 5,
  timeout: 60_000,
};
```

### How It Works

```
1. User says "Generate a Q4 report"
2. Model calls generate_report tool
3. Framework sends pendingMessage to model immediately
4. Model says "I'm working on that report..."
5. Subagent runs in background (up to 5 LLM steps)
6. Result is sent back to model as a tool response
7. Model says "Your report is ready! Here's the summary..."
```

## Pattern 2: Interactive Subagent

Extends the task pattern with UI delivery. The subagent can send structured UI payloads to the client (forms, confirmations, images) and receive responses back.

### GUI Event Flow

```
Subagent → EventBus (subagent.ui.send) → ClientTransport → Client UI
Client UI → ClientTransport → EventBus (subagent.ui.response) → Subagent
```

### UIPayload Types

The framework supports five UI payload types:

| Type | Use Case | Example |
|------|----------|---------|
| `choice` | Multiple-choice selection | "Which account?" |
| `confirmation` | Yes/no decision | "Confirm order?" |
| `status` | Progress indicator | "Processing step 3 of 5" |
| `form` | Structured data input | Address form |
| `image` | Display generated image | Product visualization |

### Example

```typescript
const orderTool: ToolDefinition = {
  name: 'place_order',
  description: 'Place an order with confirmation',
  parameters: z.object({ productId: z.string(), quantity: z.number() }),
  execution: 'background',
  pendingMessage: 'Let me prepare that order for you.',
  async execute(args, ctx) {
    // Send confirmation UI to client
    ctx.sendJsonToClient?.({
      type: 'ui.payload',
      payload: {
        type: 'confirmation',
        requestId: ctx.toolCallId,
        data: {
          message: `Order ${args.quantity}x product ${args.productId}?`,
          productId: args.productId,
          quantity: args.quantity,
        },
      },
    });

    // The subagent would wait for ui.response from the client
    // and then proceed based on the user's choice
    return { status: 'order_placed', orderId: 'ORD-123' };
  },
};
```

## Pattern 3: Service Subagent

Service subagents monitor external systems and proactively notify the user. They run for the entire session, reacting to webhooks, database changes, or polling results.

### Setup

```typescript
import type { ServiceSubagentConfig, EventSourceConfig } from '@bodhi_agent/realtime-agent-framework';

// Define an event source (e.g. webhook listener)
const orderEvents: EventSourceConfig = {
  name: 'order-webhook',
  start(emit, signal) {
    // Listen for webhook events
    const server = createWebhookListener((event) => {
      emit({
        source: 'webhook',
        type: 'order.status_changed',
        data: event,
        priority: event.urgent ? 'urgent' : 'normal',
      });
    });

    // Clean up when session closes
    signal.addEventListener('abort', () => server.close());
  },
  async stop() {
    // Graceful shutdown
  },
};

// Configure the service subagent
const orderMonitor: ServiceSubagentConfig = {
  agent: {
    name: 'order_monitor',
    instructions: 'You monitor order status changes and notify the user of important updates.',
    tools: {},
    maxSteps: 3,
  },
  eventSources: [orderEvents],
  shouldInvoke(event) {
    // Only invoke for status changes, not every event
    return event.type === 'order.status_changed';
  },
};
```

### Event Priority

Events can be `normal` or `urgent`:

| Priority | Behavior |
|----------|----------|
| `normal` | Notification queued, delivered at next turn boundary |
| `urgent` | May interrupt the current turn to notify immediately |

## SubagentConfig Reference

```typescript
interface SubagentConfig {
  name: string;           // Unique identifier
  instructions: string;   // System prompt for the subagent's LLM
  tools: Record<string, unknown>;  // Vercel AI SDK tool definitions
  maxSteps?: number;      // Max LLM steps (default 5)
  timeout?: number;       // Execution timeout in ms
  model?: string;         // Override session model
}
```

## Context Snapshot

Every subagent receives a `SubagentContextSnapshot` with the current conversation state:

```typescript
interface SubagentContextSnapshot {
  task: SubagentTask;                // What to do
  conversationSummary: string | null; // Compressed history
  recentTurns: ConversationItem[];   // Last few turns
  relevantMemoryFacts: MemoryFact[]; // User memory
  agentInstructions: string;         // Subagent's own instructions
}
```

This gives the subagent full context without direct access to the voice session.

## Observability

Track subagent execution via the `onSubagentStep` hook:

```typescript
hooks: {
  onSubagentStep: (e) => {
    console.log(`[${e.subagentName}] Step ${e.stepNumber}: ${e.toolCalls.join(', ')} (${e.tokensUsed} tokens)`);
  },
}
```
