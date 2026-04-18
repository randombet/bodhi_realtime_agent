# Architecture Overview

At a high level:

1. Client streams audio/text to `VoiceSession`.
2. Transport handles live model IO (Gemini/OpenAI).
3. Main agent decides tool calls and transfers.
4. Tool layer executes inline/background work.
5. Subagents handle long-running tasks.
6. Events/hooks expose observability and integration points.

## Key runtime modes

- `legacy`: classic router-based orchestration
- `actor`: actor-runtime orchestration

See [Actor Runtime Pattern](/guide/actor-pattern) for details.

## Main components

- `VoiceSession` (session lifecycle and wiring)
- `LLMTransport` implementations
- `ToolExecutor` + router
- `AgentRouter` / transfer flow
- Memory + history stores
- EventBus + hooks
