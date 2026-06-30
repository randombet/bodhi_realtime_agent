import { describe, expect, it } from 'vitest';
import type { AgentDefinitionV2 } from '../../app/agents/agent-definition.js';
import {
	collectSupabaseStorageRefsFromDefinition,
	diffSupabaseKbRefsToRemove,
} from '../../app/agents/kb/knowledge-base-storage-cleanup.js';

const baseDef = {
	schemaVersion: 2 as const,
	id: 'ua_0123456789abcdef',
	userId: 'u1',
	name: 'Test',
	mainAgents: [{ name: 'main', instructions: 'x', toolIds: ['get_current_time'] }],
	workers: {},
	createdAt: 1,
	updatedAt: 1,
};

function doc(
	overrides: Partial<{
		id: string;
		name: string;
		sourceKind: 'inline_text' | 'supabase_storage';
		bucket: string;
		objectPath: string;
		text: string;
	}>,
) {
	return {
		id: 'd1',
		name: 'Doc',
		sourceKind: 'supabase_storage' as const,
		bucket: 'b',
		objectPath: 'kb/u/a/f1',
		...overrides,
	};
}

describe('knowledge-base-storage-cleanup', () => {
	it('collects supabase_storage refs with default bucket fallback', () => {
		const def = {
			...baseDef,
			knowledgeBaseByAgentName: {
				main: {
					documents: [
						doc({ bucket: 'my', objectPath: 'o/a' }),
						{ id: '2', name: 'Doc', sourceKind: 'supabase_storage' as const, objectPath: 'o/b' },
					],
				},
			},
		} as AgentDefinitionV2;
		const refs = collectSupabaseStorageRefsFromDefinition(def, 'default-bucket');
		expect(refs).toEqual([
			{ bucket: 'my', objectPath: 'o/a' },
			{ bucket: 'default-bucket', objectPath: 'o/b' },
		]);
	});

	it('collects both raw objectPath and normalizedTextObjectPath', () => {
		const def = {
			...baseDef,
			knowledgeBaseByAgentName: {
				main: {
					documents: [
						{
							id: '1',
							name: 'Doc',
							sourceKind: 'supabase_storage' as const,
							bucket: 'b',
							objectPath: 'kb/u/a/raw.pdf',
							normalizedTextObjectPath: 'kb/u/a/raw.normalized.txt',
						},
					],
				},
			},
		} as AgentDefinitionV2;
		const refs = collectSupabaseStorageRefsFromDefinition(def, 'default-bucket');
		expect(refs).toEqual([
			{ bucket: 'b', objectPath: 'kb/u/a/raw.pdf' },
			{ bucket: 'b', objectPath: 'kb/u/a/raw.normalized.txt' },
		]);
	});

	it('diff returns refs removed from definition', () => {
		const before = {
			...baseDef,
			knowledgeBaseByAgentName: {
				main: { documents: [doc({ objectPath: 'keep' }), doc({ id: '2', objectPath: 'gone' })] },
			},
		} as AgentDefinitionV2;
		const after = {
			...baseDef,
			knowledgeBaseByAgentName: {
				main: { documents: [doc({ objectPath: 'keep' })] },
			},
		} as AgentDefinitionV2;
		const removed = diffSupabaseKbRefsToRemove(before, after, 'b');
		expect(removed).toEqual([{ bucket: 'b', objectPath: 'gone' }]);
	});
});
