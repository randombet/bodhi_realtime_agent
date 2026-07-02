<!-- SPDX-License-Identifier: MIT -->

# Agent Composer example

Non-interactive demo of the [Agent Composer](../../composer/) — it drives the
generation pipeline over a canned requirement ("a friendly cooking assistant that can
do math and tell the time") and writes a runnable `AgentDefinitionV2` to a file store.

## Run (live)

Needs a Gemini key for the Composer's own `generateObject` call:

```bash
GEMINI_API_KEY=...  pnpm tsx examples/composer/build-agent.ts
# writes ./user-agents/cli-local/ua_<id>.json  (override dir with COMPOSER_STORE_DIR)
```

## Hermetic test

`examples/test/composer-build-agent.test.ts` injects a fake `generateObject` and an
in-memory store, so it runs under `pnpm test` with **no API keys** — part of the
default regression net.

## Scope (V1)

Single `main` agent, inline tools only (`calculate`, `get_current_time`,
`end_session`), no workers / KB / telephony. Validation is dependency-light (Zod +
catalog); the full `compileAgentDefinition` / session-startup dry-runs are deferred
until the `app/lib` import blocker is resolved. See
[`dev_docs/framework/design-agent-composer.md`](../../dev_docs/framework/design-agent-composer.md).
