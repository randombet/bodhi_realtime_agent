# Post-Session Processor — examples

Runnable companions to the post-session processing pipeline.
Both scripts drive the **real** `InMemoryPostSessionPipeline` from `src/post-session/`, so
they cannot drift from production behavior.

```bash
# Verification harness — asserts the headline invariants; exits non-zero on failure:
pnpm tsx examples/post-session-processor/post-session-processor-demo.ts

# Email a session summary to a specific address (see below):
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com
```

No API keys or network needed for either.

## `post-session-processor-demo.ts`

Registers sample processors on the real pipeline and asserts the design's headline
invariants (a CI-friendly smoke test):

| Invariant | Design section |
|-----------|----------------|
| **Dependency ordering** — `summary` runs before its dependents (`analytics`, `email`) | Execution semantics → Ordering |
| **Failure isolation** — a throwing processor becomes a `failed` result and never aborts siblings | Execution semantics → Isolation |
| **Dependency-failed skip** — a dependent of a failed processor is `skipped` (`detail.reason: dependency_failed`); its `run()` never executes | `dependsOn` |
| **Email** — the `EmailProcessor` sends exactly one message to the user, body containing **both** summary and full transcript, only after `summary` ran | Step 7 / EmailSender |
| **`failed_to_start`** — a throwing `build` thunk → `outcome: 'failed_to_start'` / `failureReason: 'snapshot_failed'`, still emitted | Single emitter |
| **Reason preservation** — the caller close reason reaches `PostSessionSnapshot.reason` | Reason-preservation invariant |
| **Backpressure** — at capacity, an optional-only run is `dropped` (`queue_overflow`); a required run **bounded-waits** and either runs when a slot frees or resolves `required_capacity_timeout` | Shedding model |
| **`freeze()` validation** — missing deps and `required`-depends-on-optional are rejected at boot | Registry validation |
| **Single completion channel** — `pipeline.events.onProcessed` fires once per run (including `dropped` / `failed_to_start`) | One completion channel |

The demo uses a small module-level `summaries` map + `trace` array to hand the summary
between processors and assert ordering (a demo convenience; production would carry cross-step
data on a `PostSessionStores` capability). The `EmailProcessor` takes a `CapturingEmailSender`
via its constructor (static config → reentrant).

## `email-summary.ts`

A focused example of the **`EmailSender`** capability: an `EmailSummaryProcessor` summarizes a
(sample) ended session's conversation and sends the summary + full transcript to a chosen
recipient via a pluggable sender.

Senders:

- **console** (default) — prints the composed email; safe, no network.
- **apple** — sends (or drafts) through macOS Mail.app via
  [`examples/lib/apple-mail-sender.ts`](../lib/apple-mail-sender.ts).

```bash
# Print the email that would be sent (recipient via arg or POST_SESSION_EMAIL_TO):
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com
POST_SESSION_EMAIL_TO=you@example.com pnpm tsx examples/post-session-processor/email-summary.ts

# macOS: create a Mail.app draft (safe) or actually send:
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com --apple --draft
pnpm tsx examples/post-session-processor/email-summary.ts you@example.com --apple
```

The processor takes its `EmailSender` + recipient as constructor config and reads the frozen
`ctx.conversation` snapshot for a deterministic (no-LLM) summary, so it runs offline. A
production build would swap the deterministic summary for an LLM `SummaryProcessor`
(`dependsOn: ['summary']`) and promote `EmailSender` to a first-class `PostSessionStores.email`
capability (see Steps 7 / 7a in the design doc).
