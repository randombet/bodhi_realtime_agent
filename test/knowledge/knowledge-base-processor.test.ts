// SPDX-License-Identifier: MIT

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chunkText, processKnowledgeBase } from '../../src/knowledge/knowledge-base-processor.js';
import type { KnowledgeBaseConfig } from '../../src/types/knowledge-base.js';

describe('chunkText', () => {
	it('returns single chunk when text fits within chunkSize', () => {
		const result = chunkText('Hello world', 100, 20);
		expect(result).toEqual(['Hello world']);
	});

	it('splits text into overlapping chunks', () => {
		const text = `${'A'.repeat(50)}\n\n${'B'.repeat(50)}\n\n${'C'.repeat(50)}`;
		const chunks = chunkText(text, 60, 10);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeGreaterThan(0);
		}
	});

	it('prefers splitting at paragraph boundaries', () => {
		const text =
			'First paragraph about topic A.\n\nSecond paragraph about topic B.\n\nThird paragraph about topic C.';
		const chunks = chunkText(text, 60, 10);
		expect(chunks[0]).toBe('First paragraph about topic A.');
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('handles empty text', () => {
		const result = chunkText('', 100, 20);
		expect(result).toEqual(['']);
	});
});

describe('processKnowledgeBase', () => {
	it('returns empty prompt for empty documents', () => {
		const result = processKnowledgeBase({ documents: [] });
		expect(result.promptInjection).toBe('');
		expect(result.searchTool).toBeUndefined();
	});

	it('injects small text documents into prompt (auto mode, under threshold)', () => {
		const config: KnowledgeBaseConfig = {
			documents: [
				{ source: 'text', content: 'Company info here.', name: 'Company', mode: 'auto' },
				{ source: 'text', content: 'Job description here.', name: 'Job Description', mode: 'auto' },
			],
			autoPromptThreshold: 50_000,
		};
		const result = processKnowledgeBase(config);
		expect(result.promptInjection).toContain('Company info here.');
		expect(result.promptInjection).toContain('Job description here.');
		expect(result.promptInjection).toContain('## Knowledge Base');
		expect(result.searchTool).toBeUndefined();
	});

	it('routes auto docs to tool when over threshold', () => {
		const longText = 'X'.repeat(100);
		const config: KnowledgeBaseConfig = {
			documents: [{ source: 'text', content: longText, name: 'Big Doc', mode: 'auto' }],
			autoPromptThreshold: 50,
		};
		const result = processKnowledgeBase(config);
		expect(result.promptInjection).toBe('');
		expect(result.searchTool).toBeDefined();
		expect(result.searchTool?.name).toBe('search_knowledge_base');
		expect(result.searchTool?.execution).toBe('inline');
	});

	it('respects explicit prompt mode regardless of threshold', () => {
		const longText = 'Y'.repeat(200);
		const config: KnowledgeBaseConfig = {
			documents: [{ source: 'text', content: longText, name: 'Forced Prompt', mode: 'prompt' }],
			autoPromptThreshold: 50,
		};
		const result = processKnowledgeBase(config);
		expect(result.promptInjection).toContain(longText);
		expect(result.searchTool).toBeUndefined();
	});

	it('respects explicit tool mode regardless of size', () => {
		const config: KnowledgeBaseConfig = {
			documents: [{ source: 'text', content: 'Tiny doc.', name: 'Forced Tool', mode: 'tool' }],
			autoPromptThreshold: 50_000,
		};
		const result = processKnowledgeBase(config);
		expect(result.promptInjection).toBe('');
		expect(result.searchTool).toBeDefined();
	});

	it('search tool returns relevant results', async () => {
		const config: KnowledgeBaseConfig = {
			documents: [
				{
					source: 'text',
					content: 'The company was founded in 2020 and specializes in healthcare technology.',
					name: 'Company',
					mode: 'tool',
				},
				{
					source: 'text',
					content: 'The candidate has 5 years of experience in React and TypeScript development.',
					name: 'Resume',
					mode: 'tool',
				},
			],
		};

		const result = processKnowledgeBase(config);
		expect(result.searchTool).toBeDefined();

		const searchResult = await result.searchTool?.execute(
			{ query: 'healthcare technology company founded' },
			{
				toolCallId: 'test',
				agentName: 'main',
				sessionId: 'test',
				abortSignal: new AbortController().signal,
			},
		);

		const parsed = searchResult as {
			status: string;
			results?: Array<{ document: string; text: string }>;
		};
		expect(parsed.status).toBe('ok');
		expect(parsed.results).toBeDefined();
		expect(parsed.results?.length).toBeGreaterThan(0);
		expect(parsed.results?.[0].document).toBe('Company');
	});

	it('search tool returns no_results for irrelevant queries', async () => {
		const config: KnowledgeBaseConfig = {
			documents: [
				{
					source: 'text',
					content: 'This document is about marine biology and coral reef preservation.',
					name: 'Biology',
					mode: 'tool',
				},
			],
		};

		const result = processKnowledgeBase(config);
		const searchResult = await result.searchTool?.execute(
			{ query: 'quantum computing algorithms' },
			{
				toolCallId: 'test',
				agentName: 'main',
				sessionId: 'test',
				abortSignal: new AbortController().signal,
			},
		);

		const parsed = searchResult as { status: string };
		expect(parsed.status).toBe('no_results');
	});

	it('mixes prompt and tool mode documents correctly', () => {
		const config: KnowledgeBaseConfig = {
			documents: [
				{
					source: 'text',
					content: 'Always visible company info.',
					name: 'Company',
					mode: 'prompt',
				},
				{
					source: 'text',
					content: 'Large handbook content '.repeat(100),
					name: 'Handbook',
					mode: 'tool',
				},
			],
		};

		const result = processKnowledgeBase(config);
		expect(result.promptInjection).toContain('Always visible company info.');
		expect(result.promptInjection).not.toContain('Large handbook content');
		expect(result.searchTool).toBeDefined();
	});

	it('loads documents from files', () => {
		const fixtureDir = path.resolve(process.cwd(), 'fixtures', 'recruiting-screening');
		const config: KnowledgeBaseConfig = {
			documents: [
				{
					source: 'file',
					content: path.join(fixtureDir, 'company.md'),
					name: 'Company',
					mode: 'prompt',
				},
			],
		};

		const result = processKnowledgeBase(config);
		expect(result.promptInjection).toContain('Company');
		expect(result.promptInjection.length).toBeGreaterThan(50);
	});

	it('uses readFileText from context when provided for file sources', () => {
		const config: KnowledgeBaseConfig = {
			documents: [
				{
					source: 'file',
					content: '/virtual/kb.md',
					name: 'Virtual',
					mode: 'prompt',
				},
			],
		};

		const result = processKnowledgeBase(config, {
			readFileText: (p) => (p === '/virtual/kb.md' ? 'Injected from resolver.' : null),
		});
		expect(result.promptInjection).toContain('Injected from resolver.');
	});

	it('skips missing files gracefully', () => {
		const config: KnowledgeBaseConfig = {
			documents: [
				{ source: 'file', content: '/nonexistent/path.txt', name: 'Missing', mode: 'prompt' },
				{ source: 'text', content: 'Fallback content.', name: 'Available', mode: 'prompt' },
			],
		};

		const result = processKnowledgeBase(config);
		expect(result.promptInjection).toContain('Fallback content.');
		expect(result.promptInjection).not.toContain('Missing');
	});

	it('respects custom tool description', () => {
		const config: KnowledgeBaseConfig = {
			documents: [{ source: 'text', content: 'Some content.', name: 'Doc', mode: 'tool' }],
			toolDescription: 'Custom search description for recruiting docs.',
		};

		const result = processKnowledgeBase(config);
		expect(result.searchTool?.description).toBe('Custom search description for recruiting docs.');
	});

	it('truncates tool-mode corpus when maxIndexChars is exceeded', async () => {
		const filler = 'word '.repeat(2000);
		const config: KnowledgeBaseConfig = {
			documents: [
				{
					source: 'text',
					content: `gadget reference ${filler}`,
					name: 'Huge',
					mode: 'tool',
				},
			],
			maxIndexChars: 500,
			chunkSize: 10_000,
			chunkOverlap: 0,
			maxResults: 10,
		};
		const result = processKnowledgeBase(config);
		const searchTool = result.searchTool;
		expect(searchTool).toBeDefined();
		if (!searchTool) return;
		const searchResult = await searchTool.execute(
			{ query: 'gadget reference' },
			{
				toolCallId: 't',
				agentName: 'main',
				sessionId: 's',
				abortSignal: new AbortController().signal,
			},
		);
		const parsed = searchResult as { status?: string; results?: Array<{ text: string }> };
		expect(parsed.status).toBe('ok');
		const totalChars = (parsed.results ?? []).reduce((n, r) => n + r.text.length, 0);
		expect(totalChars).toBeLessThanOrEqual(500);
	});

	it('respects maxResults configuration', async () => {
		const docs = Array.from({ length: 20 }, (_, i) => ({
			source: 'text' as const,
			content: `Document ${i} contains information about topic ${i} and related details.`,
			name: `Doc ${i}`,
			mode: 'tool' as const,
		}));

		const config: KnowledgeBaseConfig = {
			documents: docs,
			maxResults: 3,
		};

		const result = processKnowledgeBase(config);
		const searchResult = await result.searchTool?.execute(
			{ query: 'information about topic details' },
			{
				toolCallId: 'test',
				agentName: 'main',
				sessionId: 'test',
				abortSignal: new AbortController().signal,
			},
		);

		const parsed = searchResult as { results?: unknown[] };
		expect(parsed.results?.length).toBeLessThanOrEqual(3);
	});
});
