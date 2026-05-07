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
- `onAgentTransfer`
- `onTurnLatency`
- `onMemoryExtraction`
- `onBackgroundNotification` — fired when a background notification (BackgroundAgent, tool-completion bridge, interactive subagent question, or `VoiceSession.notifyBackground`) is delivered to the LLM. The event includes `label`, `priority`, `publishedAtMs`, `deliveredAtMs`, `deferredMs`, and the envelope `correlationId`. See [Background Agents](/advanced/background-agents).
- `onError`

Hooks are ideal for logging, tracing, and metrics.
