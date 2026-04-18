# Events & Hooks

The framework exposes a typed EventBus and lifecycle hooks for observability and integration.

## EventBus

Use EventBus to publish/subscribe runtime events such as:

- turn boundaries
- tool lifecycle
- GUI updates
- subagent interaction events

## Hooks

Common hooks include:

- `onSessionStart`
- `onSessionEnd`
- `onToolCall`
- `onToolResult`
- `onSubagentStep`
- `onError`

Hooks are ideal for logging, tracing, and metrics.
