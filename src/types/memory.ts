export type MemoryCategory = 'preference' | 'entity' | 'decision' | 'requirement';

export interface MemoryFact {
	content: string;
	category: MemoryCategory;
	timestamp: number;
}

export interface MemoryStore {
	addFacts(userId: string, facts: MemoryFact[]): Promise<void>;
	getAll(userId: string): Promise<MemoryFact[]>;
	replaceAll(userId: string, facts: MemoryFact[]): Promise<void>;
}
