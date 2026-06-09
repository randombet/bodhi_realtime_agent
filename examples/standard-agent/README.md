<!-- SPDX-License-Identifier: MIT -->

# Standard Agent — local demo

A standalone, single-user demo that imports the production **Standard agent** profile agents
(`standardMainAgent` / `mathExpertAgent`) and wires the hosted-only helpers locally. It reuses the
same agent objects, tools, and media subagents the hosted server compiles, so the voice behavior
matches the real contact card.

## What it does

Main agent **Bodhi** (warm, patient, voice-paced for older adults):

| Capability | Tool / feature |
|------------|----------------|
| Web lookups (weather, news, facts) | Google Search (native Gemini grounding) |
| Math | `calculate` |
| Date / time | `get_current_time` |
| Speak slower / faster | `set_speech_speed` (behavior preset) |
| Create a picture | `generate_image` (Gemini image subagent) |
| Create a short video | `generate_video` (Veo subagent) |
| Analyze an uploaded image | `read_image` + `list_artifacts` (Gemini vision subagent) |
| Hand off hard math | transfer to `math_expert`, which transfers back |
| Say goodbye | `end_session` |

> Two things the hosted platform injects automatically are wired by hand here:
> `set_speech_speed` (via the `speechSpeed()` behavior) and `list_artifacts`
> (so `read_image` can resolve an uploaded image). `session_data_action`
> (history download) is omitted — it depends on hosted server plumbing.

## Run

```bash
export GEMINI_API_KEY="your-google-ai-studio-key"
pnpm tsx examples/standard-agent/standard-agent-demo.ts

# In another terminal — reuse the generic web client:
pnpm tsx examples/openclaw/web-client.ts
```

Open <http://localhost:8080>, click **Connect**, and allow microphone access.

## Try saying

- "What is the weather in San Francisco?" — Google Search
- "What is the square root of 1764?" — calculator
- "Please speak more slowly" — `set_speech_speed`
- "Draw me a picture of a sunset" — image generation
- "Make a short video of ocean waves" — video generation (takes a minute or two)
- Upload a photo (📎), then "What is in this image?" — image analysis
- "I have a hard math problem" — hands off to the math expert
- "Goodbye" — ends the session

## Environment

| Var | Default | Notes |
|-----|---------|-------|
| `GEMINI_API_KEY` | — | Required. Google AI Studio key. |
| `PORT` | `9900` | Voice agent WebSocket port. |
| `HOST` | `0.0.0.0` | Bind address. |
