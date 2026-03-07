// SPDX-License-Identifier: MIT

/**
 * Tracks whether user transcript should flow to the main LLM agent or
 * to an interactive subagent that is waiting for user input.
 *
 * Only one subagent can be the active interaction target at a time.
 * Additional subagents that request interaction are queued (FIFO) and
 * promoted when the currently active one deactivates.
 */

/** Discriminated union describing who currently owns user transcript. */
export type SessionInteractionMode =
	| { type: 'main_agent' }
	| { type: 'subagent_interaction'; toolCallId: string; prompt?: string };

interface QueuedInteraction {
	toolCallId: string;
	prompt?: string;
	resolve: () => void;
}

/**
 * Manages the FIFO queue for interactive subagent sessions.
 *
 * - `activate()` — makes this subagent the interaction target (or queues it).
 * - `deactivate()` — clears the active interaction and promotes the next queued entry.
 * - `getMode()` — returns the current `SessionInteractionMode`.
 */
export class InteractionModeManager {
	private mode: SessionInteractionMode = { type: 'main_agent' };
	private queue: QueuedInteraction[] = [];

	/** Returns the current interaction mode. */
	getMode(): SessionInteractionMode {
		return this.mode;
	}

	/** Shorthand: true when a subagent owns user transcript. */
	isSubagentActive(): boolean {
		return this.mode.type === 'subagent_interaction';
	}

	/** Returns the active subagent's toolCallId, or null if in main_agent mode. */
	getActiveToolCallId(): string | null {
		return this.mode.type === 'subagent_interaction' ? this.mode.toolCallId : null;
	}

	/**
	 * Request interaction ownership for the given subagent.
	 *
	 * - If no subagent is currently active, activates immediately (returned Promise resolves).
	 * - If another subagent is active, enqueues this one (FIFO). The returned Promise
	 *   resolves when this subagent is promoted to the active interaction target.
	 */
	activate(toolCallId: string, prompt?: string): Promise<void> {
		if (this.mode.type === 'main_agent') {
			this.mode = { type: 'subagent_interaction', toolCallId, prompt };
			return Promise.resolve();
		}

		// Already a subagent active — queue this one
		return new Promise<void>((resolve) => {
			this.queue.push({ toolCallId, prompt, resolve });
		});
	}

	/**
	 * Release interaction ownership for the given subagent.
	 *
	 * If this subagent is the active one, promotes the next queued entry (if any)
	 * or reverts to `main_agent` mode. If the subagent is queued (not active),
	 * removes it from the queue.
	 */
	deactivate(toolCallId: string): void {
		if (this.mode.type === 'subagent_interaction' && this.mode.toolCallId === toolCallId) {
			// Active subagent is deactivating — promote next or revert
			this.promoteNext();
			return;
		}

		// Not the active one — remove from queue if present
		const idx = this.queue.findIndex((q) => q.toolCallId === toolCallId);
		if (idx !== -1) {
			this.queue.splice(idx, 1);
		}
	}

	/** Number of subagents waiting in the queue (excluding the active one). */
	get queueLength(): number {
		return this.queue.length;
	}

	private promoteNext(): void {
		const next = this.queue.shift();
		if (next) {
			this.mode = {
				type: 'subagent_interaction',
				toolCallId: next.toolCallId,
				prompt: next.prompt,
			};
			next.resolve();
		} else {
			this.mode = { type: 'main_agent' };
		}
	}
}
