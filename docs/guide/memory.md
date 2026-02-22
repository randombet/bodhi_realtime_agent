# Memory

Memory gives your voice agent the ability to remember users across sessions. The framework automatically extracts facts from conversation ("prefers dark mode", "works at Acme Corp") and makes them available to agents on future calls.

## How It Works

```
Conversation → MemoryDistiller → MemoryStore → Agent Instructions
                   (LLM)          (storage)      (next session)
```

1. The **MemoryDistiller** periodically scans recent conversation turns
2. An LLM extracts durable facts (preferences, entities, decisions, requirements)
3. Facts are persisted to a **MemoryStore** (one file per user)
4. On the next session, agents can read these facts via lifecycle hooks

## Quick Setup

```typescript
import { VoiceSession, MarkdownMemoryStore } from 'bodhi-realtime-agent';

const session = new VoiceSession({
  // ...required config
  memoryStore: new MarkdownMemoryStore('./memory'),
});
```

That's it. The framework handles extraction, storage, and retrieval automatically.

## MarkdownMemoryStore

The built-in `MarkdownMemoryStore` persists facts as human-readable Markdown files, one per user:

```
memory/
  user_1.md
  user_2.md
```

Each file is organized by category:

```markdown
## Preferences

- Prefers dark mode
- Likes concise answers
- Speaks Spanish and English

## Entities

- Works at Acme Corp
- Manager's name is Sarah

## Decisions

- Chose the Pro plan over Enterprise

## Requirements

- Needs HIPAA-compliant storage
```

### Usage

```typescript
import { MarkdownMemoryStore } from 'bodhi-realtime-agent';

const store = new MarkdownMemoryStore('./memory');

// Reads are simple
const facts = await store.getAll('user_1');
// → [{ content: 'Prefers dark mode', category: 'preference', timestamp: 0 }, ...]

// Writes are atomic (safe for concurrent access)
await store.addFacts('user_1', [
  { content: 'Prefers dark mode', category: 'preference', timestamp: Date.now() },
]);
```

## Memory Categories

Facts are classified into four categories:

| Category | What it captures | Example |
|----------|-----------------|---------|
| `preference` | User likes, dislikes, style choices | "Prefers formal language" |
| `entity` | People, places, organizations | "Works at Acme Corp" |
| `decision` | Choices the user has made | "Chose monthly billing" |
| `requirement` | Constraints or needs | "Needs wheelchair access" |

## MemoryDistiller

The `MemoryDistiller` is the component that extracts facts from conversation. It runs automatically when you provide a `memoryStore` to `VoiceSession`.

### Extraction Triggers

| Trigger | When it fires |
|---------|---------------|
| Turn-based | Every N turns (default: every 5th turn) |
| Checkpoint | On agent transfer, tool result, session close |
| On-demand | When you call `forceExtract()` |

### Configuration

The distiller is configured automatically by VoiceSession, but you can control the extraction frequency:

```typescript
// The distiller extracts every 5 turns by default.
// It uses the Vercel AI SDK model you pass to VoiceSession.
const session = new VoiceSession({
  model: google('gemini-2.0-flash'), // Used for memory extraction
  memoryStore: new MarkdownMemoryStore('./memory'),
  // ...other config
});
```

### Coalescing

Only one extraction runs at a time. If multiple triggers fire while an extraction is in progress, they are silently skipped. This prevents redundant LLM calls during rapid conversation.

### Consolidation

Over time, a user's memory file may accumulate duplicate or contradictory facts. The `consolidate()` method merges them using an LLM call:

```typescript
// Periodic maintenance (e.g. in a cron job)
await distiller.consolidate();
```

Before:
```markdown
## Preferences
- Likes dark mode
- Prefers dark theme
- Changed to light mode
```

After consolidation:
```markdown
## Preferences
- Prefers light mode (previously preferred dark mode)
```

## Using Memory in Agents

### Via Lifecycle Hooks

The most common pattern — inject remembered facts when an agent activates:

```typescript
const agent: MainAgent = {
  name: 'assistant',
  instructions: 'You are a helpful assistant.',
  tools: [],

  async onEnter(ctx) {
    const facts = ctx.getMemoryFacts();
    if (facts.length > 0) {
      const summary = facts.map(f => `- ${f.content}`).join('\n');
      ctx.injectSystemMessage(
        `Here's what you know about this user:\n${summary}`
      );
    }
  },
};
```

### Via Turn Hooks

React to each turn based on accumulated knowledge:

```typescript
const agent: MainAgent = {
  name: 'support',
  instructions: 'You are a support agent.',
  tools: [],

  async onTurnCompleted(ctx, transcript) {
    const facts = ctx.getMemoryFacts();
    const isVIP = facts.some(f => f.content.includes('VIP'));
    if (isVIP) {
      ctx.injectSystemMessage('This is a VIP customer. Prioritize their request.');
    }
  },
};
```

## Custom MemoryStore

Implement the `MemoryStore` interface to use your own storage backend (database, Redis, cloud storage):

```typescript
import type { MemoryStore, MemoryFact } from 'bodhi-realtime-agent';

class PostgresMemoryStore implements MemoryStore {
  async addFacts(userId: string, facts: MemoryFact[]): Promise<void> {
    await db.query(
      'INSERT INTO memory_facts (user_id, content, category, timestamp) VALUES ...',
      facts.map(f => [userId, f.content, f.category, f.timestamp])
    );
  }

  async getAll(userId: string): Promise<MemoryFact[]> {
    const rows = await db.query(
      'SELECT content, category, timestamp FROM memory_facts WHERE user_id = $1',
      [userId]
    );
    return rows;
  }

  async replaceAll(userId: string, facts: MemoryFact[]): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM memory_facts WHERE user_id = $1', [userId]);
      if (facts.length > 0) {
        await tx.query(
          'INSERT INTO memory_facts (user_id, content, category, timestamp) VALUES ...',
          facts.map(f => [userId, f.content, f.category, f.timestamp])
        );
      }
    });
  }
}
```

::: tip
Implementations must be safe for concurrent reads and writes. The built-in `MarkdownMemoryStore` uses `write-file-atomic` for this.
:::

## Observability

Track memory extraction via the `onMemoryExtraction` hook:

```typescript
const session = new VoiceSession({
  hooks: {
    onMemoryExtraction: (event) => {
      console.log(`Extracted ${event.factsExtracted} facts for ${event.userId} in ${event.durationMs}ms`);
    },
  },
  // ...other config
});
```
