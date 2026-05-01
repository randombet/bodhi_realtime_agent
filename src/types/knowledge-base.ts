// SPDX-License-Identifier: MIT

/**
 * Knowledge base types for grounding voice agents with domain-specific documents.
 *
 * Documents can be delivered to the LLM in two ways:
 * - **Prompt injection**: appended to system instructions (zero retrieval latency).
 * - **Tool retrieval**: chunked, indexed, and exposed via an auto-generated inline
 *   `search_knowledge_base` tool that the LLM calls on demand.
 *
 * The `auto` mode lets the framework decide based on total document size.
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
	 * Auto-generated inline tool for searching tool-mode documents.
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
