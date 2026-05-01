// SPDX-License-Identifier: MIT

/**
 * Processes a KnowledgeBaseConfig into prompt text + an optional search tool.
 *
 * Flow:
 * 1. Load all documents (text inline, file from disk).
 * 2. Partition into prompt-injected vs tool-retrievable based on mode + size.
 * 3. Build prompt block from prompt docs.
 * 4. Chunk tool docs, build in-memory index, generate an inline search tool.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
	KnowledgeBaseChunk,
	KnowledgeBaseConfig,
	KnowledgeBaseDocument,
	KnowledgeBaseProcessContext,
	ProcessedKnowledgeBase,
} from '../types/knowledge-base.js';
import type { ToolDefinition } from '../types/tool.js';

const DEFAULT_AUTO_PROMPT_THRESHOLD = 50_000;
const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_MAX_RESULTS = 5;

// ─── Document loading ───────────────────────────────────────────────

interface LoadedDocument {
	name: string;
	text: string;
	mode: 'prompt' | 'tool' | 'auto';
}

function loadDocument(
	doc: KnowledgeBaseDocument,
	context?: KnowledgeBaseProcessContext,
): LoadedDocument | null {
	let text: string;

	switch (doc.source) {
		case 'text':
			text = doc.content;
			break;
		case 'file': {
			const resolved = path.isAbsolute(doc.content)
				? doc.content
				: path.resolve(process.cwd(), doc.content);
			if (context?.readFileText) {
				const t = context.readFileText(resolved);
				if (t === null || t === undefined) {
					console.warn(
						`[KnowledgeBase] readFileText returned empty for "${resolved}" (${doc.name}) — skipping.`,
					);
					return null;
				}
				text = t;
			} else {
				try {
					text = readFileSync(resolved, 'utf8');
				} catch {
					console.warn(
						`[KnowledgeBase] Could not read file "${resolved}" for document "${doc.name}" — skipping.`,
					);
					return null;
				}
			}
			break;
		}
		default:
			throw new Error(
				`Unsupported knowledge base document source: ${(doc as { source: string }).source}`,
			);
	}

	return { name: doc.name, text: text.trim(), mode: doc.mode ?? 'auto' };
}

// ─── Chunking ───────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks, preferring paragraph/sentence boundaries.
 */
export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
	if (text.length <= chunkSize) return [text];

	const safeOverlap = Math.min(overlap, Math.floor(chunkSize * 0.4));
	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		let end = Math.min(start + chunkSize, text.length);

		if (end < text.length) {
			const slice = text.slice(start, end);
			const lastParagraph = slice.lastIndexOf('\n\n');
			const lastNewline = slice.lastIndexOf('\n');
			const lastSentence = slice.lastIndexOf('. ');

			if (lastParagraph > chunkSize * 0.5) {
				end = start + lastParagraph + 2;
			} else if (lastNewline > chunkSize * 0.5) {
				end = start + lastNewline + 1;
			} else if (lastSentence > chunkSize * 0.5) {
				end = start + lastSentence + 2;
			}
		}

		chunks.push(text.slice(start, end).trim());

		const nextStart = Math.max(start + 1, end - safeOverlap);
		if (nextStart >= text.length) break;
		start = nextStart;
	}

	return chunks.filter((c) => c.length > 0);
}

// ─── Text search (BM25-lite: TF + IDF weighting) ───────────────────

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length > 1);
}

interface SearchIndex {
	chunks: KnowledgeBaseChunk[];
	chunkTokens: string[][];
	idf: Map<string, number>;
}

function buildSearchIndex(chunks: KnowledgeBaseChunk[]): SearchIndex {
	const chunkTokens = chunks.map((c) => tokenize(c.text));
	const N = chunks.length;

	const df = new Map<string, number>();
	for (const tokens of chunkTokens) {
		const unique = new Set(tokens);
		for (const t of unique) {
			df.set(t, (df.get(t) ?? 0) + 1);
		}
	}

	const idf = new Map<string, number>();
	for (const [term, freq] of df) {
		idf.set(term, Math.log((N + 1) / (freq + 1)) + 1);
	}

	return { chunks, chunkTokens, idf };
}

function searchIndex(
	index: SearchIndex,
	query: string,
	maxResults: number,
): Array<{ chunk: KnowledgeBaseChunk; score: number }> {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];

	const scores: Array<{ chunk: KnowledgeBaseChunk; score: number }> = [];

	for (let i = 0; i < index.chunks.length; i++) {
		const docTokens = index.chunkTokens[i];
		const docLen = docTokens.length;
		if (docLen === 0) continue;

		const tf = new Map<string, number>();
		for (const t of docTokens) {
			tf.set(t, (tf.get(t) ?? 0) + 1);
		}

		let score = 0;
		for (const qt of queryTokens) {
			const termFreq = tf.get(qt) ?? 0;
			if (termFreq === 0) continue;
			const termIdf = index.idf.get(qt) ?? 1;
			score += (termFreq / docLen) * termIdf;
		}

		if (score > 0) {
			scores.push({ chunk: index.chunks[i], score });
		}
	}

	scores.sort((a, b) => b.score - a.score);
	return scores.slice(0, maxResults);
}

// ─── Prompt block builder ───────────────────────────────────────────

function buildPromptBlock(docs: LoadedDocument[]): string {
	if (docs.length === 0) return '';

	const parts = [
		'\n\n## Knowledge Base',
		'The following documents are provided as authoritative context. Reference them when relevant.',
	];

	for (const doc of docs) {
		parts.push(`### ${doc.name}\n${doc.text}`);
	}

	return parts.join('\n\n');
}

// ─── Search tool builder ────────────────────────────────────────────

function buildSearchTool(
	chunks: KnowledgeBaseChunk[],
	config: KnowledgeBaseConfig,
): ToolDefinition {
	const index = buildSearchIndex(chunks);
	const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;

	const docNames = [...new Set(chunks.map((c) => c.documentName))];
	const defaultDescription = `Search the knowledge base for relevant information. Available documents: ${docNames.join(', ')}. Call this when you need specific details from these documents to answer accurately.`;

	return {
		name: 'search_knowledge_base',
		description: config.toolDescription ?? defaultDescription,
		parameters: z.object({
			query: z
				.string()
				.min(2)
				.max(500)
				.describe('Natural language search query describing the information you need'),
		}),
		execution: 'inline',
		execute: async (args) => {
			const { query } = args as { query: string };
			const results = searchIndex(index, query, maxResults);

			if (results.length === 0) {
				return {
					status: 'no_results',
					message: 'No matching content found. Try rephrasing or broadening the query.',
				};
			}

			return {
				status: 'ok',
				results: results.map((r) => ({
					document: r.chunk.documentName,
					chunkIndex: r.chunk.chunkIndex,
					text: r.chunk.text,
					relevance: Math.round(r.score * 1000) / 1000,
				})),
			};
		},
	};
}

// ─── Main entry point ───────────────────────────────────────────────

/**
 * Process a KnowledgeBaseConfig into prompt injection text and an optional search tool.
 *
 * The processor:
 * 1. Loads all documents.
 * 2. Applies the auto-mode threshold to decide prompt vs tool routing.
 * 3. Builds prompt text for prompt-routed docs.
 * 4. Chunks and indexes tool-routed docs, generating an inline search tool.
 */
export function processKnowledgeBase(
	config: KnowledgeBaseConfig,
	context?: KnowledgeBaseProcessContext,
): ProcessedKnowledgeBase {
	if (!config.documents?.length) {
		return { promptInjection: '' };
	}

	const loaded = config.documents
		.map((d) => loadDocument(d, context))
		.filter((d): d is LoadedDocument => d !== null);
	const threshold = config.autoPromptThreshold ?? DEFAULT_AUTO_PROMPT_THRESHOLD;

	const promptDocs: LoadedDocument[] = [];
	const toolDocs: LoadedDocument[] = [];
	const autoDocs: LoadedDocument[] = [];

	for (const doc of loaded) {
		if (doc.mode === 'prompt') promptDocs.push(doc);
		else if (doc.mode === 'tool') toolDocs.push(doc);
		else autoDocs.push(doc);
	}

	const autoTotalSize = autoDocs.reduce((sum, d) => sum + d.text.length, 0);
	const promptTotalSize = promptDocs.reduce((sum, d) => sum + d.text.length, 0);

	if (autoTotalSize + promptTotalSize <= threshold) {
		promptDocs.push(...autoDocs);
	} else {
		toolDocs.push(...autoDocs);
	}

	const promptInjection = buildPromptBlock(promptDocs);

	if (toolDocs.length === 0) {
		return { promptInjection };
	}

	const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
	const overlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;

	const allChunks: KnowledgeBaseChunk[] = [];
	for (const doc of toolDocs) {
		const textChunks = chunkText(doc.text, chunkSize, overlap);
		for (let i = 0; i < textChunks.length; i++) {
			allChunks.push({
				documentName: doc.name,
				chunkIndex: i,
				text: textChunks[i],
			});
		}
	}

	return {
		promptInjection,
		searchTool: buildSearchTool(allChunks, config),
	};
}
