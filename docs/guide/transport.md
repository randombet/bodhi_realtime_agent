# Transport

The transport layer handles the bidirectional communication between your client app, the framework, and the LLM provider. A provider-agnostic `LLMTransport` interface abstracts the differences between Gemini and OpenAI, so your agent code works with either.

## Architecture

```
┌─────────┐         ┌──────────────────┐         ┌──────────────┐
│  Client  │◄──ws──►│    Framework     │◄──ws──►│ LLM Provider │
│   App    │        │                  │        │ (Gemini Live  │
└─────────┘         │  ClientTransport │        │  or OpenAI    │
                    │  LLMTransport    │        │  Realtime)    │
                    └──────────────────┘         └──────────────┘
```

- **ClientTransport** — WebSocket server that your client app connects to
- **LLMTransport** — Provider-agnostic interface implemented by `GeminiLiveTransport` and `OpenAIRealtimeTransport`

Audio flows directly between these two transports, bypassing the EventBus for minimal latency. Everything else (tool calls, transfers, transcripts, GUI events) goes through the control plane.

## LLMTransport Interface

The `LLMTransport` interface decouples the framework from any specific LLM provider. VoiceSession, AgentRouter, and ToolCallRouter interact only with this interface — never with provider-specific classes.

### Capabilities

Each transport advertises its capabilities as static booleans. The orchestrator branches on these — never on provider names:

| Capability | Gemini | OpenAI | What it means |
|-----------|--------|--------|---------------|
| `messageTruncation` | No | Yes | Can truncate server-side message at audio playback position |
| `turnDetection` | Yes | Yes | Server-side VAD / end-of-turn detection |
| `userTranscription` | Yes | Yes | Provides transcriptions of user audio input |
| `inPlaceSessionUpdate` | No | Yes | Supports in-place session update without reconnection |
| `sessionResumption` | Yes | No | Supports session resumption on disconnect |
| `contextCompression` | Yes | No | Supports server-side context compression |
| `groundingMetadata` | Yes | No | Provides grounding metadata with search citations |

### Key Methods

```typescript
interface LLMTransport {
  readonly capabilities: TransportCapabilities;
  readonly audioFormat: AudioFormatSpec;

  connect(config?: LLMTransportConfig): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(state?: ReconnectState): Promise<void>;

  sendAudio(base64Data: string): void;
  sendContent(turns: ContentTurn[], turnComplete?: boolean): void;
  sendFile(base64Data: string, mimeType: string): void;
  sendToolResult(result: TransportToolResult): void;
  triggerGeneration(instructions?: string): void;

  updateSession(config: SessionUpdate): void;
  transferSession(config: SessionUpdate, state?: ReconnectState): Promise<void>;

  // Callbacks
  onAudioOutput?: (base64Data: string) => void;
  onToolCall?: (calls: TransportToolCall[]) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  // ... and more
}
```

## ClientTransport

The client-facing WebSocket server. It multiplexes two message types on a single connection:

| Frame Type | Content | Direction |
|-----------|---------|-----------|
| Binary | Raw PCM audio (16-bit, mono) | Both ways |
| Text | JSON messages (GUI events, commands) | Both ways |

### Audio Flow

```typescript
// Binary frames carry raw PCM audio
// Client → Server: user's microphone audio
// Server → Client: LLM's voice response
```

The client sends raw PCM audio as binary WebSocket frames. The framework forwards it to the LLM transport and sends the LLM's audio response back the same way.

### JSON Messages

Text frames carry JSON messages for GUI events and commands:

```typescript
// Server → Client
{ "type": "session.config", "audioFormat": { "inputSampleRate": 16000, "outputSampleRate": 24000, ... } }
{ "type": "gui.update", "payload": { "sessionId": "...", "data": {...} } }
{ "type": "gui.notification", "payload": { "sessionId": "...", "message": "..." } }
{ "type": "ui.payload", "payload": { /* UIPayload from subagent */ } }

// Client → Server
{ "type": "ui.response", "payload": { /* UIResponse */ } }
```

### Audio Buffering

During agent transfers and reconnections, client audio is buffered so nothing is lost:

```
Normal:       Client audio → LLM (real-time)
Transfer:     Client audio → Buffer → Replay to new session
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
  if (event.data instanceof ArrayBuffer) {
    // Binary frame: play audio
    playAudio(event.data);
  } else {
    // Text frame: GUI event or config
    const message = JSON.parse(event.data);
    handleMessage(message);
  }
};
```

## GeminiLiveTransport

WebSocket client for the [Gemini Live API](https://ai.google.dev/gemini-api/docs/live). Wraps the `@google/genai` SDK.

### What It Handles

- **Connection setup** — Sends system instruction, tool declarations, voice config, and compression settings
- **Audio streaming** — Sends base64-encoded PCM to Gemini, receives audio output
- **Tool routing** — Receives tool call requests, sends back tool results
- **Session resumption** — Tracks resumption handles for reconnecting after GoAway signals
- **Transcription** — Receives both input (user speech) and output (model speech) transcripts
- **Google Search grounding** — Passes search citations from Gemini responses

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

### Agent Transfers

Gemini does not support in-place session updates (`inPlaceSessionUpdate: false`). Agent transfers require a full reconnect: disconnect the current session, connect a new one with the new agent's instructions/tools, and replay conversation history.

## OpenAIRealtimeTransport

WebSocket client for the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime). Wraps the `openai` SDK's `OpenAIRealtimeWS`.

### What It Handles

- **Connection setup** — Creates WebSocket, sends session configuration with tools, instructions, and voice
- **Audio streaming** — Sends base64-encoded PCM to OpenAI, receives audio output deltas
- **Tool call accumulation** — OpenAI streams function call arguments incrementally; the transport accumulates and dispatches complete calls
- **Interruption handling** — Truncates audio items at the user's speech point, suppresses queued audio deltas
- **when_idle scheduling** — Buffers background tool results while the model is generating, flushes on `response.done`
- **Transcription** — Input transcription via configurable model, output transcription from response events

### Configuration

```typescript
interface OpenAIRealtimeConfig {
  apiKey: string;                      // OpenAI API key
  model?: string;                      // Default: 'gpt-realtime'
  voice?: string;                      // Default: 'coral'
  transcriptionModel?: string | null;  // Default: 'gpt-4o-mini-transcribe', null to disable
  turnDetection?: Record<string, unknown>;   // Default: semantic_vad
  noiseReduction?: Record<string, unknown>;  // Optional noise reduction config
}
```

### Agent Transfers

OpenAI supports in-place session updates (`inPlaceSessionUpdate: true`). Agent transfers send a `session.update` event with the new instructions and tools — no reconnect or history replay needed. This makes transfers faster than Gemini's reconnect-based approach.

### Key Differences from Gemini

| Aspect | Gemini | OpenAI |
|--------|--------|--------|
| Agent transfer | Reconnect + replay history | In-place `session.update` |
| Tool call delivery | Complete calls in one event | Streamed argument deltas, accumulated |
| Tool result generation | Automatic after `sendToolResponse` | Explicit `response.create` required |
| Interruption | Server fires `interrupted` event | Client must `conversation.item.truncate` |
| Audio rate | 16kHz input, 24kHz output | 24kHz input, 24kHz output |

## Audio Format

Each transport advertises its native audio format via `transport.audioFormat`. Input and output sample rates may differ:

| Provider | Input Rate | Output Rate | Bit Depth | Channels |
|----------|-----------|-------------|-----------|----------|
| Gemini   | 16,000 Hz | 24,000 Hz   | 16-bit    | Mono     |
| OpenAI   | 24,000 Hz | 24,000 Hz   | 16-bit    | Mono     |

The `AudioFormatSpec` type models this asymmetry:

```typescript
interface AudioFormatSpec {
  inputSampleRate: number;   // Rate for mic capture / sending to LLM
  outputSampleRate: number;  // Rate for LLM audio output / playback
  channels: number;
  bitDepth: number;
  encoding: 'pcm';
}
```

### Audio Format Negotiation

On client connect, VoiceSession sends a `session.config` message with the active transport's audio format. The web client reads both rates and configures mic capture and audio playback independently:

```javascript
// Web client receives session.config on connect
if (msg.type === 'session.config' && msg.audioFormat) {
  INPUT_RATE  = msg.audioFormat.inputSampleRate;   // mic downsampling target
  OUTPUT_RATE = msg.audioFormat.outputSampleRate;   // AudioContext playback rate
}
```

This means the same web client works with both Gemini and OpenAI without code changes — the server tells it what rates to use.

::: tip
The framework is a pure byte relay — no server-side resampling. The web client handles resampling from the browser's native mic rate down to the provider's input rate.
:::

## Using a Pre-Configured Transport

For OpenAI (or any custom transport), you can inject a pre-constructed `LLMTransport` into VoiceSession:

```typescript
import { OpenAIRealtimeTransport } from '@bodhi_agent/realtime-agent-framework';

const transport = new OpenAIRealtimeTransport({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-realtime-preview',
  voice: 'coral',
});

const session = new VoiceSession({
  // ...required config...
  transport,  // Inject pre-configured transport
});
```

When you inject a transport, VoiceSession automatically syncs the agent's tools and instructions to it via `updateSession()` before connecting.

## Voice Configuration

Voice configuration depends on the provider:

```typescript
// Gemini — voice presets
const session = new VoiceSession({
  speechConfig: { voiceName: 'Puck' },
  // Available: Puck, Charon, Kore, Fenrir, Aoede, etc.
});

// OpenAI — voice names set in transport config
const transport = new OpenAIRealtimeTransport({
  apiKey: process.env.OPENAI_API_KEY!,
  voice: 'coral',
  // Available: alloy, ash, ballad, coral, echo, sage, shimmer, verse
});
```

## Zod-to-JSON Schema Conversion

Tool parameters defined with Zod are automatically converted to JSON Schema for the provider's function declaration format. Each transport handles the conversion internally — Gemini uses uppercase JSON Schema conventions, OpenAI uses standard JSON Schema:

```typescript
// Your tool definition (same for both providers):
parameters: z.object({
  city: z.string().describe('City name'),
  units: z.enum(['celsius', 'fahrenheit']),
})

// Converted automatically by the transport to the provider's format
```

## Context Window Compression

Context compression is a Gemini-specific capability (`contextCompression: true`). For long conversations, Gemini automatically compresses when the token count exceeds the configured threshold:

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

OpenAI Realtime does not currently support server-side context compression.
