# Agents

Agents are the "personalities" of your voice application. Each agent has its own name, system instructions, tool set, and lifecycle hooks. The framework routes user conversations to the active agent and handles transfers between agents seamlessly.

## Defining an Agent

A `MainAgent` is a plain object — no classes, no inheritance:

```typescript
import type { MainAgent } from '@bodhi_agent/realtime-agent-framework';

const assistant: MainAgent = {
  name: 'assistant',
  instructions: 'You are a friendly voice assistant. Keep answers concise.',
  tools: [],
};
```

That's all you need to get started. Register it with `VoiceSession` and it becomes the voice your users hear.

## Agent Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier used for routing and transfers |
| `instructions` | `string \| () => string` | Yes | System prompt sent to the LLM |
| `tools` | `ToolDefinition[]` | Yes | Tools available when this agent is active |
| `googleSearch` | `boolean` | No | Enable Gemini's built-in Google Search grounding |
| `language` | `string` | No | BCP 47 language tag (e.g. `'zh-CN'`, `'es-ES'`) |
| `onEnter` | `(ctx) => Promise<void>` | No | Called when this agent becomes active |
| `onExit` | `(ctx) => Promise<void>` | No | Called when this agent is replaced |
| `onTurnCompleted` | `(ctx, transcript) => Promise<void>` | No | Called after each completed turn |

## Dynamic Instructions

Instructions can be a function that returns a string. This is useful when instructions depend on runtime state:

```typescript
const agent: MainAgent = {
  name: 'assistant',
  instructions: () => {
    const now = new Date().toLocaleTimeString();
    return `You are a helpful assistant. The current time is ${now}.`;
  },
  tools: [],
};
```

The function is called each time the agent connects to the LLM provider (on start, after transfers, and on reconnection).

## Agent Transfers

The framework includes a built-in `transferToAgent` tool that the model can call to switch agents. When you register multiple agents, the framework automatically makes this tool available:

```typescript
const mainAgent: MainAgent = {
  name: 'main',
  instructions: `You are a general assistant.
    If the user asks about math, transfer to the math_expert agent.`,
  tools: [],
};

const mathAgent: MainAgent = {
  name: 'math_expert',
  instructions: `You are a math tutor. Explain concepts step by step.
    When done, transfer back to the main agent.`,
  tools: [],
};

const session = new VoiceSession({
  agents: [mainAgent, mathAgent],
  initialAgent: 'main',
  // ...other config
});
```

During a transfer, the framework:

1. Calls `onExit` on the current agent
2. Updates the LLM session with the new agent's instructions and tools
   - **OpenAI**: In-place `session.update` — no reconnect needed
   - **Gemini**: Buffers client audio, disconnects, reconnects with new config, replays audio
3. Calls `onEnter` on the new agent

::: tip
Transfers are seamless to the user — they hear continuous audio. The framework handles the provider-specific mechanics behind the scenes.
:::

## Multilingual Support

Both Gemini and OpenAI's native audio models automatically detect the user's language and can respond in kind. The simplest approach is to instruct the agent to be multilingual:

```typescript
const assistant: MainAgent = {
  name: 'assistant',
  instructions: `You are a helpful, multilingual voice assistant.
    ALWAYS respond in the same language the user speaks.`,
  tools: [],
};
```

### Language-Specific Agents

For cases where you need a dedicated agent with a fixed language (e.g. a localized specialist), set the `language` property to a BCP 47 tag. The framework prepends a language directive to the system instruction:

```typescript
const japaneseSupport: MainAgent = {
  name: 'jp_support',
  language: 'ja-JP',
  instructions: '日本語のカスタマーサポート担当です。丁寧に対応してください。',
  tools: [],
};
```

## Lifecycle Hooks

Agent lifecycle hooks let you run logic at key moments. They receive an `AgentContext` with access to session state:

```typescript
const agent: MainAgent = {
  name: 'support',
  instructions: 'You are a customer support agent.',
  tools: [],

  async onEnter(ctx) {
    // Load user context when agent activates
    const facts = ctx.getMemoryFacts();
    if (facts.length > 0) {
      const summary = facts.map(f => f.content).join('; ');
      ctx.injectSystemMessage(`Known about this user: ${summary}`);
    }
  },

  async onExit(ctx) {
    // Cleanup when agent deactivates
    console.log(`Agent ${ctx.agentName} exiting session ${ctx.sessionId}`);
  },

  async onTurnCompleted(ctx, transcript) {
    // React to each completed turn
    console.log(`Turn transcript: ${transcript}`);

    const recent = ctx.getRecentTurns(3);
    // Analyze recent turns for escalation triggers, etc.
  },
};
```

### AgentContext API

| Method | Returns | Description |
|--------|---------|-------------|
| `injectSystemMessage(text)` | `void` | Add a system message visible to the model on the next turn |
| `getRecentTurns(count?)` | `ConversationItem[]` | Get the last N conversation turns (default 10) |
| `getMemoryFacts()` | `MemoryFact[]` | Get all stored memory facts for this user |

::: warning
Lifecycle hooks are async but should complete quickly — they run inline during agent transitions. Heavy work should be delegated to background tools or subagents.
:::

## Google Search Grounding

Enable Gemini's built-in Google Search to give an agent access to real-time information:

```typescript
const newsAgent: MainAgent = {
  name: 'news',
  instructions: 'You are a news reporter. Use Google Search to find current events.',
  tools: [],
  googleSearch: true,
};
```

When `googleSearch` is enabled, Gemini can ground its responses in live search results. This is handled natively by the Gemini API — no additional tool setup needed.

## Multiple Agents Example

Here's a complete multi-agent setup:

```typescript
import { VoiceSession } from '@bodhi_agent/realtime-agent-framework';
import type { MainAgent } from '@bodhi_agent/realtime-agent-framework';

const receptionist: MainAgent = {
  name: 'receptionist',
  instructions: `You are a friendly receptionist.
    Route users to the right specialist:
    - Technical questions → transfer to "tech_support"
    - Billing questions → transfer to "billing"`,
  tools: [],
};

const techSupport: MainAgent = {
  name: 'tech_support',
  instructions: `You are a technical support specialist.
    Help users debug issues. When done, transfer back to "receptionist".`,
  tools: [/* diagnostic tools */],
  googleSearch: true,
};

const billing: MainAgent = {
  name: 'billing',
  instructions: `You are a billing specialist.
    Help with invoices and payments. Transfer back to "receptionist" when done.`,
  tools: [/* billing tools */],
};

const session = new VoiceSession({
  agents: [receptionist, techSupport, billing],
  initialAgent: 'receptionist',
  // ...other config
});
```
