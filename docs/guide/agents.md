# Agents

Main agents define conversation behavior and available tools.

A `MainAgent` typically includes:

- `name`
- `instructions`
- `tools`
- optional transfer hooks (`onEnter`, `onExit`)
- optional provider options

## Multi-agent routing

You can register multiple agents and transfer between them with `transfer_to_agent`.

Common pattern:

- `main` agent handles general requests
- specialist agent handles domain-specific tasks (math, coding, etc.)

## Subagents

Subagents are background workers for long-running tasks.

See [Subagent Patterns](/advanced/subagents).
