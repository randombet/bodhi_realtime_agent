# Transport

The transport layer handles the bidirectional communication between your client app, the framework, and Google Gemini. Two transport classes work together to keep audio flowing with minimal latency.

## Architecture

```
┌─────────┐         ┌──────────────────┐         ┌────────┐
│  Client  │◄──ws──►│    Framework     │◄──ws──►│ Gemini │
│   App    │        │                  │        │  Live  │
└─────────┘         │  ClientTransport │        │  API   │
                    │  GeminiLiveTransport      │        │
                    └──────────────────┘         └────────┘
```

- **ClientTransport** — WebSocket server that your client app connects to
- **GeminiLiveTransport** — WebSocket client that connects to the Gemini Live API

Audio flows directly between these two transports, bypassing the EventBus for minimal latency. Everything else (tool calls, transfers, transcripts, GUI events) goes through the control plane.

## ClientTransport

The client-facing WebSocket server. It multiplexes two message types on a single connection:

| Frame Type | Content | Direction |
|-----------|---------|-----------|
| Binary | Raw PCM audio (16-bit, 16kHz, mono) | Both ways |
| Text | JSON messages (GUI events, commands) | Both ways |

### Audio Flow

```typescript
// Binary frames carry raw PCM audio
// Client → Server: user's microphone audio
// Server → Client: Gemini's voice response
```

The client sends raw PCM audio as binary WebSocket frames. The framework forwards it to Gemini and sends Gemini's audio response back the same way.

### JSON Messages

Text frames carry JSON messages for GUI events and commands:

```typescript
// Server → Client
{ "type": "gui.update", "payload": { "sessionId": "...", "data": {...} } }
{ "type": "gui.notification", "payload": { "sessionId": "...", "message": "..." } }
{ "type": "ui.payload", "payload": { /* UIPayload from subagent */ } }

// Client → Server
{ "type": "ui.response", "payload": { /* UIResponse */ } }
```

### Audio Buffering

During agent transfers and reconnections, client audio is buffered so nothing is lost:

```
Normal:       Client audio → Gemini (real-time)
Transfer:     Client audio → Buffer → Replay to new Gemini session
Reconnect:    Client audio → Buffer → Replay after reconnection
```

Buffering only affects binary (audio) frames. Text (JSON) frames are always delivered immediately.

### Connecting a Client

Any WebSocket client can connect. Here's a minimal browser example:

```javascript
const ws = new WebSocket('ws://localhost:9900');

// Send microphone audio as binary frames
navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
  const processor = new AudioWorkletNode(audioContext, 'pcm-processor');
  stream.getTracks()[0].connect(processor);

  processor.port.onmessage = (e) => {
    ws.send(e.data); // Binary frame: raw PCM
  };
});

// Receive audio and JSON from server
ws.onmessage = (event) => {
  if (event.data instanceof Blob) {
    // Binary frame: play audio
    playAudio(event.data);
  } else {
    // Text frame: GUI event
    const message = JSON.parse(event.data);
    handleGuiEvent(message);
  }
};
```

## GeminiLiveTransport

The Gemini-facing WebSocket client. It wraps the `@google/genai` SDK to manage the bidirectional audio stream with the Gemini Live API.

### What It Handles

- **Connection setup** — Sends system instruction, tool declarations, voice config, and compression settings
- **Audio streaming** — Sends base64-encoded PCM to Gemini, receives audio output
- **Tool routing** — Receives tool call requests, sends back tool results
- **Session resumption** — Tracks resumption handles for reconnecting after GoAway signals
- **Transcription** — Receives both input (user speech) and output (model speech) transcripts

### Configuration

```typescript
interface GeminiTransportConfig {
  apiKey: string;                    // Google API key
  model?: string;                    // Default: 'gemini-live-2.5-flash-preview'
  systemInstruction?: string;        // Agent's system prompt
  tools?: ToolDefinition[];          // Tools converted to Gemini function declarations
  resumptionHandle?: string;         // For resuming a previous session
  speechConfig?: { voiceName?: string };  // Voice preset (e.g. 'Puck')
  compressionConfig?: {              // Context window management
    triggerTokens: number;
    targetTokens: number;
  };
  googleSearch?: boolean;            // Enable Google Search grounding
  inputAudioTranscription?: boolean; // Transcribe user speech (default: true)
}
```

### Zod-to-JSON Schema Conversion

Tool parameters defined with Zod are automatically converted to JSON Schema for the Gemini function declaration:

```typescript
// Your tool definition:
parameters: z.object({
  city: z.string().describe('City name'),
  units: z.enum(['celsius', 'fahrenheit']),
})

// Sent to Gemini as:
{
  "name": "get_weather",
  "description": "Get current weather",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string", "description": "City name" },
      "units": { "type": "string", "enum": ["celsius", "fahrenheit"] }
    },
    "required": ["city", "units"]
  }
}
```

### Session Resumption

The Gemini Live API sends periodic resumption handles and GoAway signals. The framework handles these automatically:

```
Gemini sends GoAway (server shutting down)
  → Framework saves resumption handle
  → Starts buffering client audio
  → Disconnects
  → Reconnects with resumption handle
  → Replays buffered audio
  → Session continues seamlessly
```

The `session.resume` and `session.goaway` events are published on the EventBus so you can track these reconnections:

```typescript
session.eventBus.subscribe('session.goaway', (payload) => {
  console.log(`Gemini server shutting down, ${payload.timeLeft} remaining`);
});

session.eventBus.subscribe('session.resume', (payload) => {
  console.log(`Session resumed with handle: ${payload.handle}`);
});
```

## Audio Format

All audio in the framework uses the same format:

| Property | Value |
|----------|-------|
| Encoding | Linear PCM (raw samples) |
| Sample rate | 16,000 Hz |
| Bit depth | 16-bit signed integers |
| Channels | Mono |
| Byte order | Little-endian |

::: tip
This matches the Gemini Live API's native audio format. No transcoding is needed — audio bytes flow straight through.
:::

## Voice Configuration

Choose from Gemini's built-in voice presets:

```typescript
const session = new VoiceSession({
  speechConfig: { voiceName: 'Puck' },
  // ...other config
});
```

Available voices include `Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede`, and others from the Gemini API.

## Context Window Compression

For long conversations, enable automatic context compression to stay within Gemini's context window:

```typescript
// Configured via GeminiLiveTransport internally
// Gemini compresses when token count exceeds triggerTokens,
// targeting targetTokens after compression.
```

When compression occurs, the `context.compact` event is published:

```typescript
session.eventBus.subscribe('context.compact', (payload) => {
  console.log(`Compressed: removed ${payload.removedItems} items`);
});
```
