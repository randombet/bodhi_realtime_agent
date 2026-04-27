# Transport

Transport abstracts provider-specific realtime APIs behind a common `LLMTransport` interface. `VoiceSession` owns agent/tool orchestration and delegates provider wire protocol details to the active transport.

## Realtime LLM Providers

| Transport | Use When | Notes |
|-----------|----------|-------|
| `GeminiLiveTransport` | You want Gemini Live native audio, Google Search grounding, session resumption, or Gemini input/output transcription. | Created automatically when `VoiceSession` receives an API key and no custom transport. |
| `OpenAIRealtimeTransport` | You want OpenAI Realtime native audio and OpenAI session semantics. | Pass a constructed transport through `VoiceSessionConfig.transport`. |

Both transports expose:

- `audioFormat` so clients and STT/TTS providers can match the provider's PCM rate
- `capabilities` so orchestration branches on features instead of provider names
- tool-call and tool-result mapping
- turn completion, interruption, transcript, error, close, and usage callbacks
- `transferSession()` so agent transfers can update provider instructions and tools

## Using OpenAI Realtime

```typescript
import { google } from '@ai-sdk/google';
import {
  OpenAIRealtimeTransport,
  VoiceSession,
} from 'bodhi-realtime-agent';

const transport = new OpenAIRealtimeTransport({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-realtime',
  voice: 'alloy',
});

const session = new VoiceSession({
  sessionId: 'session_1',
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!, // still used by background subagents
  agents: [mainAgent],
  initialAgent: 'main',
  model: google('gemini-2.5-flash'),
  transport,
  port: 9900,
});
```

## STT Providers

`VoiceSessionConfig.sttProvider` attaches an external transcription provider. The provider receives the transport's actual input format through `configure()` before it starts.

```typescript
import {
  GeminiBatchSTTProvider,
  VoiceSession,
} from 'bodhi-realtime-agent';

const session = new VoiceSession({
  // ...
  sttProvider: new GeminiBatchSTTProvider({
    apiKey: process.env.GEMINI_API_KEY!,
    model: 'gemini-3-flash-preview',
  }),
});
```

When an external STT provider is set, `VoiceSession` feeds every client audio chunk into the provider and commits the provider at model-turn boundaries. Gemini built-in transcription can still be used as a post-hoc correction path when available.

Deepgram Nova-3 live streaming can be used when you want lower-latency partial user transcripts:

```typescript
import {
  DeepgramSTTProvider,
  VoiceSession,
} from 'bodhi-realtime-agent';

const session = new VoiceSession({
  // ...
  sttProvider: new DeepgramSTTProvider({
    apiKey: process.env.DEEPGRAM_API_KEY!,
    model: 'nova-3',
    language: 'en-US',
  }),
  inputAudioTranscription: false, // Optional: make Deepgram the only input transcript source.
});
```

Deepgram receives the active transport's PCM input format through `configure()`. With Gemini Live that is 16 kHz mono PCM16; with OpenAI Realtime that is 24 kHz mono PCM16.

## TTS Providers

`VoiceSessionConfig.ttsProvider` switches the realtime LLM to text-mode responses and routes text deltas into a streaming `TTSProvider`.

Built-in providers:

- `CartesiaTTSProvider`
- `ElevenLabsTTSProvider`

See [External TTS](/advanced/tts) for details.

## Client Transports

There are two client-connection modes:

| Mode | Config | Use Case |
|------|--------|----------|
| Local session socket | `port` / `host` | Simple examples and local development. `VoiceSession` creates a `ClientTransport`. |
| Server-owned socket | `clientSender` plus `feedAudioFromClient()` / `feedJsonFromClient()` | Multi-user servers that route many WebSocket connections to many sessions. |

`MultiClientTransport` is the server-owned socket helper. It accepts many WebSocket clients, assigns each connection a `ConnectionContext`, and lets application code bind that connection to a `VoiceSession`.

```typescript
const transport = new MultiClientTransport(9900, {
  onAudioFromClient: (_ws, data, context) => {
    const session = sessions.getSession(context.sessionId!);
    session?.feedAudioFromClient(data);
  },
  onJsonFromClient: (_ws, message, context) => {
    const session = sessions.getSession(context.sessionId!);
    session?.feedJsonFromClient(message);
  },
});

await transport.start();
```

## Audio Formats

The framework normalizes around PCM L16 mono, but sample rates are provider-specific:

| Provider Path | Input | Output |
|---------------|-------|--------|
| Gemini Live | 16 kHz PCM | 24 kHz PCM |
| OpenAI Realtime | 24 kHz PCM | 24 kHz PCM |
| Twilio Media Streams | mulaw 8 kHz | mulaw 8 kHz |
| Framework telephony bridge | 16 kHz PCM | 16 kHz PCM |

STT providers receive the transport input format. TTS providers receive the preferred output format and can return a different supported PCM rate; `VoiceSession` resamples to the client format when needed.
