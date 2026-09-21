import { describe, expect, it, vi } from 'vitest';
import type { AgentDefinitionV2 } from '../../app/agents/agent-definition.js';
import { materializeKnowledgeBaseByAgentName } from '../../app/agents/kb/materialize-knowledge-base-attachments.js';

describe('materializeKnowledgeBaseByAgentName', () => {
	it('maps inline_text to framework text documents', async () => {
		const def = {
			mainAgents: [],
			workers: {},
			knowledgeBaseByAgentName: {
				main: {
					documents: [
						{
							id: '1',
							name: 'Note',
							sourceKind: 'inline_text',
							text: '  hello world  ',
							mode: 'prompt',
						},
					],
				},
			},
		} as unknown as AgentDefinitionV2;
		const out = await materializeKnowledgeBaseByAgentName(def, null, 'bodhi-knowledge-base');
		expect(out?.main?.documents).toHaveLength(1);
		expect(out?.main?.documents?.[0]).toMatchObject({
			source: 'text',
			content: 'hello world',
			name: 'Note',
			mode: 'prompt',
		});
	});

	it('downloads supabase_storage as utf-8 text when client is provided', async () => {
		const blob = new Blob(['downloaded body'], { type: 'text/plain' });
		const download = vi.fn(async () => ({
			data: blob,
			error: null,
		}));
		const from = vi.fn(() => ({
			download,
		}));
		const supabase = { storage: { from } } as never;

		const def = {
			mainAgents: [],
			workers: {},
			knowledgeBaseByAgentName: {
				main: {
					documents: [
						{
							id: 'a',
							name: 'Remote',
							sourceKind: 'supabase_storage',
							bucket: 'my-bucket',
							objectPath: 'kb/u/a/doc.txt',
							mode: 'auto',
						},
					],
				},
			},
		} as unknown as AgentDefinitionV2;

		const out = await materializeKnowledgeBaseByAgentName(def, supabase, 'default-bucket');
		expect(from).toHaveBeenCalledWith('my-bucket');
		expect(download).toHaveBeenCalledWith('kb/u/a/doc.txt');
		expect(out?.main?.documents?.[0]).toMatchObject({
			source: 'text',
			content: 'downloaded body',
			name: 'Remote',
		});
	});

	it('prefers normalizedTextObjectPath over the raw uploaded object', async () => {
		const blob = new Blob(['parsed markdown body'], { type: 'text/plain' });
		const download = vi.fn(async () => ({ data: blob, error: null }));
		const from = vi.fn(() => ({ download }));
		const supabase = { storage: { from } } as never;

		const def = {
			mainAgents: [],
			workers: {},
			knowledgeBaseByAgentName: {
				main: {
					documents: [
						{
							id: 'a',
							name: 'PDF',
							sourceKind: 'supabase_storage',
							bucket: 'my-bucket',
							objectPath: 'kb/u/a/doc.pdf',
							normalizedTextObjectPath: 'kb/u/a/doc.normalized.txt',
							ingestionStatus: 'ready',
							mode: 'auto',
						},
					],
				},
			},
		} as unknown as AgentDefinitionV2;

		const out = await materializeKnowledgeBaseByAgentName(def, supabase, 'default-bucket');
		expect(download).toHaveBeenCalledWith('kb/u/a/doc.normalized.txt');
		expect(out?.main?.documents?.[0]?.content).toBe('parsed markdown body');
	});

	it('skips documents whose ingestion has not completed', async () => {
		const download = vi.fn();
		const from = vi.fn(() => ({ download }));
		const supabase = { storage: { from } } as never;

		const def = {
			mainAgents: [],
			workers: {},
			knowledgeBaseByAgentName: {
				main: {
					documents: [
						{
							id: 'a',
							name: 'Pending',
							sourceKind: 'supabase_storage',
							bucket: 'my-bucket',
							objectPath: 'kb/u/a/doc.pdf',
							ingestionStatus: 'failed',
							errorMessage: 'no parser',
							mode: 'auto',
						},
					],
				},
			},
		} as unknown as AgentDefinitionV2;

		const out = await materializeKnowledgeBaseByAgentName(def, supabase, 'default-bucket');
		expect(out).toBeUndefined();
		expect(download).not.toHaveBeenCalled();
	});

	it('returns undefined when no documents materialize', async () => {
		const def = {
			mainAgents: [],
			workers: {},
			knowledgeBaseByAgentName: {
				main: {
					documents: [
						{
							id: 'x',
							name: 'Empty inline',
							sourceKind: 'inline_text',
							text: '   ',
							mode: 'auto',
						},
					],
				},
			},
		} as unknown as AgentDefinitionV2;
		const out = await materializeKnowledgeBaseByAgentName(def, null, 'bodhi-knowledge-base');
		expect(out).toBeUndefined();
	});
});
