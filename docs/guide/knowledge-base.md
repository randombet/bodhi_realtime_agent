# Knowledge base (framework)

The framework can attach a **structured knowledge base** to a **`MainAgent`**: documents are loaded, split into prompt vs tool-backed chunks, and optionally exposed as an inline **`search_knowledge_base`** tool. This page explains how to integrate KB for **main** vs **subagents**, and how it differs from **persistent memory**.

**Also read (product / hosted Studio):** `app/docs/agent-studio-knowledge-base.md` — upload limits, persisted shapes, and what the web UI exposes. When answering user questions about KB, use **both** docs.

## Layers: memory vs prompt KB vs “retrieval” (tool KB)

These are **separate mechanisms** in the codebase; KB is not a special case of memory, and “search” in KB does not mean Google or the open web.

| Layer | What it is | Where it shows up |
|--------|------------|-------------------|
| **Memory** | Durable **facts** / directives per user (`MemoryStore`), updated by distillation and tools. | Injected via memory / distiller prompts and related hooks — **not** `KnowledgeBaseConfig`. |
| **KB → prompt** | **Static text** appended to the main agent’s **system instructions** (plus the same **prompt-only** slice passed to subagents as `knowledgeBaseContext`). | `processKnowledgeBase()` → `promptInjection` → `resolveAgentWithKnowledgeBase()`. |
| **KB → tool path (“retrieval-lite”)** | Documents routed to **`tool`** (or large **`auto`** docs) are **chunked** and indexed **in memory** for this session’s processed KB only. | The framework appends **one** auto-generated **inline** tool named **`search_knowledge_base`**. The model **chooses** to call it; the tool returns **chunk text** from that index. |

So: **prompt KB** = always visible (up to context limits). **Tool KB** = on-demand pull via **`search_knowledge_base`** only on the **main** voice agent. There is **no** separate pluggable “retrieval service” interface in `src/` today — if you need vector DB / SQL / web RAG, you add normal **`ToolDefinition`s** (or subagent workers) yourself.

## What `search_knowledge_base` is (exactly)

- **Internal to the framework:** `processKnowledgeBase()` in `src/knowledge/knowledge-base-processor.ts` **constructs** a `ToolDefinition` with **`name: 'search_knowledge_base'`** (fixed string). It is **not** something you register by hand under a different name for the same behavior.
- **Not generic search:** It only queries the **in-process chunk list** built from **this** `MainAgent.knowledgeBase` config. It does **not** hit the network, your DB, or embedding APIs unless you build that elsewhere.
- **“Search” here means:** tokenize query + chunks, score overlap (TF–IDF-style), return up to **`maxResults`** chunks (default **5**). Query length is constrained by Zod on the tool schema (**2–500** characters).
- **When it exists:** Only if at least one document ends up in the **tool-routed** set after `auto` / `tool` splitting. If everything is prompt-injected, **`searchTool` is omitted** — there is nothing to call.

## Pure text — and what abstractions exist for load / edit

**Yes:** the KB pipeline assumes **plain text** after loading. Sources are `text` (already a string) or `file` (read as UTF-8 into a string). There is **no** structured document model (pages, tables, PDF boxes) inside the framework.

| Concern | Abstraction in `src/` |
|--------|------------------------|
| **Read / load `file`** | Default: sync **`readFileSync`** with `cwd` resolution. Optional: **`KnowledgeBaseProcessContext.readFileText`** passed into `processKnowledgeBase()` so hosts can read from sandboxes, object storage, etc., without changing core logic. |
| **Read / load hosted bytes** | **Not in `src/`** — the Bodhi app downloads Storage objects and passes **`source: 'text'`** into the framework (`materialize-knowledge-base-attachments.ts`). |
| **Edit / modify KB at runtime** | **No** dedicated KB editor API. You change **`MainAgent.knowledgeBase`** (or persisted Studio JSON), then re-run **`resolveAgentWithKnowledgeBase`** / rebuild the session config so the processor runs again. |

## What the framework treats as “knowledge” (formats & limits)

These rules apply to **`KnowledgeBaseConfig`** after your app (or built-ins) supply documents. There is **no** built-in PDF, Word, or HTML parser — content is **plain text** end-to-end for processing.

| Topic | Behavior |
|--------|----------|
| **Document sources** | Each document is `source: 'text'` (string in memory) or `source: 'file'` (path on disk, read as **UTF-8** text via `readFileSync`, or via optional `KnowledgeBaseProcessContext.readFileText`). |
| **Encoding** | Content is interpreted as **UTF-8 text**. Binary files (PDF, DOCX, images) are **not** decoded into structure; at best you get garbage or decode errors, and the document may be **skipped**. |
| **Recommended file types for `file`** | `.txt`, `.md`, `.csv`, `.json` (UTF-8), or any export that is already **linear text**. |
| **Per-document mode** | `prompt` (always in system string), `tool` (chunked + `search_knowledge_base` only on **main** agent), `auto` (framework picks by size). |
| **`auto` threshold** | Default **50 000 characters** total for auto-mode docs before routing to the tool path (`autoPromptThreshold` on `KnowledgeBaseConfig`). |
| **Chunking / search** | Token-overlap scoring over fixed character chunks (defaults: chunk **1500** chars, overlap **200**, up to **5** hits per `search_knowledge_base` call). Not vector / semantic embeddings. |
| **`maxIndexChars`** | Hard cap (characters) on the **combined** text indexed for the tool path **before** chunking (default **1_500_000**). Larger corpora are truncated in document order with a `[truncated…]` notice and console warnings. Set **`0`** to disable the cap. |
| **Size / count** | No hard cap on **prompt** path size beyond model context / latency; very large prompt paths can blow context or latency. |

**Failure modes users should understand:** wrong path or unreadable `file` → document **skipped** (warned in logs). Empty or whitespace-only text after trim → treated as empty. Hosts that load from object storage should **pre-decode** to UTF-8 text (as Bodhi’s Studio materializer does) and pass `source: 'text'`.

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
| **Tool retrieval (`mode: 'tool'`)** | Yes — chunked docs + in-process **`search_knowledge_base`** on the **main** agent. | **No** — subagents do not receive that tool; they only see the **prompt-routed** KB slice as static text. |
| **Per-agent isolation** | Each `MainAgent` can have its own `knowledgeBase` (e.g. after `transfer_to_agent`). | All background runs for the session share the **same** `getKnowledgeBaseContext` callback (from the session’s current processed KB state / active main resolution). |

**Practical guidance**

- Put reference material the **voice** agent must cite or search during the call on **`MainAgent.knowledgeBase`**.
- If a **subagent** must do heavy retrieval over a large corpus, either keep that corpus in **smaller prompt-friendly** excerpts in the main KB (so it appears in `knowledgeBaseContext`), or give the subagent its **own** tools / workers (e.g. HTTP worker, custom tool) that fetch data — do not assume the generic KB search tool exists inside `runSubagent`.

## Relation to memory

- **`MemoryStore`** — long-lived user facts; updated by distillation / tools. Not a document corpus.
- **`KnowledgeBaseConfig`** — session compile-time corpus for **instructions + optional search tool** on the main agent, plus the **prompt-only** excerpt for subagents as above.

## App layer (Bodhi server)

Hosted **Agent Studio** resolves Supabase-backed attachments **before** compile and passes **`source: 'text'`** into the framework. See **`app/docs/agent-studio-knowledge-base.md`** for upload paths, ingestion, lifecycle, naming, the **a/b/c support matrix** (framework vs service vs web UI), **infra checklist**, **integration steps**, and **service-layer TODOs**.

**Roadmap** (ingestion providers, noise, limits, subagent KB): `dev_docs/app/design-knowledge-base-roadmap.md`.

**Structured screening:** built-in profile `structured_screening` uses in-memory markdown (`source: 'text'`) from **`app/agents/builtin/structured-screening/defaults.ts`** or from a short-lived draft created by **`POST /api/structured-screening-draft`** (wired from `/structured-screening`). Local **`examples/interviewer/`** is a separate framework toy demo.

## Built-in profiles vs Studio-compiled agents

| Source | Where `KnowledgeBaseConfig` comes from | Typical `source` |
|--------|----------------------------------------|------------------|
| **Built-in catalog** (e.g. structured screening) | **`assembleBodhiProfile`** merges text KB for `structured_screening` — see **`app/agents/builtin/structured-screening/knowledge-base.ts`** (`buildStructuredScreeningKnowledgeBaseFromTexts`). |
| **User agents (`ua_*`)** | `AgentDefinitionV2.knowledgeBaseByAgentName` → **`materializeKnowledgeBaseByAgentName`** on the server | **`text`** only at framework boundary (Storage/inline resolved in `app/`). |

As a framework developer you interact with the **same** `processKnowledgeBase()` / `resolveAgentWithKnowledgeBase()` APIs once `MainAgent.knowledgeBase` is set; only the **producer** of that config differs.

## Integration quickstart (framework developers)

1. Build a **`KnowledgeBaseConfig`** with one or more **`KnowledgeBaseDocument`** entries (`source: 'text'` or **`file`**).
2. Attach **`knowledgeBase: config`** on your **`MainAgent`** before **`resolveAgentWithKnowledgeBase()`** (or equivalent compile step).
3. Optionally pass **`KnowledgeBaseProcessContext.readFileText`** into **`processKnowledgeBase()`** if `file` paths should resolve from non-disk stores.
4. Tune **`mode`**, **`autoPromptThreshold`**, **`chunkSize`**, **`maxResults`**, and **`maxIndexChars`** (tool-index size cap; default **1_500_000** characters, **`0`** disables) for latency vs recall.
5. Remember: **`search_knowledge_base`** exists **only on the main** live agent, not inside generic subagent runners — see **Main agent vs subagents** above.

## Open directions (framework-adjacent)

These are mostly **product / app** concerns but affect how you wire KB:

| Topic | Note |
|-------|------|
| **Subagent-owned KB** | No first-class **`SubagentConfig.knowledgeBase`** yet; subagents get **`knowledgeBaseContext`** (prompt slice only). Roadmap: `dev_docs/app/design-knowledge-base-roadmap.md` §5. |
| **Vector / SQL / web RAG** | Not built into KB — add normal **`ToolDefinition`s** or workers and keep KB for static reference text. |
| **Binary formats** | Framework does not parse PDF/DOCX; the **app** ingestion layer normalizes to text where configured (`app/agents/kb/*`). |
