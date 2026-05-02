# Interviewer Example

Document-driven software interviewer using one persistent `software_interviewer` subagent and a voice `MainAgent`.

## What It Does

- Loads a mock job description, candidate resume, and company intro from `docs/`.
- Uses the same persistent subagent to synthesize a three-primary-anchor interview plan before the voice session starts.
- Reuses that initialized subagent for runtime interview progression.
- Normalizes the plan against the source documents so names such as `Northstar Robotics` are not replaced by placeholders.
- Runs the interview by voice through a `MainAgent`.
- Customizes the opening greeting from the prepared candidate, company, and role context.
- Adds the interview documents to the `MainAgent` knowledge base so unrelated/direct questions can be answered from context.
- Leads the interview toward answers to the three required primary questions.
- Allows the persistent subagent to ask concise clarification, follow-up, or deep-dive questions when an answer needs more signal.
- Ends with a standard interview closing and best-luck message.
- Does not implement timers or mid-answer redirects in V1.

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
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | Live voice model |
| `INTERVIEWER_REASONING_MODEL` | `gemini-2.5-flash` | Main voice-agent reasoning model |
| `INTERVIEWER_SUBAGENT_MODEL` | `gemini-3.1-flash-lite-preview` | Persistent interviewer reasoning model |
| `INTERVIEWER_SUBAGENT_THINKING_BUDGET` | `128` | Low reasoning budget for the persistent interviewer |
| `GEMINI_VOICE` | `Puck` | Gemini voice name |

The example also tunes Gemini Live server-side VAD with `END_SENSITIVITY_HIGH` and `silenceDurationMs: 500` so interview answers can close faster after the candidate stops speaking. Client microphone audio is gated until the greeting turn completes, which prevents startup microphone frames from racing the greeting `clientContent` request.

## Interview Flow

1. The voice agent greets the candidate.
2. The persistent `software_interviewer` subagent has already processed the documents and saved a plan into `InterviewState`.
3. The voice session registers that same `software_interviewer` instance for runtime tool calls.
4. The voice agent gets the first planned question with `record_answer_and_get_next_question`.
5. After each interview answer, the voice agent calls `record_answer_and_get_next_question` with the answer text and receives the next question or closing.
6. The persistent subagent decides whether the next question is a primary anchor, clarification, follow-up, or deep dive.
7. For unrelated questions, the voice agent answers directly using its knowledge base instead of forwarding to the subagent.
8. Once the subagent has enough signal for all three anchors, the voice agent reads the prepared closing message and ends the session.

## Common Startup Notes

There is no `examples/web-client.ts` for this example. Use the shared app web client:

```bash
pnpm web-client:dev
```

The web client runs on Vite and connects to the demo WebSocket URL, usually `ws://localhost:9900`.
