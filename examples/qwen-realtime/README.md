# Qwen Omni Realtime examples

Voice agents on **Qwen Omni Realtime** (Alibaba DashScope) via
`QwenRealtimeTransport`. The transport is a standalone `LLMTransport` on raw
WebSocket.

## Setup

```bash
pnpm install && pnpm build
```

Environment variables:

| Var | Required | Purpose |
|-----|----------|---------|
| `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`) | yes | DashScope key for the realtime transport |
| `GEMINI_API_KEY` | `tools.ts` only | Image/video subagents + subagent text generation |
| `QWEN_VOICE` | no | Override the voice (omit → server default `Tina`) |
| `QWEN_REALTIME_URL` | no | Override the endpoint (default: Singapore `dashscope-intl`) |
| `QWEN_REALTIME_MODEL` | no | Override the model (default `qwen3.5-omni-plus-realtime`) |
| `PORT` / `HOST` | no | Server bind (default `9900` / `0.0.0.0`) |

`QWEN_API_KEY` is read from your shell env (e.g. `~/.zshrc`) or a `.env` file.

## Examples

| File | What it does | Needs |
|------|--------------|-------|
| **`voice.ts`** | Minimal voice-in / voice-out assistant (no tools). Good first run. | `QWEN_API_KEY` |
| **`tools.ts`** | Full senior-friendly assistant: calculator, time, slow-search, image + video generation, `end_session`, and multi-agent transfer to a math specialist. Mirrors `examples/openai-realtime-tools.ts`. | `QWEN_API_KEY`, `GEMINI_API_KEY` |
| **`demo.ts`** | Dependency-free connectivity smoke test (one spoken turn → WAV out). No `VoiceSession`. | `QWEN_API_KEY` |
| **`probe.ts`** | Phase 0 verification spike — probes server_vad, tools, text injection, interrupt, in-place update, etc. | `QWEN_API_KEY` |
| **`shapes.ts`** | Dumps exact wire shapes (function-call items, usage, transcripts) for one audio + one tool turn. | `QWEN_API_KEY` |

`demo.ts` / `probe.ts` / `shapes.ts` are throwaway spike harnesses kept for
re-validation; `voice.ts` / `tools.ts` are the real `VoiceSession` examples.

## Run

```bash
# voice-only
pnpm tsx examples/qwen-realtime/voice.ts

# full tools + multi-agent assistant
pnpm tsx examples/qwen-realtime/tools.ts
```

Then connect a WebSocket audio client to `ws://localhost:9900` — e.g. start the
bundled web client with `pnpm web-client` — and start talking.

### Things to try with `tools.ts`

- "What time is it in Tokyo?"
- "What is the square root of 144?"
- "I need help with harder math" — transfers to the math specialist (and back)
- "Draw me a watercolor of a lighthouse" — image generation
- "Make a short video of waves on a beach" — video generation (slow)
- "Goodbye" — graceful `end_session`

## Notes

- **Turn-taking** uses Qwen `server_vad` (the model auto-responds after you stop
  speaking). Barge-in is framework-owned: the examples enable
  `nativePlaybackGating` + `playbackStateProtocol: 'audio_done'` so speaking over
  the assistant interrupts it — including during the buffered-playback tail (Qwen
  finishes generating before playback ends, like OpenAI).
- **Tools** use Qwen's OpenAI-identical function-calling protocol, so the
  framework's `ToolCallRouter`, background subagents, and multi-agent routing work
  unchanged.
- **Not included** (vs the OpenAI example): dictation/transcription mode, which
  relies on transport `quiesce()` — a Qwen Phase 4 follow-up, not in V1.
