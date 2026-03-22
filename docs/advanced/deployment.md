# Deployment

This guide covers deploying the framework in production: environment variables, error handling, graceful shutdown, and session management.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_API_KEY` | For Gemini | Google Gemini API key |
| `OPENAI_API_KEY` | For OpenAI | OpenAI API key |
| `PORT` | No | WebSocket server port (default: 9900) |

```bash
# .env — set the key for your chosen provider
GOOGLE_API_KEY=your_gemini_key_here
OPENAI_API_KEY=your_openai_key_here
PORT=9900
```

::: warning
Never commit API keys to version control. Use environment variables or a secrets manager.
:::

## Graceful Shutdown

Always close sessions cleanly to release resources:

```typescript
const session = new VoiceSession({ /* config */ });
await session.start();

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down...`);
  await session.close('server_shutdown');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

The `close()` method:
1. Notifies the active agent via `onExit`
2. Triggers memory extraction (if configured)
3. Saves session checkpoint (if configured)
4. Disconnects from the LLM provider
5. Closes the client WebSocket server

## Error Handling

Use the `onError` hook for centralized error handling:

```typescript
const session = new VoiceSession({
  hooks: {
    onError: (e) => {
      console.error(`[${e.severity}] [${e.component}] ${e.error.message}`);

      if (e.severity === 'fatal') {
        // Session is unrecoverable — close and restart
        session.close('fatal_error').then(() => process.exit(1));
      }
    },
  },
});
```

### Error Severities

| Severity | Action |
|----------|--------|
| `warn` | Log and continue |
| `error` | Log, alert, continue with degraded functionality |
| `fatal` | Log, alert, close session and restart |

## Session Management

For production deployments handling multiple concurrent users, create one `VoiceSession` per user connection:

```typescript
import { createServer } from 'http';

const httpServer = createServer();
const sessions = new Map<string, VoiceSession>();

// Create a new session for each user
function createSession(userId: string): VoiceSession {
  const sessionId = `session_${Date.now()}_${userId}`;
  const session = new VoiceSession({
    sessionId,
    userId,
    apiKey: process.env.GOOGLE_API_KEY!,
    agents: [mainAgent],
    initialAgent: 'main',
    port: 0, // Dynamically assigned
  });

  sessions.set(sessionId, session);
  return session;
}

// Clean up on disconnect
async function destroySession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (session) {
    await session.close('user_disconnect');
    sessions.delete(sessionId);
  }
}
```

## Health Checks

Monitor session health using hooks and the session state:

```typescript
// Check session state
const state = session.sessionManager.state; // 'ACTIVE', 'RECONNECTING', etc.

// Track active sessions
hooks: {
  onSessionStart: () => metrics.gauge('active_sessions', sessions.size),
  onSessionEnd: () => metrics.gauge('active_sessions', sessions.size),
}
```

## Production Best Practices

### Session Routing for Multi-Session Agents

When integrating with stateful external agents (like OpenClaw), each user request may need to be routed to an existing session or a new one. The framework supports this with three components:

- **Session Registry** — Tracks active sessions per user with status (`active`, `completed`, `error`, `stale`), recent conversation turns, and task domain. Caps at 20 sessions with oldest-first eviction.
- **Session Classifier** — An LLM call (with 3-second hard timeout) that decides whether to continue an existing session, join a provisioning route, or create a new session. Falls back to `create_new` on any error.
- **Routing Mutex** — Serializes classifier + registry mutations to prevent race conditions when multiple requests arrive simultaneously.

### Concurrent Task Management

For parallel background tasks, use a task manager pattern:

- **Semaphore** — Cap concurrent tasks (default: 10) to prevent unbounded fan-out
- **Write-lock serialization** — Mutating operations on the same domain (e.g., two calendar reschedules) are serialized, while independent tasks run in parallel
- **Queue notifications** — When slots are full, notify users via voice and GUI that tasks are queued
- **Thread TTL** — Idle threads expire after 10 minutes (configurable)

### Artifact Lifecycle

Generated artifacts (images, files) are stored in-memory per session:

- Max 20 artifacts or 50 MB total per session
- 30-minute TTL with FIFO eviction
- Artifacts are not persisted to disk — they exist only for the session's lifetime
- Call `artifactRegistry.dispose()` on session close

## GitHub Pages Deployment

The documentation site can be deployed to GitHub Pages. See the GitHub Actions workflow in `.github/workflows/docs.yml` for automated deployment on push to `main`.

```yaml
# .github/workflows/docs.yml
name: Deploy docs
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g pnpm && pnpm install
      - run: pnpm docs:build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs/.vitepress/dist
      - uses: actions/deploy-pages@v4
```
