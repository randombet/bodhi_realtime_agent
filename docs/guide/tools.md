# Tools

Tools are callable functions exposed to the live model.

## Execution modes

- `inline`: blocking, result returned in-turn
- `background`: async handoff to subagent

On `gemini-3.8-live` — the default Live model — every function is declared
`BLOCKING` unless the tool sets `behavior` or the session sets
`functionBehavior`. That model would otherwise run an undeclared call
`NON_BLOCKING` and end its turn before the result exists. Other Live models,
including `gemini-3.1-flash-live-preview` and the 2.5 native-audio models, are
sent no `behavior` and keep the server default they were measured with. Set
`'NON_BLOCKING'` to opt into asynchronous calls, or `'BLOCKING'` to ask for it
on a model that does not get it by default.

## Tool basics

Each tool defines:

- `name`, `description`
- `parameters` (zod schema)
- `execution`
- `execute(args, ctx)`

## Artifact Pipeline (Cross-Tool Data Flow)

The framework supports per-session artifact sharing across tools and subagents.

Use this when one tool generates binary data (image/document) and another tool needs it later (email, analysis, relay).

Typical flow:

1. Generator tool stores artifact in registry.
2. Registry returns `artifactId`.
3. Downstream tool receives `artifactId` and materializes/forwards data.

This avoids embedding base64 into prompt text and keeps handoffs structured.
