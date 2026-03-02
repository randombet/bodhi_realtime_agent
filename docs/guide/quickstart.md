# Quick Start

Build a working voice agent in 5 minutes. By the end, you'll have an agent that listens to your voice and responds in real time.

## Step 1: Install

```bash
pnpm add @bodhi_agent/realtime-agent-framework @ai-sdk/google zod
```

## Step 2: Get an API Key

1. Go to [Google AI Studio](https://aistudio.google.com/)
2. Create an API key with Gemini Live API access
3. Set it as an environment variable:

```bash
export GEMINI_API_KEY="your-key-here"
```

## Step 3: Define Your First Agent

An agent is a persona with instructions and optional tools. Here's the simplest possible agent:

```typescript
import type { MainAgent } from '@bodhi_agent/realtime-agent-framework';

const assistant: MainAgent = {
  name: 'assistant',
  instructions: 'You are a helpful voice assistant. Be concise and friendly.',
  tools: [],
};
```

## Step 4: Create and Start a Session

A `VoiceSession` wires together the agent, LLM transport, and client WebSocket server. This example uses Gemini — see [Using OpenAI](#using-openai-instead) below for the alternative:

```typescript
import { google } from '@ai-sdk/google';
import { VoiceSession } from '@bodhi_agent/realtime-agent-framework';

const session = new VoiceSession({
  sessionId: `session_${Date.now()}`,
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!,
  agents: [assistant],
  initialAgent: 'assistant',
  port: 9900,
  model: google('gemini-2.5-flash'),
});

await session.start();
console.log('Voice agent running on ws://localhost:9900');
```

## Step 5: Connect a Client

Connect any WebSocket client that sends PCM audio to `ws://localhost:9900`. The built-in [web client](/guide/running-examples) handles this for you — it auto-negotiates the correct sample rate for either Gemini or OpenAI.

## Putting It All Together

Create a file called `my-agent.ts`:

```typescript
import { google } from '@ai-sdk/google';
import { VoiceSession } from '@bodhi_agent/realtime-agent-framework';
import type { MainAgent } from '@bodhi_agent/realtime-agent-framework';

const assistant: MainAgent = {
  name: 'assistant',
  instructions: 'You are a helpful voice assistant. Be concise and friendly.',
  tools: [],
};

const session = new VoiceSession({
  sessionId: `session_${Date.now()}`,
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!,
  agents: [assistant],
  initialAgent: 'assistant',
  port: 9900,
  model: google('gemini-2.5-flash'),
});

await session.start();
console.log('Voice agent running on ws://localhost:9900');
console.log('Press Ctrl+C to stop.');

process.on('SIGINT', async () => {
  await session.close();
  process.exit(0);
});
```

Run it:

```bash
pnpm tsx my-agent.ts
```

You should see:

```
Voice agent running on ws://localhost:9900
Press Ctrl+C to stop.
```

## What's Next: Add a Tool

Tools let your agent do things — check the time, calculate math, search the web. Here's how to add a simple one:

```typescript
import { z } from 'zod';
import type { ToolDefinition } from '@bodhi_agent/realtime-agent-framework';

const getCurrentTime: ToolDefinition = {
  name: 'get_current_time',
  description: 'Get the current date and time.',
  parameters: z.object({
    timezone: z.string().optional().describe('Timezone (e.g., "UTC", "America/New_York")'),
  }),
  execution: 'inline',
  execute: async (args) => {
    const { timezone } = args as { timezone?: string };
    return {
      time: new Date().toLocaleString('en-US', {
        timeZone: timezone ?? undefined,
        dateStyle: 'full',
        timeStyle: 'long',
      }),
    };
  },
};

// Add it to your agent
const assistant: MainAgent = {
  name: 'assistant',
  instructions: 'You are a helpful voice assistant. Use get_current_time when asked about the time.',
  tools: [getCurrentTime], // <-- tools go here
};
```

Now when you say "What time is it?", the agent will call the tool and speak the result.

::: tip
Read the full [Tools guide](/guide/tools) to learn about inline vs background execution, Zod schemas, timeout, cancellation, and Google Search grounding.
:::

## Using OpenAI Instead

To use OpenAI's Realtime API instead of Gemini, inject a pre-configured `OpenAIRealtimeTransport`:

```typescript
import { google } from '@ai-sdk/google';
import { VoiceSession, OpenAIRealtimeTransport } from '@bodhi_agent/realtime-agent-framework';

const transport = new OpenAIRealtimeTransport({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-realtime-preview',
  voice: 'coral',
});

const session = new VoiceSession({
  sessionId: `session_${Date.now()}`,
  userId: 'user_1',
  apiKey: 'unused',              // Not needed when using a custom transport
  agents: [assistant],
  initialAgent: 'assistant',
  port: 9900,
  model: google('gemini-2.5-flash'),  // Subagent model (still needed)
  transport,                     // Inject the OpenAI transport
});

await session.start();
```

Your agent code (instructions, tools, lifecycle hooks) is identical — only the transport differs. See [Transport](/guide/transport) for details on provider differences.

## Next Steps

- [Running Examples](/guide/running-examples) — Try the full demos with Gemini or OpenAI
- [Agents](/guide/agents) — Learn about multi-agent systems and transfers
- [Tools](/guide/tools) — Explore inline, background, and built-in tools
- [Transport](/guide/transport) — Understand provider differences and audio format negotiation
