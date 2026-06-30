/**
 * Knowledge base types for grounding voice agents with domain-specific documents.
 *
 * ## How this relates to other “layers” (mental model)
 *
 * - **Memory** (`MemoryStore`, distillation) — durable **facts** about the user/session,
 *   merged into a different pipeline. **Not** the same as KB; KB is **session-scoped
 *   reference text** you attach to a `MainAgent` at compile time.
 * - **KB → prompt path** — Some documents are turned into a **static string** appended
 *   to the main agent’s system instructions (`ProcessedKnowledgeBase.promptInjection`).
 *   No extra round trip; the model “sees” the text up front (subject to model context limits).
 * - **KB → “retrieval” path** — Other documents are **chunked** and kept in memory only.
 *   The framework synthesizes **one** inline tool named exactly **`search_knowledge_base`**.
 *   That tool is **not** web search, not Supabase, not embeddings: it runs a small **keyword /
 *   token-overlap scorer** over chunks (`src/knowledge/knowledge-base-processor.ts`). The
 *   live model may **call** that tool to pull chunk text into the conversation when needed.
 * - **Other tools** — Normal `ToolDefinition`s you register are unrelated unless you build
 *   custom retrieval yourself.
 *
 * ## Content and I/O
 *
 * KB documents are **plain UTF-8 text** after load (`source: 'text'`) or after reading a
 * `file` path (`readFileSync` or optional `KnowledgeBaseProcessContext.readFileText`).
 * There is **no** framework abstraction for editing KB at runtime; consumers mutate
 * `MainAgent.knowledgeBase` / stored definitions **outside** `processKnowledgeBase` and
 * re-resolve the agent when they want new content.
 *
 * ## `search_knowledge_base` (fixed name)
 *
 * When at least one document is routed to the tool path, `processKnowledgeBase` returns
 * `ProcessedKnowledgeBase.searchTool` with **`name: 'search_knowledge_base'`** (constant).
 * It is **strictly tied** to that in-memory chunk index for **this** KB config — not a
 * generic hook for arbitrary search backends.
 */

/**
 * How a document's content reaches the LLM.
 * - `prompt`: always injected into system instructions.
 * - `tool`:   only retrievable via the auto-generated search tool.
 * - `auto`:   framework decides — small total KB → prompt, large → tool.
 */
export type KnowledgeBaseDocumentMode = 'prompt' | 'tool' | 'auto';

/** Where the document content comes from. */
export type KnowledgeBaseDocumentSource = 'text' | 'file';

export interface KnowledgeBaseDocument {
	/** Where to load content from. */
	source: KnowledgeBaseDocumentSource;
	/**
	 * For `text`: the raw content string.
	 * For `file`: absolute or relative file path (resolved from `process.cwd()`).
	 */
	content: string;
	/** Human-readable label used in prompt headers and search results. */
	name: string;
	/**
	 * Delivery mode. Default: `'auto'`.
	 * @see KnowledgeBaseDocumentMode
	 */
	mode?: KnowledgeBaseDocumentMode;
}

export interface KnowledgeBaseConfig {
	documents: KnowledgeBaseDocument[];
	/**
	 * Character threshold for `auto` mode. If the sum of all `auto`-mode documents
	 * is below this limit, they are injected into the prompt. Otherwise they go
	 * through the search tool.
	 *
	 * Default: 50 000 (~12k tokens). Gemini supports up to ~4M chars; this default
	 * keeps the prompt concise for latency while covering most voice-agent KBs.
	 */
	autoPromptThreshold?: number;
	/**
	 * Override the description of the auto-generated `search_knowledge_base` tool.
	 * Only relevant when at least one document routes through the tool path.
	 */
	toolDescription?: string;
	/**
	 * Target chunk size in characters for tool-mode documents.
	 * Default: 1500 (~375 tokens). Smaller chunks improve search precision;
	 * larger chunks preserve more surrounding context.
	 */
	chunkSize?: number;
	/** Overlap between adjacent chunks in characters. Default: 200. */
	chunkOverlap?: number;
	/** Maximum number of chunks returned per search call. Default: 5. */
	maxResults?: number;
	/**
	 * Hard cap (characters) on the total text routed to the in-memory tool index.
	 *
	 * When the combined size of all tool-routed documents exceeds this value, the
	 * processor truncates additional documents (in declared order) and emits a
	 * `[truncated]` notice. Use this to prevent a single noisy upload from
	 * blowing out memory/latency. Default: 1_500_000 (~1.5 MB / ~375k tokens).
	 *
	 * Setting `0` disables the cap entirely.
	 */
	maxIndexChars?: number;
}

/** A chunk of text from a knowledge base document, ready for search. */
export interface KnowledgeBaseChunk {
	/** Display name of the source document. */
	documentName: string;
	/** Zero-based chunk index within this document. */
	chunkIndex: number;
	/** The chunk text. */
	text: string;
}

/**
 * Result of processing a KnowledgeBaseConfig: prompt text to inject and
 * an optional search tool for the tool-routed documents.
 */
export interface ProcessedKnowledgeBase {
	/** Text to append to the agent's system instructions (prompt-mode docs). */
	promptInjection: string;
	/**
	 * Auto-generated **inline** tool (`execution: 'inline'`) with fixed name
	 * **`search_knowledge_base`**, only present when at least one document uses the
	 * tool-routed path. Invokes the framework’s in-process chunk index (not vector DB).
	 * Undefined when all documents are prompt-injected.
	 */
	searchTool?: import('./tool.js').ToolDefinition;
}

/**
 * Optional hooks for loading `file`-source KB documents without tying the framework
 * to a specific filesystem layout or storage backend.
 *
 * When `readFileText` is omitted, the processor reads UTF-8 via synchronous `readFileSync`
 * (absolute paths or paths resolved from `process.cwd()`).
 */
export interface KnowledgeBaseProcessContext {
	/**
	 * Return UTF-8 text for a resolved absolute file path, or `null` to skip the document.
	 */
	readFileText?: (absolutePath: string) => string | null;
}
