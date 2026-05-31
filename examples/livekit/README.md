<!-- SPDX-License-Identifier: MIT -->

# Bodhi on LiveKit — cascaded STT + LLM + TTS

The LiveKit-agents-js counterpart of [`examples/openai-realtime-tools.ts`](../openai-realtime-tools.ts).
Same warm, senior-friendly **Bodhi** persona and the same capabilities — function tools,
background image/video generation, multi-agent transfer, graceful end — but built on a
**cascaded pipeline** (Deepgram STT → OpenAI LLM → Cartesia TTS) over LiveKit's WebRTC
transport instead of one speech-to-speech model over a raw WebSocket.

Design doc: [`dev_docs/framework/design-livekit-stt-llm-tts-example.md`](../../dev_docs/framework/design-livekit-stt-llm-tts-example.md)

## What it does

- **Persona & pacing** — senior-friendly Bodhi, one idea per turn (greeting fires once).
- **Tools** — `calculate` (a real parser, not `eval`), `get_current_time`, `slow_web_search`
  (interruptible on barge-in), `generate_image`, `generate_video`, `end_session`.
- **Multi-agent** — `main` ↔ `math_expert` via LiveKit `llm.handoff`.
- **Background generation** — image/video run **detached** (the agent keeps responding) and
  stream to the client over a small data contract when ready.

## Isolated package

This example is a **self-contained npm package** with its **own `package.json`,
`node_modules`, and lockfile** — its (heavy) LiveKit dependencies are deliberately
**isolated from the parent repo**. Installing or removing it never touches the root
project. All commands below run from **this directory** (`examples/livekit/`).

## Files

| File | What |
|---|---|
| `bodhi-stt-llm-tts.ts` | the agent worker (main deliverable) |
| `calculator.ts` | safe math evaluator used by the `calculate` tool |
| `calculator.test.ts` | tests for the evaluator (`pnpm test`) |
| `client.html` | tiny standalone browser client (mic + audio + image/video rendering) |
| `mint-token.ts` | serves `client.html` + a `/token` endpoint for one-click connect |
| `package.json` / `tsconfig.json` / `vitest.config.ts` | the isolated toolchain |
| `.env.example` | env template |

## Setup

```bash
cd examples/livekit
pnpm install
```

The first install builds native deps (`sharp`, `onnxruntime-node`, `@livekit/rtc-node`,
`@ffmpeg-installer`, `esbuild`) — all pre-approved in this package's
`pnpm.onlyBuiltDependencies`, so the install is warning-free.

Provide credentials, either by exporting them (e.g. in `~/.zshrc`) or by copying
`.env.example` to `.env`:

| Var | Required | For |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | always | LiveKit (Cloud) connection |
| `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `CARTESIA_API_KEY` | `PROVIDER=plugins` (default) | STT / LLM / TTS |
| `GEMINI_API_KEY` | image/video | Gemini image + Veo video |
| `PROVIDER` | optional | `plugins` (default) or `inference` |
| `CARTESIA_VOICE_ID` | optional | TTS voice override |

## Run

Two processes (both from `examples/livekit/`): the **agent worker**, and a **client**.

```bash
# 1. Start the agent worker (inherits your exported env;
#    or: tsx --env-file=.env bodhi-stt-llm-tts.ts dev)
pnpm dev

# 2. In another terminal, serve the client (mints a token for you)
pnpm client       # → open http://127.0.0.1:8080, click "Connect & talk"
```

> **Credentials:** `pnpm dev` runs a child process, which only inherits **exported**
> environment variables. In `~/.zshrc`, make sure the vars use `export` (e.g.
> `export LIVEKIT_API_KEY=...`) — a bare `LIVEKIT_API_KEY=...` is shell-local and invisible
> to the worker (you'd get `MissingCredentialsError`). Alternatively, put them in a local
> `.env` (copied from `.env.example`) — it is auto-loaded via `dotenv` and does **not**
> override anything you've already exported.

Then say:

- "What time is it?" · "What is 25 times 17?"
- "I need help with harder math" → transfers to the math helper; "I'm done" → transfers back
- "Draw me a picture of a sunset" → image appears in the client
- "Make a short video of a cat" → video appears (capped to ~5s)
- "Goodbye" → warm goodbye, then the session ends

### Connecting without the helper (truly standalone)

Open `client.html` directly and paste your `LIVEKIT_URL` plus a participant token. Mint one with:

```bash
pnpm mint          # prints URL + a 1-hour token (room "bodhi")
# or the LiveKit CLI:  lk token create --join --room bodhi --identity human --valid-for 1h
```

The client joins room `bodhi` by default (matches the token's room grant).

## Provider paths

- **`PROVIDER=plugins` (default)** — discrete Deepgram STT + OpenAI LLM + Cartesia TTS, using
  your own keys. The truest "STT+LLM+TTS" demonstration; works on self-hosted LiveKit too.
- **`PROVIDER=inference`** — routes STT/LLM/TTS through the **LiveKit Cloud** inference
  gateway (needs only `LIVEKIT_*`). Both paths are statically imported and selected at runtime.

Swapping providers is a one-line change — e.g. `new elevenlabs.TTS()` instead of
`new cartesia.TTS()` (you'd add `@livekit/agents-plugin-elevenlabs`), or `assemblyai` for STT.

## Data contract (for client authors)

Three topics. `client.html` implements all of them:

- **`bodhi.gui`** — asset lifecycle + bytes. A JSON metadata message via `publishData`:
  `{ schemaVersion, assetId, type: 'image'|'video', status: 'started'|'ready'|'error', mimeType?, description?, streamName?, error? }`,
  and the asset **bytes** via a **byte stream** (`streamBytes`) whose `name === assetId`.
  `ready` means the server finished writing — render only once **both** the `ready` metadata
  and the byte stream have arrived (keyed by `assetId`; either order).
- **`bodhi.session`** — control events, e.g. `{ type: 'session_end', reason }`.
- Transcripts use LiveKit's built-in transcription stream (no custom topic).

## Verify

```bash
pnpm typecheck     # tsc --noEmit against the real LiveKit 1.4.4 API
pnpm test          # calculator.test.ts (25 cases)
```

## Notes / not included

- **Dictation mode** (the reference's Whisper transcription mode) is intentionally **left
  out** of v1 — see the design doc's "Dictation / transcription mode" appendix. LiveKit has
  no native transport-quiesce, so it's an optional follow-up.
- **Cache observability** (`realtime.usage` / `realtime.cache.bust`) is OpenAI-Realtime
  specific and has no cascade equivalent; LiveKit `MetricsCollected` + the usage summary on
  shutdown stand in for it.
- The stock LiveKit Agents Playground will **not** render the custom `bodhi.gui` payload —
  that's what `client.html` is for.
