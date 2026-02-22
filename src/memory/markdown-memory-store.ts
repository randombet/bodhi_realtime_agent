// SPDX-License-Identifier: MIT

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { MemoryCategory, MemoryFact, MemoryStore } from '../types/memory.js';

/** Canonical ordering for category sections in the markdown file. */
const CATEGORY_ORDER: MemoryCategory[] = ['preference', 'entity', 'decision', 'requirement'];

/** Human-readable headings for each category. */
const CATEGORY_HEADINGS: Record<MemoryCategory, string> = {
	preference: 'Preferences',
	entity: 'Entities',
	decision: 'Decisions',
	requirement: 'Requirements',
};

/**
 * File-based MemoryStore that persists facts as a Markdown file per user.
 *
 * File layout:
 * ```
 * ## Preferences
 * - Prefers dark mode
 * - Likes concise answers
 *
 * ## Entities
 * - Works at Acme Corp
 * ```
 *
 * - `addFacts()`: Appends new facts (rewrites the file when inserting into existing categories).
 * - `replaceAll()`: Atomically overwrites using `write-file-atomic` (safe for concurrent access).
 * - Files are stored at `{baseDir}/{userId}.md`.
 */
export class MarkdownMemoryStore implements MemoryStore {
	constructor(private baseDir: string) {}

	async addFacts(userId: string, facts: MemoryFact[]): Promise<void> {
		if (facts.length === 0) return;

		const filePath = this.filePath(userId);
		await mkdir(dirname(filePath), { recursive: true });

		// Group facts by category
		const grouped = new Map<MemoryCategory, MemoryFact[]>();
		for (const fact of facts) {
			const list = grouped.get(fact.category) ?? [];
			list.push(fact);
			grouped.set(fact.category, list);
		}

		// Read existing content to determine which headings already exist
		const existing = await this.readFileOrEmpty(filePath);
		const existingCategories = new Set<MemoryCategory>();
		for (const cat of CATEGORY_ORDER) {
			if (existing.includes(`## ${CATEGORY_HEADINGS[cat]}`)) {
				existingCategories.add(cat);
			}
		}

		// Build append content
		let append = '';
		for (const cat of CATEGORY_ORDER) {
			const catFacts = grouped.get(cat);
			if (!catFacts) continue;

			if (!existingCategories.has(cat)) {
				append += `\n## ${CATEGORY_HEADINGS[cat]}\n`;
			}
			for (const fact of catFacts) {
				append += `\n- ${fact.content}`;
			}
			append += '\n';
		}

		// For categories that already exist, we need to insert facts under the heading.
		// Simpler approach: if any existing heading needs appending, rewrite the whole file.
		const hasExistingCategory = [...grouped.keys()].some((cat) => existingCategories.has(cat));

		if (hasExistingCategory && existing.length > 0) {
			// Parse and rebuild
			const allFacts = this.parseFacts(existing);
			allFacts.push(...facts);
			await this.writeAllFacts(filePath, allFacts);
		} else {
			// Pure append
			await appendFile(filePath, append);
		}
	}

	async getAll(userId: string): Promise<MemoryFact[]> {
		const content = await this.readFileOrEmpty(this.filePath(userId));
		if (!content.trim()) return [];
		return this.parseFacts(content);
	}

	async replaceAll(userId: string, facts: MemoryFact[]): Promise<void> {
		const filePath = this.filePath(userId);
		await mkdir(dirname(filePath), { recursive: true });
		await this.writeAllFacts(filePath, facts);
	}

	private filePath(userId: string): string {
		return join(this.baseDir, `${userId}.md`);
	}

	private async readFileOrEmpty(filePath: string): Promise<string> {
		try {
			return await readFile(filePath, 'utf-8');
		} catch {
			return '';
		}
	}

	private parseFacts(content: string): MemoryFact[] {
		const facts: MemoryFact[] = [];
		let currentCategory: MemoryCategory | null = null;

		// Build reverse lookup: heading → category
		const headingToCategory = new Map<string, MemoryCategory>();
		for (const cat of CATEGORY_ORDER) {
			headingToCategory.set(CATEGORY_HEADINGS[cat], cat);
		}

		for (const line of content.split('\n')) {
			const headingMatch = line.match(/^## (.+)$/);
			if (headingMatch) {
				currentCategory = headingToCategory.get(headingMatch[1]) ?? null;
				continue;
			}

			const bulletMatch = line.match(/^- (.+)$/);
			if (bulletMatch && currentCategory) {
				facts.push({
					content: bulletMatch[1],
					category: currentCategory,
					timestamp: 0,
				});
			}
		}

		return facts;
	}

	private async writeAllFacts(filePath: string, facts: MemoryFact[]): Promise<void> {
		// Group by category
		const grouped = new Map<MemoryCategory, MemoryFact[]>();
		for (const fact of facts) {
			const list = grouped.get(fact.category) ?? [];
			list.push(fact);
			grouped.set(fact.category, list);
		}

		// Build markdown
		let content = '';
		for (const cat of CATEGORY_ORDER) {
			const catFacts = grouped.get(cat);
			if (!catFacts || catFacts.length === 0) continue;

			if (content.length > 0) content += '\n';
			content += `## ${CATEGORY_HEADINGS[cat]}\n`;
			for (const fact of catFacts) {
				content += `\n- ${fact.content}`;
			}
			content += '\n';
		}

		await writeFileAtomic(filePath, content);
	}
}
