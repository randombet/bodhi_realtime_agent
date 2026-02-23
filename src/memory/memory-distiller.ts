// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { z } from 'zod';
import type { ConversationContext } from '../core/conversation-context.js';
import type { HooksManager } from '../core/hooks.js';
import type { MemoryFact, MemoryStore } from '../types/memory.js';
import { MEMORY_EXTRACTION_PROMPT } from './prompts.js';

const factsSchema = z.object({
	facts: z.array(
		z.object({
			content: z.string(),
			category: z.enum(['preference', 'entity', 'decision', 'requirement']),
		}),
	),
});

/** Configuration for the MemoryDistiller. */
export interface MemoryDistillerConfig {
	/** User whose memory to manage. */
	userId: string;
	/** Session ID for error reporting. */
	sessionId: string;
	/** Extract every N turns (default 5). */
	turnFrequency?: number;
	/** Timeout for each extraction LLM call in milliseconds (default 30 000). */
	extractionTimeoutMs?: number;
}

/**
 * Extracts durable user facts from conversation and persists them to a MemoryStore.
 *
 * **Extraction triggers:**
 * - `onTurnEnd()`: Every `turnFrequency` turns (default 5th turn).
 * - `onCheckpoint()`: Immediately (e.g. on agent transfer, tool result, session close).
 * - `forceExtract()`: Awaitable on-demand extraction.
 *
 * **Coalescing:** Only one extraction runs at a time (`extractionInFlight` flag).
 * Additional triggers while an extraction is running are silently skipped.
 *
 * **Merge-on-write:** Each extraction produces the COMPLETE updated fact list
 * (existing + new, deduplicated, contradictions resolved) and replaces all facts.
 */
export class MemoryDistiller {
	private turnCount = 0;
	private extractionInFlight = false;
	private readonly turnFrequency: number;
	private readonly extractionTimeoutMs: number;
	private readonly userId: string;
	private readonly sessionId: string;

	constructor(
		private conversationContext: ConversationContext,
		private memoryStore: MemoryStore,
		private hooks: HooksManager,
		private model: LanguageModelV1,
		config: MemoryDistillerConfig,
	) {
		this.userId = config.userId;
		this.sessionId = config.sessionId;
		this.turnFrequency = config.turnFrequency ?? 5;
		this.extractionTimeoutMs = config.extractionTimeoutMs ?? 30_000;
	}

	onTurnEnd(): void {
		this.turnCount++;
		if (this.turnCount % this.turnFrequency === 0) {
			this.extract();
		}
	}

	onCheckpoint(): void {
		this.extract();
	}

	async forceExtract(): Promise<void> {
		await this.runExtraction();
	}

	private extract(): void {
		if (this.extractionInFlight) return;
		this.runExtraction().catch((err) => {
			this.reportError(err);
		});
	}

	private async runExtraction(): Promise<void> {
		if (this.extractionInFlight) return;
		this.extractionInFlight = true;
		const startTime = Date.now();

		try {
			const recentItems = this.conversationContext.getItemsSinceCheckpoint();
			if (recentItems.length === 0) return;

			const existing = await this.memoryStore.getAll(this.userId);
			const existingMemory =
				existing.length > 0
					? existing.map((f) => `[${f.category}] ${f.content}`).join('\n')
					: '(none)';

			const recentTranscript = recentItems.map((i) => `[${i.role}]: ${i.content}`).join('\n');

			const prompt = MEMORY_EXTRACTION_PROMPT.replace(
				'{currentDateTime}',
				new Date().toLocaleString('en-US', {
					dateStyle: 'full',
					timeStyle: 'short',
				}),
			)
				.replace('{existingMemory}', existingMemory)
				.replace('{recentTranscript}', recentTranscript);

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), this.extractionTimeoutMs);

			try {
				const { generateObject } = await import('ai');
				const { object } = await generateObject({
					model: this.model,
					prompt,
					schema: factsSchema,
					abortSignal: controller.signal,
				});

				const facts: MemoryFact[] = object.facts.map((f) => ({
					...f,
					timestamp: Date.now(),
				}));
				// Merge-on-write: LLM returns the complete updated fact list
				await this.memoryStore.replaceAll(this.userId, facts);

				this.conversationContext.markCheckpoint();

				if (this.hooks.onMemoryExtraction) {
					this.hooks.onMemoryExtraction({
						userId: this.userId,
						factsExtracted: facts.length,
						durationMs: Date.now() - startTime,
					});
				}
			} finally {
				clearTimeout(timeout);
			}
		} finally {
			this.extractionInFlight = false;
		}
	}

	private reportError(error: unknown): void {
		if (this.hooks.onError) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.hooks.onError({
				sessionId: this.sessionId,
				component: 'memory-distiller',
				error: err,
				severity: 'error',
			});
		}
	}
}
