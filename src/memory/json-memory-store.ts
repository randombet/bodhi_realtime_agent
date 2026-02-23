// SPDX-License-Identifier: MIT

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { MemoryFact, MemoryStore } from '../types/memory.js';

/** On-disk JSON structure for a user's memory file. */
interface MemoryFile {
	directives: Record<string, string>;
	facts: Array<{ content: string; category: string }>;
}

const EMPTY_FILE: MemoryFile = { directives: {}, facts: [] };

/**
 * File-based MemoryStore that persists facts and directives as a JSON file per user.
 *
 * File layout (`{baseDir}/{userId}.json`):
 * ```json
 * {
 *   "directives": { "pacing": "slow" },
 *   "facts": [
 *     { "content": "Prefers dark mode", "category": "preference" }
 *   ]
 * }
 * ```
 *
 * All writes use `write-file-atomic` for crash-safe persistence.
 */
export class JsonMemoryStore implements MemoryStore {
	constructor(private baseDir: string) {}

	async addFacts(userId: string, facts: MemoryFact[]): Promise<void> {
		if (facts.length === 0) return;

		const filePath = this.filePath(userId);
		const file = await this.readFile(filePath);
		for (const fact of facts) {
			file.facts.push({ content: fact.content, category: fact.category });
		}
		await this.writeFile(filePath, file);
	}

	async getAll(userId: string): Promise<MemoryFact[]> {
		const file = await this.readFile(this.filePath(userId));
		return file.facts.map((f) => ({
			content: f.content,
			category: f.category as MemoryFact['category'],
			timestamp: 0,
		}));
	}

	async replaceAll(userId: string, facts: MemoryFact[]): Promise<void> {
		const filePath = this.filePath(userId);
		const file = await this.readFile(filePath);
		file.facts = facts.map((f) => ({ content: f.content, category: f.category }));
		await this.writeFile(filePath, file);
	}

	async getDirectives(userId: string): Promise<Record<string, string>> {
		const file = await this.readFile(this.filePath(userId));
		return { ...file.directives };
	}

	async setDirectives(userId: string, directives: Record<string, string>): Promise<void> {
		const filePath = this.filePath(userId);
		const file = await this.readFile(filePath);
		file.directives = { ...directives };
		await this.writeFile(filePath, file);
	}

	private filePath(userId: string): string {
		return join(this.baseDir, `${userId}.json`);
	}

	private async readFile(filePath: string): Promise<MemoryFile> {
		try {
			const raw = await readFile(filePath, 'utf-8');
			if (!raw.trim()) return { ...EMPTY_FILE, directives: {}, facts: [] };
			const parsed = JSON.parse(raw) as Partial<MemoryFile>;
			return {
				directives:
					parsed.directives && typeof parsed.directives === 'object'
						? { ...parsed.directives }
						: {},
				facts: Array.isArray(parsed.facts) ? [...parsed.facts] : [],
			};
		} catch {
			return { ...EMPTY_FILE, directives: {}, facts: [] };
		}
	}

	private async writeFile(filePath: string, file: MemoryFile): Promise<void> {
		await mkdir(dirname(filePath), { recursive: true });
		await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
	}
}
