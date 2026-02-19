// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationContext } from '../../src/core/conversation-context.js';
import { HooksManager } from '../../src/core/hooks.js';
import { MemoryDistiller } from '../../src/memory/memory-distiller.js';
import type { MemoryFact, MemoryStore } from '../../src/types/memory.js';

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({
		text: JSON.stringify({
			facts: [
				{ content: 'Prefers dark mode', category: 'preference' },
				{ content: 'Works at Acme Corp', category: 'entity' },
			],
		}),
	})),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createMockStore(): MemoryStore & {
	addFacts: ReturnType<typeof vi.fn>;
	getAll: ReturnType<typeof vi.fn>;
	replaceAll: ReturnType<typeof vi.fn>;
} {
	return {
		addFacts: vi.fn(async () => {}),
		getAll: vi.fn(async () => []),
		replaceAll: vi.fn(async () => {}),
	};
}

describe('MemoryDistiller', () => {
	let convCtx: ConversationContext;
	let store: ReturnType<typeof createMockStore>;
	let hooks: HooksManager;
	let distiller: MemoryDistiller;

	beforeEach(() => {
		vi.clearAllMocks();
		convCtx = new ConversationContext();
		store = createMockStore();
		hooks = new HooksManager();
		distiller = new MemoryDistiller(convCtx, store, hooks, mockModel, {
			userId: 'user1',
			sessionId: 'sess1',
			turnFrequency: 5,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not trigger extraction before reaching turn frequency', () => {
		convCtx.addUserMessage('hello');

		// 4 turns — should not trigger
		for (let i = 0; i < 4; i++) {
			distiller.onTurnEnd();
		}

		expect(store.addFacts).not.toHaveBeenCalled();
	});

	it('triggers extraction at the Nth turn', async () => {
		convCtx.addUserMessage('I prefer dark mode');
		convCtx.addAssistantMessage('Got it!');

		for (let i = 0; i < 5; i++) {
			distiller.onTurnEnd();
		}

		// Allow async extraction to complete
		await new Promise((r) => setTimeout(r, 50));

		expect(store.addFacts).toHaveBeenCalledOnce();
		expect(store.addFacts).toHaveBeenCalledWith(
			'user1',
			expect.arrayContaining([
				expect.objectContaining({ content: 'Prefers dark mode', category: 'preference' }),
			]),
		);
	});

	it('checkpoint triggers extraction immediately', async () => {
		convCtx.addUserMessage('I work at Acme');

		distiller.onCheckpoint();

		await new Promise((r) => setTimeout(r, 50));

		expect(store.addFacts).toHaveBeenCalledOnce();
	});

	it('coalesces: second trigger skipped while first runs', async () => {
		convCtx.addUserMessage('Some message');

		// Fire two checkpoints back-to-back
		distiller.onCheckpoint();
		distiller.onCheckpoint();

		await new Promise((r) => setTimeout(r, 50));

		// Only one extraction should run
		expect(store.addFacts).toHaveBeenCalledTimes(1);
	});

	it('forceExtract runs extraction and awaits completion', async () => {
		convCtx.addUserMessage('I like TypeScript');

		await distiller.forceExtract();

		expect(store.addFacts).toHaveBeenCalledOnce();
	});

	it('skips extraction when no items since checkpoint', async () => {
		// No messages added
		await distiller.forceExtract();

		expect(store.addFacts).not.toHaveBeenCalled();
	});

	it('marks checkpoint after successful extraction', async () => {
		convCtx.addUserMessage('First message');
		await distiller.forceExtract();

		// Items since checkpoint should be empty now
		expect(convCtx.getItemsSinceCheckpoint()).toHaveLength(0);
	});

	it('fires onMemoryExtraction hook', async () => {
		const onMemoryExtraction = vi.fn();
		hooks.register({ onMemoryExtraction });

		convCtx.addUserMessage('Some data');
		await distiller.forceExtract();

		expect(onMemoryExtraction).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user1',
				factsExtracted: 2,
			}),
		);
	});

	it('passes existing memory to extraction prompt', async () => {
		store.getAll.mockResolvedValueOnce([
			{ content: 'Existing fact', category: 'preference', timestamp: 1000 },
		]);

		convCtx.addUserMessage('New info');
		await distiller.forceExtract();

		const { generateText } = await import('ai');
		const call = (generateText as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.prompt).toContain('Existing fact');
	});

	it('consolidate reads all facts and replaces them', async () => {
		store.getAll.mockResolvedValueOnce([
			{ content: 'Fact A', category: 'preference', timestamp: 1000 },
			{ content: 'Fact B', category: 'entity', timestamp: 1001 },
		]);

		await distiller.consolidate();

		expect(store.replaceAll).toHaveBeenCalledOnce();
		expect(store.replaceAll).toHaveBeenCalledWith(
			'user1',
			expect.arrayContaining([expect.objectContaining({ content: 'Prefers dark mode' })]),
		);
	});

	it('consolidate is a no-op when no facts exist', async () => {
		store.getAll.mockResolvedValueOnce([]);

		await distiller.consolidate();

		expect(store.replaceAll).not.toHaveBeenCalled();
	});

	it('handles malformed LLM response gracefully', async () => {
		const { generateText } = await import('ai');
		(generateText as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			text: 'not valid json at all',
		});

		convCtx.addUserMessage('Some data');
		await distiller.forceExtract();

		// Should not throw, just skip
		expect(store.addFacts).not.toHaveBeenCalled();
	});

	it('reports errors via hooks.onError', async () => {
		const onError = vi.fn();
		hooks.register({ onError });

		store.getAll.mockRejectedValueOnce(new Error('store failure'));

		convCtx.addUserMessage('Some data');

		// Use onCheckpoint (fire-and-forget) to trigger error path
		distiller.onCheckpoint();
		await new Promise((r) => setTimeout(r, 50));

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				component: 'memory-distiller',
				severity: 'error',
			}),
		);
	});
});
