import type { FrameworkHooks } from '../types/hooks.js';

export class HooksManager {
	private hooks: FrameworkHooks = {};

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
	get onMemoryExtraction() {
		return this.hooks.onMemoryExtraction;
	}
	get onError() {
		return this.hooks.onError;
	}
}
