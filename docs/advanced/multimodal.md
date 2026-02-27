# Multimodal Features

Beyond voice, the framework supports text input, image upload, image generation, and GUI events — all on a single WebSocket connection.

## Text Input

While the primary input is voice, clients can also send text messages as JSON:

```javascript
// Client-side: send a text message
ws.send(JSON.stringify({
  type: 'text',
  content: 'What time is my appointment?',
}));
```

This is useful for accessibility, noisy environments, or hybrid voice+text interfaces.

## Image Upload

Clients can upload images for visual understanding:

```javascript
// Client-side: send an image
ws.send(JSON.stringify({
  type: 'image',
  data: base64EncodedImage,
  mimeType: 'image/jpeg',
}));
```

The framework forwards the image to the LLM's multimodal input, enabling use cases like:
- "What's in this photo?"
- "Read the text on this receipt"
- "Identify this product"

The `onImageUpload` callback in `ClientTransportCallbacks` handles incoming images.

## Image Generation

Tools can generate images using the Imagen API and send them to the client:

```typescript
const generateImage: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image based on a text description',
  parameters: z.object({
    prompt: z.string().describe('Image description'),
  }),
  execution: 'inline',
  async execute(args, ctx) {
    // Call Imagen API
    const imageBase64 = await imagenGenerate(args.prompt);

    // Send image to client via GUI channel
    ctx.sendJsonToClient?.({
      type: 'image',
      data: imageBase64,
      mimeType: 'image/png',
      prompt: args.prompt,
    });

    return { status: 'Image generated and sent to display' };
  },
};
```

## GUI Events

The WebSocket supports bidirectional JSON messages alongside audio, enabling rich client interfaces:

### Server to Client

```typescript
// Send UI updates from tools or EventBus subscribers
ctx.sendJsonToClient?.({
  type: 'order.status',
  orderId: '123',
  status: 'processing',
  progress: 0.75,
});
```

### Client to Server

```javascript
// Client sends structured responses
ws.send(JSON.stringify({
  type: 'ui.response',
  payload: {
    requestId: 'confirm_123',
    action: 'approved',
  },
}));
```

### Event Types

| Direction | Type | Purpose |
|-----------|------|---------|
| Server → Client | `gui.update` | Update UI state |
| Server → Client | `gui.notification` | Show notification |
| Server → Client | `ui.payload` | Structured UI element (form, choice, image) |
| Client → Server | `ui.response` | User response to UI element |

## Dual-Channel Delivery

The framework's subagent system supports dual-channel delivery — sending both a voice response and a visual UI element simultaneously:

```
Voice channel:  "Here's the weather forecast for this week."
GUI channel:    { type: "image", data: weatherChartBase64 }
```

This is powered by the `UIPayload` type in subagent results:

```typescript
interface UIPayload {
  type: 'choice' | 'confirmation' | 'status' | 'form' | 'image';
  requestId?: string;
  data: Record<string, unknown>;
}
```

See [Subagent Patterns](/advanced/subagents) for interactive subagent examples.

## Speech Speed Control

Users can ask the voice agent to speak slower or faster during a conversation. This is implemented as a dual-layer system: **server-side directive reinforcement** controls how the LLM generates speech, while a **client-side playback rate** adjusts audio playback speed.

### How It Works

1. The user says something like "Can you speak slower?"
2. The agent calls the `set_speech_speed` tool
3. The tool sets an **active directive** via `ctx.setDirective()` — this injects pacing instructions into every subsequent turn, preventing the model from drifting back to its default pace
4. The client receives a `speech_speed` JSON message and adjusts its audio `playbackRate`

### Defining the Tool

```typescript
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '@bodhi/realtime-agent-framework';

const setSpeechSpeed: ToolDefinition = {
  name: 'set_speech_speed',
  description: 'Change the speech speed. Call this when the user asks to speak slower, faster, or at normal speed.',
  parameters: z.object({
    speed: z.enum(['slow', 'normal', 'fast']).describe('The desired speech speed'),
  }),
  execution: 'inline',
  execute: async (args, ctx: ToolContext) => {
    const { speed } = args as { speed: 'slow' | 'normal' | 'fast' };

    // Server-side: set an active directive reinforced every turn
    const paceDirectives: Record<string, string | null> = {
      slow: 'IMPORTANT PACING OVERRIDE: Speak at a slow, measured pace. Use shorter sentences with brief pauses between them.',
      normal: null,  // null clears the directive
      fast: 'IMPORTANT PACING OVERRIDE: Speak at a brisk, efficient pace. Be concise and direct.',
    };
    ctx.setDirective?.('pacing', paceDirectives[speed]);

    return { speed, status: 'applied' };
  },
};
```

### Active Directives

`ctx.setDirective(key, value)` stores a directive by category key. The framework automatically reinjects all active directives into the model's context at the start of every turn via `sendContent`. This prevents behavioral drift — without reinforcement, the model tends to revert to its default pacing after a few turns.

- Pass a string value to set or update a directive
- Pass `null` to clear a directive (e.g., resetting speed to normal)
- Directives are scoped to the current agent and cleared on agent transfer

### Client-Side Playback Rate

For immediate perceptual effect, the tool can also send a JSON message to the client to adjust audio playback speed:

```javascript
// Client-side handler
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'speech_speed') {
    const speeds = { slow: 0.85, normal: 1.0, fast: 1.2 };
    playbackRate = speeds[msg.speed] || 1.0;
  }
};
```

The client applies `playbackRate` to each `AudioBufferSourceNode` before scheduling playback. This gives an instant speed change for audio already being generated, while the directive ensures future turns are generated at the appropriate pace.

### Speed Presets

| Speed | Directive Effect | Client Playback Rate |
|-------|-----------------|---------------------|
| `slow` | Shorter sentences, pauses between them | 0.85x |
| `normal` | Default behavior (directive cleared) | 1.0x |
| `fast` | Concise and direct delivery | 1.2x |
