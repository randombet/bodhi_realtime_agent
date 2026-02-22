# Persistence

The framework supports three optional persistence stores, each handling a different aspect of session state:

| Store | What it persists | Scope |
|-------|-----------------|-------|
| **MemoryStore** | User facts (preferences, entities, decisions) | Across all sessions for a user |
| **ConversationHistoryStore** | Conversation transcript | Per session |
| **SessionStore** | Session checkpoint (active agent, resumption handle) | Per session |

## MemoryStore

Persists user-specific facts extracted from conversation. See [Memory](/guide/memory) for a complete guide.

```typescript
import { MarkdownMemoryStore } from 'bodhi-realtime-agent';

const session = new VoiceSession({
  memoryStore: new MarkdownMemoryStore('./memory'),
  // ...
});
```

### Built-in: MarkdownMemoryStore

Stores facts as Markdown files at `{baseDir}/{userId}.md`. Human-readable and Git-friendly.

### Custom Implementation

```typescript
interface MemoryStore {
  addFacts(userId: string, facts: MemoryFact[]): Promise<void>;
  getAll(userId: string): Promise<MemoryFact[]>;
  replaceAll(userId: string, facts: MemoryFact[]): Promise<void>;
}
```

## ConversationHistoryStore

Persists the full conversation transcript for replay, auditing, or analytics.

```typescript
interface ConversationHistoryStore {
  save(sessionId: string, items: ConversationItem[]): Promise<void>;
  load(sessionId: string): Promise<ConversationItem[]>;
}
```

### Example: File-based History

```typescript
import { writeFile, readFile } from 'fs/promises';

class FileHistoryStore implements ConversationHistoryStore {
  constructor(private dir: string) {}

  async save(sessionId: string, items: ConversationItem[]) {
    await writeFile(`${this.dir}/${sessionId}.json`, JSON.stringify(items, null, 2));
  }

  async load(sessionId: string) {
    const data = await readFile(`${this.dir}/${sessionId}.json`, 'utf-8');
    return JSON.parse(data);
  }
}
```

## SessionStore

Persists a `SessionCheckpoint` for crash recovery and session resumption:

```typescript
interface SessionCheckpoint {
  sessionId: string;
  userId: string;
  activeAgent: string;
  resumptionHandle: string | null;
  conversationItems: ConversationItem[];
  conversationSummary: string | null;
  pendingToolCalls: PendingToolCall[];
  timestamp: number;
}
```

This enables recovering a session after a server restart — the framework can reconnect to Gemini using the stored resumption handle and restore the conversation context.

### Built-in: InMemorySessionStore

A simple in-memory store for development. Data is lost on restart.

### Custom Implementation

```typescript
interface SessionStore {
  save(checkpoint: SessionCheckpoint): Promise<void>;
  load(sessionId: string): Promise<SessionCheckpoint | null>;
  delete(sessionId: string): Promise<void>;
}
```

## Putting It All Together

```typescript
const session = new VoiceSession({
  // Memory: persists user facts across sessions
  memoryStore: new MarkdownMemoryStore('./data/memory'),

  // Conversation: persists transcripts
  conversationHistoryStore: new FileHistoryStore('./data/history'),

  // Session: enables crash recovery
  sessionStore: new RedisSessionStore(redisClient),

  // ...other config
});
```

::: tip
All stores are optional. Start with just `memoryStore` for cross-session memory, and add the others as your needs grow.
:::
