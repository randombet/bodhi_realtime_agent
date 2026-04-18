# Tools

Tools are callable functions exposed to the live model.

## Execution modes

- `inline`: blocking, result returned in-turn
- `background`: async handoff to subagent

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
