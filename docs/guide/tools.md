# Tools

Tools let your voice agent take actions in the real world — look up data, call APIs, control devices, generate images. You define tools with a Zod schema, and the framework handles declaration, validation, and execution automatically.

## Defining a Tool

A tool is a plain object that implements `ToolDefinition`:

```typescript
import { z } from 'zod';
import type { ToolDefinition } from '@bodhi_agent/realtime-agent-framework';

const getWeather: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: z.object({
    city: z.string().describe('City name'),
  }),
  execution: 'inline',
  async execute(args) {
    const res = await fetch(`https://api.weather.com/v1/${args.city}`);
    const data = await res.json();
    return { temperature: data.temp, conditions: data.description };
  },
};
```

Then register it with an agent:

```typescript
const agent: MainAgent = {
  name: 'assistant',
  instructions: 'You are a helpful assistant with access to weather data.',
  tools: [getWeather],
};
```

## Tool Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier (used by Gemini to call the tool) |
| `description` | `string` | Yes | Tells the model when and why to use this tool |
| `parameters` | `z.ZodSchema` | Yes | Zod schema for argument validation and declaration |
| `execution` | `'inline' \| 'background'` | Yes | How the tool runs relative to the audio stream |
| `pendingMessage` | `string` | No | For background tools: immediate response to Gemini |
| `timeout` | `number` | No | Execution timeout in ms (default 30,000) |
| `execute` | `(args, ctx) => Promise<unknown>` | Yes | The function that does the work |

## Inline vs Background Execution

The `execution` mode controls whether Gemini waits for the result or keeps talking:

### Inline Tools

Gemini pauses its response and waits for the result. Use for fast lookups (< 2 seconds):

```typescript
const lookupUser: ToolDefinition = {
  name: 'lookup_user',
  description: 'Look up a user by email address',
  parameters: z.object({
    email: z.string().email(),
  }),
  execution: 'inline',
  async execute(args) {
    const user = await db.users.findByEmail(args.email);
    return { name: user.name, plan: user.plan };
  },
};
```

### Background Tools

Gemini receives a `pendingMessage` immediately and continues speaking while the tool runs asynchronously via a [subagent](/advanced/subagents):

```typescript
const generateReport: ToolDefinition = {
  name: 'generate_report',
  description: 'Generate a detailed analytics report',
  parameters: z.object({
    dateRange: z.string().describe('Date range like "last 7 days"'),
  }),
  execution: 'background',
  pendingMessage: 'I\'m generating the report now. This may take a moment.',
  timeout: 60_000,
  async execute(args) {
    const data = await analytics.query(args.dateRange);
    const report = await generatePDF(data);
    return { url: report.url, summary: report.summary };
  },
};
```

::: tip When to use which?
- **Inline**: Database lookups, API calls under 2s, calculations
- **Background**: Report generation, file processing, image generation, multi-step workflows
:::

## Tool Context

Every tool receives a `ToolContext` as its second argument, providing session information and an abort signal:

```typescript
const myTool: ToolDefinition = {
  name: 'my_tool',
  description: 'A tool that uses context',
  parameters: z.object({ query: z.string() }),
  execution: 'inline',
  async execute(args, ctx) {
    // ctx.toolCallId      — unique ID for this invocation
    // ctx.agentName       — which agent owns this tool
    // ctx.sessionId       — current session ID
    // ctx.abortSignal     — aborted on timeout or user interruption
    // ctx.sendJsonToClient — send JSON to the connected client
    // ctx.setDirective    — set a per-turn directive (see below)

    const res = await fetch(`/api/search?q=${args.query}`, {
      signal: ctx.abortSignal,  // Automatically cancels if user interrupts
    });
    return res.json();
  },
};
```

### Sending GUI Updates from Tools

Tools can send JSON messages directly to the connected client using `ctx.sendJsonToClient`:

```typescript
const processOrder: ToolDefinition = {
  name: 'process_order',
  description: 'Process a customer order',
  parameters: z.object({ orderId: z.string() }),
  execution: 'inline',
  async execute(args, ctx) {
    // Send a progress update to the client UI
    ctx.sendJsonToClient?.({
      type: 'order.status',
      orderId: args.orderId,
      status: 'processing',
    });

    const result = await orderService.process(args.orderId);

    ctx.sendJsonToClient?.({
      type: 'order.status',
      orderId: args.orderId,
      status: 'completed',
    });

    return result;
  },
};
```

### Setting Active Directives

Tools can set **active directives** via `ctx.setDirective(key, value)` to influence the LLM's behavior across turns. Directives are automatically reinforced every turn by injecting them into Gemini's context via `sendClientContent`, preventing behavioral drift.

```typescript
// Set a directive — persists and reinforces every turn
ctx.setDirective?.('pacing', 'Speak at a slow, measured pace.');

// Clear a directive — pass null
ctx.setDirective?.('pacing', null);
```

Directives are scoped to the current agent and cleared on agent transfer. See [Speech Speed Control](/advanced/multimodal#speech-speed-control) for a complete example.

## Zod Schemas

The `parameters` field accepts any Zod schema. The framework converts it to a JSON Schema for the Gemini function declaration and validates arguments at runtime:

```typescript
// Simple parameters
parameters: z.object({
  city: z.string().describe('City name'),
  units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
})

// Nested objects
parameters: z.object({
  filters: z.object({
    category: z.string(),
    minPrice: z.number().optional(),
    maxPrice: z.number().optional(),
  }),
})

// Arrays
parameters: z.object({
  items: z.array(z.string()).describe('List of item names'),
})
```

::: tip
Always use `.describe()` on parameters — these descriptions help Gemini understand what values to pass.
:::

## Timeouts and Cancellation

Tools respect both timeout and user interruption:

```typescript
const slowTool: ToolDefinition = {
  name: 'slow_operation',
  description: 'An operation that takes time',
  parameters: z.object({}),
  execution: 'inline',
  timeout: 10_000, // 10 second timeout
  async execute(args, ctx) {
    // If the user interrupts or timeout hits, ctx.abortSignal fires
    const result = await longRunningOperation({
      signal: ctx.abortSignal,
    });
    return result;
  },
};
```

When a tool is cancelled:
- `ctx.abortSignal` is aborted
- The `onToolResult` hook fires with `status: 'cancelled'`
- For inline tools, Gemini receives an error response
- For background tools, the subagent run is terminated

## Complete Example

Here's a realistic agent with multiple tools:

```typescript
import { z } from 'zod';
import type { MainAgent, ToolDefinition } from '@bodhi_agent/realtime-agent-framework';

const searchProducts: ToolDefinition = {
  name: 'search_products',
  description: 'Search the product catalog by keyword',
  parameters: z.object({
    query: z.string().describe('Search keywords'),
    limit: z.number().default(5).describe('Max results to return'),
  }),
  execution: 'inline',
  async execute(args) {
    return await catalog.search(args.query, args.limit);
  },
};

const placeOrder: ToolDefinition = {
  name: 'place_order',
  description: 'Place an order for a product',
  parameters: z.object({
    productId: z.string(),
    quantity: z.number().min(1),
  }),
  execution: 'inline',
  async execute(args, ctx) {
    ctx.sendJsonToClient?.({
      type: 'order.confirmation',
      productId: args.productId,
    });
    return await orders.create(args.productId, args.quantity);
  },
};

const agent: MainAgent = {
  name: 'shopping',
  instructions: `You are a shopping assistant.
    Help users find products and place orders.
    Always confirm before placing an order.`,
  tools: [searchProducts, placeOrder],
};
```
