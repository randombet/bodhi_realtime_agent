# Project Deep-Dive Example

**Purpose:** A toy demo that mirrors [`examples/interviewer/`](../interviewer/) but specializes the persistent subagent's brain to deep-dive a candidate's past project using the STAR frame. Useful both as a more realistic interview demo and as a template for users building their own probe-frame variants.

## What It Does

- Loads a mock job description, candidate resume, and company intro from `docs/`.
- The persistent `project_deepdive` subagent reads the documents, picks **one** project from the resume that has the highest signal opportunity, and prepares four STAR-aligned anchor questions:
  1. `project_context` — what the project was, scope, timeframe, team size.
  2. `contribution_and_decisions` — the candidate's role + the most consequential design decision they owned.
  3. `problems_and_failures` — hardest problem / what went wrong / how they recovered.
  4. `outcomes_and_metrics` — quantified outcomes + reflective judgment.
- The same subagent instance is registered for runtime tool calls — it decides per-anchor probe depth (clarification / follow-up / deep-dive) with up to **3 dynamic questions per anchor** (vs the interviewer's 2 — anchors in a deep-dive deserve more probing).
- The voice `MainAgent` greets the candidate, names the chosen project, and drives the interview via `record_answer_and_get_next_question`.
- The interview is scoped to **one project**: if the candidate brings up a different one, the agent acknowledges briefly and steers back.
- Writes a per-session WhatsApp-style markdown transcript via [`MarkdownConversationHistoryStore`](../../src/core/markdown-conversation-history-store.ts).

## Run

```bash
export GEMINI_API_KEY="your-gemini-key"
pnpm tsx examples/project-deepdive/project-deepdive-demo.ts
```

In another terminal:

```bash
pnpm web-client
```

Open the local web client and connect to `ws://localhost:9900`.

## Optional Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `9900` | Local WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | Live voice model |
| `DEEPDIVE_REASONING_MODEL` | `gemini-2.5-flash` | Main voice-agent reasoning model |
| `DEEPDIVE_SUBAGENT_MODEL` | `gemini-3.1-flash-lite-preview` | Persistent subagent reasoning model |
| `DEEPDIVE_SUBAGENT_THINKING_BUDGET` | `128` | Low reasoning budget for the persistent subagent |
| `GEMINI_VOICE` | `Puck` | Gemini voice name |
| `TRANSCRIPT_DIR` | `./transcripts` | Where the per-session `.md` chat log lands |

The example tunes Gemini Live server-side VAD with `END_SENSITIVITY_HIGH` and `silenceDurationMs: 500` so deep-dive answers can close faster after the candidate stops speaking.

## Interview Flow

1. The voice agent greets the candidate, names the chosen project, and explains that today's interview will deep-dive into that project specifically.
2. The persistent `project_deepdive` subagent has already processed the documents, picked one project, and prepared four STAR anchor questions.
3. The voice agent gets the first planned question with `record_answer_and_get_next_question` (no `answerText`).
4. After each candidate answer, the voice agent calls `record_answer_and_get_next_question` with the answer text and receives the next question or the closing message.
5. The persistent subagent decides whether the next question is a primary anchor, a clarification, a follow-up, or a deep-dive — biased toward `deep_dive` when the candidate gives technical material.
6. For unrelated questions, the voice agent answers directly using its knowledge base instead of forwarding to the subagent.
7. Once all four STAR anchors have enough signal, the voice agent reads the closing message and ends the session.

## Differences vs the Interviewer Example

| | `examples/interviewer/` | `examples/project-deepdive/` (this) |
|---|---|---|
| Anchor count | 3 (`walk_resume`, `company_interest`, `technical_challenge`) | 4 STAR (`project_context`, `contribution_and_decisions`, `problems_and_failures`, `outcomes_and_metrics`) |
| Scope | Whole-resume sweep | Single project chosen by the subagent up-front |
| Dynamic-question budget per anchor | 2 | 3 |
| Subagent decision bias | Even split clarification/follow_up/deep_dive | Prefers `deep_dive` over `clarification` for technical material |
| Outcomes-anchor heuristic | None | Fallback `follow_up` when answer lacks quantified numbers (no %, ms, x, users, etc.) |

The implementation file structure and the framework wiring are otherwise identical — same persistent subagent + voice MainAgent + KB pattern, same `MarkdownConversationHistoryStore` integration, same `TimingReminderBackgroundAgent` (re-exported from the interviewer example, no copy).

## Design Doc

See [`dev_docs/framework/design-project-deepdive-example.md`](../../dev_docs/framework/design-project-deepdive-example.md).
