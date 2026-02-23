// SPDX-License-Identifier: MIT

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonMemoryStore } from '../../src/memory/json-memory-store.js';
import type { MemoryFact } from '../../src/types/memory.js';

describe('JsonMemoryStore', () => {
	let tmpDir: string;
	let store: JsonMemoryStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'memory-test-'));
		store = new JsonMemoryStore(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('returns empty array for non-existent user', async () => {
		const facts = await store.getAll('unknown-user');
		expect(facts).toEqual([]);
	});

	it('addFacts creates file and stores facts', async () => {
		const facts: MemoryFact[] = [
			{ content: 'Prefers dark mode', category: 'preference', timestamp: 1000 },
			{ content: 'Works at Acme Corp', category: 'entity', timestamp: 1001 },
		];

		await store.addFacts('user1', facts);

		const retrieved = await store.getAll('user1');
		expect(retrieved).toHaveLength(2);
		expect(retrieved[0].content).toBe('Prefers dark mode');
		expect(retrieved[0].category).toBe('preference');
		expect(retrieved[1].content).toBe('Works at Acme Corp');
		expect(retrieved[1].category).toBe('entity');
	});

	it('addFacts appends to existing facts', async () => {
		await store.addFacts('user1', [
			{ content: 'Likes TypeScript', category: 'preference', timestamp: 1000 },
		]);
		await store.addFacts('user1', [
			{ content: 'Prefers dark mode', category: 'preference', timestamp: 2000 },
		]);

		const facts = await store.getAll('user1');
		expect(facts).toHaveLength(2);
		expect(facts[0].content).toBe('Likes TypeScript');
		expect(facts[1].content).toBe('Prefers dark mode');
	});

	it('addFacts with empty array is a no-op', async () => {
		await store.addFacts('user1', []);
		const facts = await store.getAll('user1');
		expect(facts).toEqual([]);
	});

	it('addFacts handles multiple categories', async () => {
		const facts: MemoryFact[] = [
			{ content: 'Prefers dark mode', category: 'preference', timestamp: 1000 },
			{ content: 'Uses Node 22', category: 'requirement', timestamp: 1001 },
			{ content: 'Chose pnpm', category: 'decision', timestamp: 1002 },
			{ content: 'John is the PM', category: 'entity', timestamp: 1003 },
		];

		await store.addFacts('user1', facts);

		const retrieved = await store.getAll('user1');
		expect(retrieved).toHaveLength(4);
		expect(retrieved[0].content).toBe('Prefers dark mode');
		expect(retrieved[1].content).toBe('Uses Node 22');
		expect(retrieved[2].content).toBe('Chose pnpm');
		expect(retrieved[3].content).toBe('John is the PM');
	});

	it('replaceAll atomically overwrites all facts', async () => {
		await store.addFacts('user1', [
			{ content: 'Old fact 1', category: 'preference', timestamp: 1000 },
			{ content: 'Old fact 2', category: 'entity', timestamp: 1001 },
		]);

		await store.replaceAll('user1', [
			{ content: 'New consolidated fact', category: 'preference', timestamp: 3000 },
		]);

		const facts = await store.getAll('user1');
		expect(facts).toHaveLength(1);
		expect(facts[0].content).toBe('New consolidated fact');
	});

	it('replaceAll preserves directives', async () => {
		await store.setDirectives('user1', { pacing: 'slow' });
		await store.addFacts('user1', [
			{ content: 'Old fact', category: 'preference', timestamp: 1000 },
		]);

		await store.replaceAll('user1', [
			{ content: 'New fact', category: 'preference', timestamp: 2000 },
		]);

		const directives = await store.getDirectives('user1');
		expect(directives).toEqual({ pacing: 'slow' });
	});

	it('replaceAll creates file if missing', async () => {
		await store.replaceAll('user1', [
			{ content: 'Brand new', category: 'decision', timestamp: 1000 },
		]);

		const facts = await store.getAll('user1');
		expect(facts).toHaveLength(1);
		expect(facts[0].content).toBe('Brand new');
		expect(facts[0].category).toBe('decision');
	});

	it('isolates users from each other', async () => {
		await store.addFacts('user1', [
			{ content: 'User 1 fact', category: 'preference', timestamp: 1000 },
		]);
		await store.addFacts('user2', [
			{ content: 'User 2 fact', category: 'entity', timestamp: 1001 },
		]);

		const facts1 = await store.getAll('user1');
		const facts2 = await store.getAll('user2');

		expect(facts1).toHaveLength(1);
		expect(facts1[0].content).toBe('User 1 fact');
		expect(facts2).toHaveLength(1);
		expect(facts2[0].content).toBe('User 2 fact');
	});

	describe('directives', () => {
		it('returns empty object for non-existent user', async () => {
			const directives = await store.getDirectives('unknown-user');
			expect(directives).toEqual({});
		});

		it('persists and retrieves directives', async () => {
			await store.setDirectives('user1', { pacing: 'slow', verbosity: 'concise' });

			const directives = await store.getDirectives('user1');
			expect(directives).toEqual({ pacing: 'slow', verbosity: 'concise' });
		});

		it('overwrites existing directives', async () => {
			await store.setDirectives('user1', { pacing: 'slow' });
			await store.setDirectives('user1', { pacing: 'fast' });

			const directives = await store.getDirectives('user1');
			expect(directives).toEqual({ pacing: 'fast' });
		});

		it('preserves facts when setting directives', async () => {
			await store.addFacts('user1', [
				{ content: 'Some fact', category: 'preference', timestamp: 1000 },
			]);
			await store.setDirectives('user1', { pacing: 'slow' });

			const facts = await store.getAll('user1');
			expect(facts).toHaveLength(1);
			expect(facts[0].content).toBe('Some fact');
		});

		it('preserves directives when adding facts', async () => {
			await store.setDirectives('user1', { pacing: 'slow' });
			await store.addFacts('user1', [{ content: 'New fact', category: 'entity', timestamp: 1000 }]);

			const directives = await store.getDirectives('user1');
			expect(directives).toEqual({ pacing: 'slow' });
		});
	});
});
