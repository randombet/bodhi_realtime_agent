// SPDX-License-Identifier: MIT

import type { FrameworkHooks } from '../types/hooks.js';

/**
 * Manages registered lifecycle hooks and exposes them as getter accessors.
 * Zero-overhead pattern: callers check `if (hooks.onX) hooks.onX(event)`.
 */
export class HooksManager {
	private hooks: FrameworkHooks = {};

	/** Register (or overwrite) hook callbacks. Merges with any previously registered hooks. */
	register(hooks: FrameworkHooks): void {
		Object.assign(this.hooks, hooks);
	}

	get onSessionStart() {
		return this.hooks.onSessionStart;
	}
	get onSessionEnd() {
		return this.hooks.onSessionEnd;
	}
	get onTurnLatency() {
		return this.hooks.onTurnLatency;
	}
	get onToolCall() {
		return this.hooks.onToolCall;
	}
	get onToolResult() {
		return this.hooks.onToolResult;
	}
	get onAgentTransfer() {
		return this.hooks.onAgentTransfer;
	}
	get onSubagentStep() {
		return this.hooks.onSubagentStep;
	}
	get onRealtimeLLMUsage() {
		return this.hooks.onRealtimeLLMUsage;
	}
	get onMemoryExtraction() {
		return this.hooks.onMemoryExtraction;
	}
	get onTTSSynthesis() {
		return this.hooks.onTTSSynthesis;
	}
	get onError() {
		return this.hooks.onError;
	}
}
