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
import { VoiceSession, JsonMemoryStore } from '@bodhi_agent/realtime-agent-framework';

const session = new VoiceSession({
  // ...required config
  memory: {
    store: new JsonMemoryStore('./memory'),
  },
});
```

That's it. The framework handles extraction, storage, and retrieval automatically.

## JsonMemoryStore

The built-in `JsonMemoryStore` persists facts and directives as JSON files, one per user:

```
memory/
  user_1.json
  user_2.json
```

Each file contains directives (behavior presets) and categorized facts:

```json
{
  "directives": {
    "pacing": "slow",
    "verbosity": "concise"
  },
  "facts": [
    { "content": "Prefers dark mode", "category": "preference" },
    { "content": "Works at Acme Corp", "category": "entity" },
    { "content": "Chose the Pro plan over Enterprise", "category": "decision" },
    { "content": "Needs HIPAA-compliant storage", "category": "requirement" }
  ]
}
```

### Usage

```typescript
import { JsonMemoryStore } from '@bodhi_agent/realtime-agent-framework';

const store = new JsonMemoryStore('./memory');

// Read facts
const facts = await store.getAll('user_1');
// → [{ content: 'Prefers dark mode', category: 'preference', timestamp: 0 }, ...]

// Read/write directives (behavior presets)
const directives = await store.getDirectives('user_1');
await store.setDirectives('user_1', { pacing: 'slow' });

// Writes are atomic (safe for concurrent access)
await store.replaceAll('user_1', updatedFacts);
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
  model: google('gemini-2.5-flash'), // Used for memory extraction
  memoryStore: new MarkdownMemoryStore('./memory'),
  // ...other config
});
```

### Coalescing

Only one extraction runs at a time. If multiple triggers fire while an extraction is in progress, they are silently skipped. This prevents redundant LLM calls during rapid conversation.

### Merge-on-Write

Each extraction produces the **complete updated fact list** — existing facts plus newly extracted facts, with duplicates removed and contradictions resolved. The LLM sees both the existing memory and recent conversation, then outputs the merged result which replaces all stored facts. This eliminates the need for a separate consolidation step.

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
import type { MemoryStore, MemoryFact } from '@bodhi_agent/realtime-agent-framework';

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

  async getDirectives(userId: string): Promise<Record<string, string>> {
    const row = await db.query(
      'SELECT directives FROM memory_directives WHERE user_id = $1',
      [userId]
    );
    return row?.directives ?? {};
  }

  async setDirectives(userId: string, directives: Record<string, string>): Promise<void> {
    await db.query(
      'INSERT INTO memory_directives (user_id, directives) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET directives = $2',
      [userId, directives]
    );
  }
}
```

::: tip
Implementations must be safe for concurrent reads and writes. The built-in `JsonMemoryStore` uses `write-file-atomic` for this.
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
