import type {
	ConversationItem,
	SubagentContextSnapshot,
	SubagentTask,
	ToolCall,
	ToolResult,
} from '../types/conversation.js';
import type { MemoryFact } from '../types/memory.js';

export class ConversationContext {
	private _items: ConversationItem[] = [];
	private _summary: string | null = null;
	private checkpointIndex = 0;

	get items(): readonly ConversationItem[] {
		return this._items;
	}

	get summary(): string | null {
		return this._summary;
	}

	get tokenEstimate(): number {
		let total = 0;
		for (const item of this._items) {
			total += item.content.length / 4;
		}
		if (this._summary) {
			total += this._summary.length / 4;
		}
		return Math.ceil(total);
	}

	addUserMessage(content: string): void {
		this._items.push({ role: 'user', content, timestamp: Date.now() });
	}

	addAssistantMessage(content: string): void {
		this._items.push({ role: 'assistant', content, timestamp: Date.now() });
	}

	addToolCall(call: ToolCall): void {
		this._items.push({
			role: 'tool_call',
			content: JSON.stringify(call),
			timestamp: Date.now(),
		});
	}

	addToolResult(result: ToolResult): void {
		this._items.push({
			role: 'tool_result',
			content: JSON.stringify(result),
			timestamp: Date.now(),
		});
	}

	addAgentTransfer(fromAgent: string, toAgent: string): void {
		this._items.push({
			role: 'transfer',
			content: `Transfer: ${fromAgent} → ${toAgent}`,
			timestamp: Date.now(),
		});
	}

	getItemsSinceCheckpoint(): ConversationItem[] {
		return this._items.slice(this.checkpointIndex);
	}

	markCheckpoint(): void {
		this.checkpointIndex = this._items.length;
	}

	setSummary(summary: string): void {
		this._summary = summary;
		// Evict items before checkpoint — they're now captured in the summary
		this._items = this._items.slice(this.checkpointIndex);
		this.checkpointIndex = 0;
	}

	getSubagentContext(
		task: SubagentTask,
		agentInstructions: string,
		memoryFacts: MemoryFact[],
		recentTurnCount = 10,
	): SubagentContextSnapshot {
		const recentTurns = this._items.slice(-recentTurnCount);
		return {
			task,
			conversationSummary: this._summary,
			recentTurns,
			relevantMemoryFacts: memoryFacts,
			agentInstructions,
		};
	}

	toReplayContent(): Array<{ role: string; parts: Array<{ text: string }> }> {
		const content: Array<{ role: string; parts: Array<{ text: string }> }> = [];

		if (this._summary) {
			content.push({
				role: 'user',
				parts: [{ text: `[Context summary]: ${this._summary}` }],
			});
		}

		for (const item of this._items) {
			const role = item.role === 'user' ? 'user' : 'model';
			content.push({ role, parts: [{ text: item.content }] });
		}

		return content;
	}
}
