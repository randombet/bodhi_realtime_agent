<!-- SPDX-License-Identifier: MIT -->

# Post-Session Processor — verification demo

Executable spec for the architecture in
[`dev_docs/framework/design-post-session-processor.md`](../../dev_docs/framework/design-post-session-processor.md).

The pipeline is **not yet implemented in `src/`**. This demo is a self-contained
*reference implementation* of the top-level contracts (`PostSessionProcessor`,
`PostSessionPipeline`, `PostSessionSnapshotBuilder`, …) plus an assertion harness that proves
the design's headline invariants actually hold together. Think of it as the design doc's
"does this even type-check and run?" companion — and as a starting point for the real
`src/post-session/` implementation.

It mirrors the **simplified shape**: there is no coordinator and no `session.close`
subscription. A single `closeWithReason` funnel (modeled by `SessionCloseDriver`) calls
`pipeline.dispatch({ sessionId, reason, build })` directly with a `build` thunk, and the
close-in-progress guard provides exactly-once dispatch.

## Run

```bash
# Verification harness (invariants, EmailProcessor with a capturing fake sender):
pnpm tsx examples/post-session-processor/post-session-processor-demo.ts

# Email a session summary to a specific address (see "Email summary example" below):
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com
```

No API keys or network needed for either. The demo exits non-zero if any invariant fails,
so it doubles as a smoke test.

## Email summary example

[`email-summary.ts`](./email-summary.ts) is a runnable example of the **`EmailSender`
capability**: it drives the **real** `InMemoryPostSessionPipeline` from `src/post-session/`
with an `EmailSummaryProcessor` that summarizes a (sample) ended session's conversation and
sends the summary + full transcript to a chosen recipient via a pluggable sender.

Senders:

- **console** (default) — prints the composed email; safe, no network.
- **apple** — sends (or drafts) through macOS Mail.app via
  [`examples/lib/apple-mail-sender.ts`](../lib/apple-mail-sender.ts).

```bash
# Print the email that would be sent (default recipient demo@example.com):
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com
POST_SESSION_EMAIL_TO=you@example.com pnpm tsx examples/post-session-processor/email-summary.ts

# macOS: create a Mail.app draft (safe) or actually send:
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com --apple --draft
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com --apple
```

The `EmailSummaryProcessor` takes its `EmailSender` + recipient as constructor config
(shared across sessions → reentrant) and reads the frozen `ctx.conversation` snapshot for
the summary — no LLM, so it runs offline. A production build would swap the deterministic
summary for an LLM `SummaryProcessor` and expose the sender as an `email` capability on
`PostSessionStores`.

## What it verifies

| # | Invariant | Design section |
|---|-----------|----------------|
| 1 | **Exactly-once dispatch** per ended session — a re-entrant `closeWithReason` (e.g. `close()` racing a reconnect-fail path) dispatches once | Single dispatch point |
| 2 | **Dependency ordering** — `analytics` and `email` (`dependsOn: ['summary']`) see the summary the `summary` processor wrote through `ctx.stores` | Execution semantics → Ordering |
| 3 | **Failure isolation** — a throwing processor becomes a `failed` result and never aborts its siblings | Execution semantics → Isolation |
| 4 | **Dependency-failed skip** — a dependent of a failed processor is `skipped` (`detail.reason: dependency_failed`) and its `run()` is never called | `dependsOn` |
| 5 | **`failed_to_start`** — when the `build` thunk throws, the run resolves with `outcome: 'failed_to_start'` / `failureReason: 'snapshot_failed'` and no hang | Single emitter |
| 6 | **Reason preservation** — the caller's close reason (`reconnect_failed`) reaches `PostSessionSnapshot.reason`, the memory write, and the email subject | Reason-preservation invariant |
| 7 | **Email delivery** — `EmailProcessor` sends exactly one message addressed to the user, whose body contains **both** the summary and the full transcript, and only after `summary` ran | (sample processor) |
| 8 | **Backpressure** — at zero capacity an optional-only run is `dropped` (`queue_overflow`); a run containing a `required` processor is admitted; both still emit on `pipeline.events` | Shedding model |
| 9 | **`freeze()` validation** — missing dependencies and a `required`-depends-on-optional edge are rejected at boot, not at first close | Registry validation |
| 10 | **Single completion channel** — `pipeline.events.onProcessed` fires exactly once per run, including for `dropped` and `failed_to_start` runs, not just accepted ones | One completion channel |

## The email processor

`EmailProcessor` (`dependsOn: ['summary']`) composes a message — `Summary:` + the
`summary` processor's output, then the full transcript — and sends it through an
`EmailSender` capability exposed on `ctx.stores.email`. The demo wires a **`CapturingEmailSender`**
(records messages in memory) so the run is deterministic and offline; the harness then
asserts the captured message contains both the summary and the transcript.

To send **real** email in production, implement `EmailSender.send()` with SMTP or a provider
and expose it on `PostSessionStores.email` — the processor itself does not change. (In this
repo, the Gmail tooling / `gws-gmail` skill is one such backend.)

## What it intentionally simplifies

This is a spec, not the product. To stay readable it:

- runs processors **dependency-ordered sequentially** for deterministic logs; the real
  pipeline runs independent processors **concurrently** (decided — see "Resolved Decisions"
  in the design doc), bounded by the backpressure cap;
- models the `required` admission bounded-wait as "always admit required" (no real wait
  queue / `required_capacity_timeout` timer);
- omits the wall-clock budget `Promise.race` / `drain_timeout` machinery;
- uses trivial in-memory `stores` (`memory`, `summaries`, capturing `email`) instead of real
  `MemoryStore` / `ConversationHistoryStore` / mail backend.

These omissions are noted inline in
[`post-session-processor-demo.ts`](./post-session-processor-demo.ts) where they occur.

## Mapping to the real implementation

When `src/post-session/` lands, the inline contracts here should be deleted and imported
from `src/` instead; the sample processors (`SummaryProcessor`, `MemoryProcessor`,
`AnalyticsProcessor`, `EmailProcessor`) become templates for the real
`MemoryDistillationProcessor`, the history-finalize processor, and an email/notification
processor described in the design's Execution Steps.
