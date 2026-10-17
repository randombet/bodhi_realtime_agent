# GPT-Live (full duplex)

`OpenAILiveTransport` connects `VoiceSession` to OpenAI's GPT-Live model
(`gpt-live-1`) over the primary Live WebSocket. GPT-Live is a **full-duplex**
voice model: it listens while it speaks, decides on its own when to talk, and
hands reasoning and tool use to a **backend** through *delegation*. It is a
different API from OpenAI Realtime (`wss://api.openai.com/v1/live/sessions`,
its own events), so it is a separate transport, not a model row in
`OpenAIRealtimeTransport`.

## Two ways to run the backend

| `delegation.type` | Who thinks | What the framework sees |
| --- | --- | --- |
| `responses` | A Responses model run by OpenAI (`gpt-5.6-luna`, …) with this transport's `tools` as its function tools | Each backend function call is an `onToolCall`; the tool result is its output. The existing tool router, inline and background tools, and subagents work unchanged. |
| `client` (default) | Your application | Every delegation is **one** synthesized tool call, `clientDelegationTool` (default `delegate(request)`), whose argument is the recent transcript. Register a `ToolDefinition` of that name on the agent (a background tool that hands the request to your own agent). |

```ts
import { OpenAILiveTransport, VoiceSession } from 'bodhi-realtime-agent';

const transport = new OpenAILiveTransport({
	apiKey: process.env.OPENAI_API_KEY!,
	voice: 'marin',
	// The Live prompt: identity, speaking style, and WHEN to delegate.
	// Keep task procedures and tool rules in the backend prompt.
	instructions: LIVE_PROMPT,
	tools: agentTools,
	delegation: {
		type: 'responses',
		model: 'gpt-5.6-luna',
		instructions: BACKEND_PROMPT,
		parallelToolCalls: false,
	},
});

const session = new VoiceSession({
	transport,
	agents: [mainAgent],
	initialAgent: 'main',
	// GPT-Live may stay quiet after the user speaks (it decides); a model
	// silence watchdog would reconnect a healthy session.
	responseWatchdogMs: 0,
	// …
});
```

With client delegation, pass `clientDelegationTool: { name: 'work', argument: 'task' }`
to route delegations to an existing background tool of that name.

## How the wire maps onto `LLMTransport`

- **Audio**: PCM16 at 24 kHz (default) or 16 kHz, or G.711 μ-law, one format
  for both directions, fixed at startup. Input is appended continuously; there
  is nothing to commit.
- **Turns**: GPT-Live has no response-start, response-done or interrupted
  events, and its output audio is a *continuous* stream (silent frames keep
  arriving while it listens). The transport derives model turns from output
  speech activity (frame energy and `session.output_transcript.delta`): speech
  opens a generation (`onModelTurnStart`/`onGenerationStart`), `speechGapMs`
  (700 ms) of silence closes it (`onTurnComplete`). A delegation opens the
  generation too and keeps it open while the backend works, so a preamble
  ("let me check"), the wait and the spoken answer are one answer. Silent frames
  are dropped (`forwardSilence: true` keeps them).
- **Barge-in** belongs to the model: `frameworkOwnsInterrupt` is false and
  `cancelResponse` is a no-op. A speaking run that stops within
  `interruptWindowMs` of the user's transcript resuming is reported through
  `onInterrupted` instead of `onTurnComplete`.
- **Transcripts** stream as fragments for both speakers with session-timeline
  `start_ms`/`end_ms` and no utterance boundary. `onInputTranscription` gets
  each fragment (accumulate, as for Gemini); the first fragment after a 1 s gap
  also fires `onSpeechStarted`.
- **Context**: `instructions` are immutable after startup; a post-connect
  `updateSession({ instructions })` is *appended* in ≤500-token chunks.
  `updateSession({ tools })` updates the Responses backend in place.
  `sendContent` user text goes to the backend (Responses) or is appended as an
  instruction (client); assistant text becomes commentary the model paraphrases.
  `replayHistory` after startup is quiet context; `reconnect` seeds the new
  session's `input` with the conversation text (there is no resumption handle).
- **Tool results** that the backend is not waiting on — a client delegation's
  result, or a background tool's final answer after its pending message — are
  spoken via `session.commentary.append` (`scheduling: 'silent'` → quiet
  `session.thinking.append`; `'interrupt'` → an instruction to say it now;
  `'when_idle'` waits for the model to stop speaking). Appends are chunked to
  the 500-token limit.
- **Usage**: `session.usage.updated` / `session.closed` report cumulative voice
  seconds (`RealtimeLLMUsageEvent` with `unit: 'duration_seconds'`, source
  `openai_live.session`); delegated Responses tokens arrive per backend response
  (`unit: 'tokens'`, source `openai_live.backend`).
- **Quiesce** mutes the microphone upstream (`session.input_audio.mute`) and
  holds output; `unquiesce` restores both.
- **Close**: `disconnect()` sends `session.close` and waits (≤5 s) for
  `session.closed` with the final usage before dropping the socket.

## Known limits

- No text-only response mode (GPT-Live speaks): `responseModality: 'text'` is
  rejected, so external TTS does not apply.
- Images reach a vision-capable Responses backend only (`sendFile` with client
  delegation reports a recoverable error).
- Turn boundaries and interruptions are derived, not reported: a backchannel
  ("mm-hmm") is a short turn; `playbackGatedTurnComplete` is false, so use the
  native playback-end gate for playback-accurate turn ends.
- Startup `input` history is limited to 128 messages / 8,192 tokens; longer
  conversations are trimmed from the oldest end on `reconnect`.
- Voice sessions are billed per second; the backend model and tools separately.
