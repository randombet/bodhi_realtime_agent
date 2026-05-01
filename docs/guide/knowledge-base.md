# Knowledge base (framework)

The framework can attach a **structured knowledge base** to a **`MainAgent`**: documents are loaded, split into prompt vs tool-backed chunks, and optionally exposed as an inline **`search_knowledge_base`** tool. This page explains how to integrate KB for **main** vs **subagents**, and how it differs from **persistent memory**.

## Configuration

- Types: `KnowledgeBaseConfig`, `KnowledgeBaseDocument` in `src/types/knowledge-base.ts`.
- Processing: `processKnowledgeBase()` in `src/knowledge/knowledge-base-processor.ts`.
- Main agent wiring: `resolveAgentWithKnowledgeBase()` in `src/agent/agent-context.ts` merges processed KB into **system instructions** and appends the search tool to the **main agent’s tool list**.

`MainAgent` carries an optional field:

```ts
knowledgeBase?: KnowledgeBaseConfig;
```

Documents use `source: 'text'` (inline string) or `source: 'file'` (path resolved at process time; optional `KnowledgeBaseProcessContext.readFileText` in `src/types/knowledge-base.ts` lets hosts override file reads without coupling `src/` to a specific store).

## Main agent vs subagents

| Aspect | Main (voice) agent | Subagents (background tools) |
|--------|-------------------|------------------------------|
| **Where KB is configured** | `MainAgent.knowledgeBase` on each main agent compiled into `VoiceSessionConfig.agents`. | `SubagentConfig` has **no** `knowledgeBase` field. |
| **How KB reaches the model** | Full pipeline: prompt injection string appended to instructions + optional **`search_knowledge_base`** tool registered on the **live** LLM session. | A **text summary** of the KB prompt slice only: `VoiceSession` passes `processedKnowledgeBase.promptInjection` into `AgentRouter` as `getKnowledgeBaseContext`, which flows into `ConversationContext.getSubagentContext(..., knowledgeBaseContext)` and then into `buildSubagentSystemPrompt()` in `src/agent/subagent-runner.ts` under a `# Knowledge Base` section. |
| **Tool retrieval (`mode: 'tool'`)** | Yes — chunked docs and semantic-ish keyword search via the generated inline tool on the **main** agent. | **No** — subagents do not receive the main’s `search_knowledge_base` tool automatically. They only see the **prompt-routed** portion of the KB as static text. |
| **Per-agent isolation** | Each `MainAgent` can have its own `knowledgeBase` (e.g. after `transfer_to_agent`). | All background runs for the session share the **same** `getKnowledgeBaseContext` callback (from the session’s current processed KB state / active main resolution). |

**Practical guidance**

- Put reference material the **voice** agent must cite or search during the call on **`MainAgent.knowledgeBase`**.
- If a **subagent** must do heavy retrieval over a large corpus, either keep that corpus in **smaller prompt-friendly** excerpts in the main KB (so it appears in `knowledgeBaseContext`), or give the subagent its **own** tools / workers (e.g. HTTP worker, custom tool) that fetch data — do not assume the generic KB search tool exists inside `runSubagent`.

## Relation to memory

- **`MemoryStore`** — long-lived user facts; updated by distillation / tools. Not a document corpus.
- **`KnowledgeBaseConfig`** — session compile-time corpus for **instructions + optional search tool** on the main agent, plus the **prompt-only** excerpt for subagents as above.

## App layer (Bodhi server)

Hosted Agent Studio resolves Supabase-backed attachments **before** compile and passes **`source: 'text'`** into the framework. See **`app/docs/agent-studio-knowledge-base.md`** in this repository for upload paths, lifecycle, and naming.
