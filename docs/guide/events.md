# Events & Hooks

The framework provides two complementary systems for observability and extensibility: the **EventBus** for fine-grained event subscriptions, and **Hooks** for structured lifecycle callbacks.

## EventBus

The EventBus is a type-safe, synchronous publish/subscribe system. All framework components communicate through it, so you can tap into any event flowing through the system.

### Subscribing to Events

```typescript
const session = new VoiceSession({ /* config */ });

// Subscribe returns an unsubscribe function
const unsubscribe = session.eventBus.subscribe('agent.transfer', (payload) => {
  console.log(`${payload.fromAgent} → ${payload.toAgent}`);
});

// Later: clean up
unsubscribe();
```

### Event Reference

#### Agent Events

| Event | Payload | When |
|-------|---------|------|
| `agent.enter` | `{ sessionId, agentName }` | Agent becomes active |
| `agent.exit` | `{ sessionId, agentName }` | Agent is being replaced |
| `agent.transfer` | `{ sessionId, fromAgent, toAgent }` | Transfer between agents |
| `agent.handoff` | `{ sessionId, agentName, subagentName, toolCallId }` | Tool handed off to subagent |

#### Tool Events

| Event | Payload | When |
|-------|---------|------|
| `tool.call` | `{ sessionId, agentName, id, name, args }` | LLM requests a tool call |
| `tool.result` | `{ sessionId, toolCallId, status, result }` | Tool execution completes |
| `tool.cancel` | `{ sessionId, toolCallIds }` | Tool calls cancelled (user interruption) |

#### Turn Events

| Event | Payload | When |
|-------|---------|------|
| `turn.start` | `{ sessionId, turnId }` | User begins speaking |
| `turn.end` | `{ sessionId, turnId }` | Model finishes its response |
| `turn.interrupted` | `{ sessionId, turnId }` | User interrupts the model |

#### GUI Events

| Event | Payload | When |
|-------|---------|------|
| `gui.update` | `{ sessionId, data }` | UI state update for the client |
| `gui.notification` | `{ sessionId, message }` | Notification for the client |

#### Session Events

| Event | Payload | When |
|-------|---------|------|
| `session.start` | `{ sessionId, userId, agentName }` | Session becomes active |
| `session.close` | `{ sessionId, reason }` | Session closed |
| `session.stateChange` | `{ sessionId, fromState, toState }` | State machine transition |
| `session.resume` | `{ sessionId, handle }` | Session resumed from handle |
| `session.goaway` | `{ sessionId, timeLeft }` | LLM server shutting down (Gemini-specific) |
| `context.compact` | `{ sessionId, removedItems }` | Conversation context compressed |

#### Subagent Events

| Event | Payload | When |
|-------|---------|------|
| `subagent.ui.send` | `{ sessionId, payload }` | Subagent sends UI data to client |
| `subagent.ui.response` | `{ sessionId, response }` | Client sends UI response to subagent |
| `subagent.notification` | `{ sessionId, result, event }` | Service subagent notification |

### Type Safety

The EventBus is fully typed. TypeScript narrows the payload type based on the event string:

```typescript
session.eventBus.subscribe('tool.call', (payload) => {
  // TypeScript knows: payload has sessionId, agentName, id, name, args
  console.log(`Tool: ${payload.name} called by ${payload.agentName}`);
});

session.eventBus.subscribe('session.stateChange', (payload) => {
  // TypeScript knows: payload has sessionId, fromState, toState
  console.log(`${payload.fromState} → ${payload.toState}`);
});
```

### Publishing Events

You can publish your own events on the bus (useful for custom integrations):

```typescript
session.eventBus.publish('gui.notification', {
  sessionId: 'session_123',
  message: 'Order confirmed!',
});
```

::: tip
Handler exceptions are caught and logged — they never propagate to the publisher. This means a buggy subscriber can't crash the audio stream.
:::

## Hooks

Hooks are structured callbacks for common lifecycle events. They're designed for observability — logging, metrics, alerting — without needing to know the internal event types.

### Registering Hooks

Pass hooks directly in the VoiceSession configuration:

```typescript
const session = new VoiceSession({
  hooks: {
    onSessionStart: (e) => {
      console.log(`Session started: ${e.sessionId} for user ${e.userId}`);
    },
    onSessionEnd: (e) => {
      console.log(`Session ended: ${e.sessionId} after ${e.durationMs}ms (${e.reason})`);
    },
    onToolCall: (e) => {
      metrics.increment('tool.calls', { tool: e.toolName, execution: e.execution });
    },
    onToolResult: (e) => {
      metrics.histogram('tool.duration', e.durationMs, { status: e.status });
    },
    onAgentTransfer: (e) => {
      console.log(`Transfer: ${e.fromAgent} → ${e.toAgent} (reconnect: ${e.reconnectMs}ms)`);
    },
    onError: (e) => {
      logger.error(`[${e.component}] ${e.error.message}`, {
        severity: e.severity,
        sessionId: e.sessionId,
      });
    },
  },
  // ...other config
});
```

### Hook Reference

| Hook | Event Shape | When |
|------|------------|------|
| `onSessionStart` | `{ sessionId, userId, agentName }` | LLM connection becomes ACTIVE |
| `onSessionEnd` | `{ sessionId, durationMs, reason }` | Session transitions to CLOSED |
| `onTurnLatency` | `{ sessionId, turnId, segments }` | End of each turn with latency breakdown |
| `onToolCall` | `{ sessionId, toolCallId, toolName, execution, agentName }` | Before tool execution |
| `onToolResult` | `{ toolCallId, durationMs, status, error? }` | After tool completes/cancels/errors |
| `onAgentTransfer` | `{ sessionId, fromAgent, toAgent, reconnectMs }` | After transfer completes |
| `onSubagentStep` | `{ subagentName, stepNumber, toolCalls, tokensUsed }` | Each background subagent LLM step |
| `onMemoryExtraction` | `{ userId, factsExtracted, durationMs }` | After memory extraction |
| `onError` | `{ sessionId?, component, error, severity }` | Any framework error |

### Latency Tracking

The `onTurnLatency` hook provides a segment-level breakdown of each turn:

```typescript
hooks: {
  onTurnLatency: (e) => {
    const { segments } = e;
    console.log(`Turn ${e.turnId} latency breakdown:`);
    console.log(`  Client → Backend:  ${segments.clientToBackendMs}ms`);
    console.log(`  Backend → LLM:     ${segments.backendToLLMMs}ms`);
    console.log(`  LLM processing:    ${segments.llmProcessingMs}ms`);
    console.log(`  LLM → Backend:     ${segments.llmToBackendMs}ms`);
    console.log(`  Backend → Client:  ${segments.backendToClientMs}ms`);
    console.log(`  Total E2E:         ${segments.totalE2EMs}ms`);
  },
}
```

### Error Handling

The `onError` hook is your centralized error handler. Errors are classified by severity:

| Severity | Meaning | Example |
|----------|---------|---------|
| `warn` | Recoverable, no user impact | Tool timeout, retry succeeded |
| `error` | Something failed, partial impact | Memory extraction failed |
| `fatal` | Session cannot continue | LLM connection lost permanently |

```typescript
hooks: {
  onError: (e) => {
    if (e.severity === 'fatal') {
      alerting.page(`Fatal error in session ${e.sessionId}: ${e.error.message}`);
    }

    sentry.captureException(e.error, {
      tags: { component: e.component, severity: e.severity },
      extra: { sessionId: e.sessionId },
    });
  },
}
```

## EventBus vs Hooks

| | EventBus | Hooks |
|---|---------|-------|
| **Granularity** | Every internal event (20+ types) | 9 high-level lifecycle events |
| **Use case** | Custom integrations, GUI updates | Logging, metrics, alerting |
| **Type safety** | Full payload typing per event | Structured event objects |
| **Error handling** | Exceptions caught and logged | Exceptions caught and logged |
| **Access** | `session.eventBus.subscribe(...)` | `VoiceSession({ hooks: {...} })` |

::: tip
Start with Hooks for observability. Use the EventBus when you need to react to specific internal events (like GUI updates or subagent interactions).
:::
