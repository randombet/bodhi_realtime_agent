# Interviewer Example

Document-driven software interviewer using a dedicated `software_interviewer` planning subagent and a voice `MainAgent`.

## What It Does

- Loads a mock job description, candidate resume, and company intro from `docs/`.
- Uses a startup subagent to synthesize a three-question interview plan before the voice session starts.
- Normalizes the plan against the source documents so names such as `Northstar Robotics` are not replaced by placeholders.
- Runs the interview by voice through a `MainAgent`.
- Customizes the opening greeting from the prepared candidate, company, and role context.
- Asks the three required primary questions in sequence.
- Ends with a standard interview closing and best-luck message.
- Does not implement dynamic follow-ups, timers, or mid-answer redirects in V1.

## Run

```bash
export GEMINI_API_KEY="your-gemini-key"
pnpm tsx examples/interviewer/interviewer-demo.ts
```

In another terminal:

```bash
pnpm web-client:dev
```

Open the local web client and connect to `ws://localhost:9900`.

## Optional Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `9900` | Local WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `GEMINI_LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` | Live voice model |
| `INTERVIEWER_REASONING_MODEL` | `gemini-2.5-flash` | Subagent planning model |
| `GEMINI_VOICE` | `Puck` | Gemini voice name |

## Interview Flow

1. The voice agent greets the candidate.
2. The `software_interviewer` subagent has already processed the documents and saved a plan during startup.
3. The voice agent asks each planned question with `next_interview_question`.
4. After each answer, the voice agent calls `record_interview_answer`.
5. After the third answer, the voice agent reads the prepared closing message and ends the session.

## Common Startup Notes

There is no `examples/web-client.ts` for this example. Use the shared app web client:

```bash
pnpm web-client:dev
```

The web client runs on Vite and connects to the demo WebSocket URL, usually `ws://localhost:9900`.
