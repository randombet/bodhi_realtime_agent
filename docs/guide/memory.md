# Memory

Memory stores durable user facts across sessions.

## How it works

1. Conversation turns are processed by a memory distiller.
2. Durable facts are extracted and persisted in a `MemoryStore`.
3. Relevant facts are injected into future context.

## Default store

The app server commonly uses a JSON memory store under `./memory`.

## When to use

Use memory for:

- stable user preferences
- long-term context
- personalization
