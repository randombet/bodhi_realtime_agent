// SPDX-License-Identifier: MIT

/**
 * Manages session-scoped and agent-scoped directives.
 *
 * Extracted from VoiceSession to isolate the directive management concern.
 * Session directives persist across agent transfers; agent directives are
 * cleared on each transfer.
 */
export class DirectiveManager {
	private agentDirectives = new Map<string, string>();
	private sessionDirectives = new Map<string, string>();

	/** Set or delete a directive. Defaults to agent scope if not specified. */
	set(key: string, value: string | null, scope?: 'session' | 'agent'): void {
		const map = (scope ?? 'agent') === 'session' ? this.sessionDirectives : this.agentDirectives;
		if (value === null) map.delete(key);
		else map.set(key, value);
	}

	/** Clear agent-scoped directives (called on agent transfer). */
	clearAgent(): void {
		this.agentDirectives.clear();
	}

	/** Returns session-scoped directives formatted as a system instruction suffix. */
	getSessionSuffix(): string {
		if (this.sessionDirectives.size === 0) return '';
		const text = [...this.sessionDirectives.values()].join('\n\n');
		return `\n\n[SESSION DIRECTIVES — user preferences that persist across agents]\n${text}`;
	}

	/**
	 * Merge both directive maps and return formatted reinforcement text.
	 * Agent directives override session directives with the same key.
	 * Returns empty string if no directives are set.
	 */
	getReinforcementText(): string {
		if (this.sessionDirectives.size === 0 && this.agentDirectives.size === 0) return '';
		const merged = new Map([...this.sessionDirectives, ...this.agentDirectives]);
		return `[SYSTEM DIRECTIVES — follow these instructions]\n${[...merged.values()].join('\n\n')}`;
	}
}
