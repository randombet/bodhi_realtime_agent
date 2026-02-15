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

The framework forwards the image to Gemini's multimodal input, enabling use cases like:
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

::: warning COMING SOON
Speech speed configuration is planned for a future release.
:::
