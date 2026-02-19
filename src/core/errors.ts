// SPDX-License-Identifier: MIT

/** Severity level for framework errors, used by the onError hook. */
export type ErrorSeverity = 'warn' | 'error' | 'fatal';

/**
 * Base error class for all framework errors.
 * Carries a `component` tag and `severity` level for structured error handling.
 * Supports cause chaining via the standard `cause` property.
 */
export class FrameworkError extends Error {
	readonly component: string;
	readonly severity: ErrorSeverity;
	override readonly cause?: Error;

	constructor(
		message: string,
		options: { component: string; severity?: ErrorSeverity; cause?: Error },
	) {
		super(message, { cause: options.cause });
		this.name = 'FrameworkError';
		this.component = options.component;
		this.severity = options.severity ?? 'error';
		this.cause = options.cause;
	}
}

/** Error originating from the Gemini or client WebSocket transport layer. */
export class TransportError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'transport', ...options });
		this.name = 'TransportError';
	}
}

/** Error related to session state machine transitions or lifecycle. */
export class SessionError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'session', ...options });
		this.name = 'SessionError';
	}
}

/** Error during tool execution (timeout, validation failure, runtime exception). */
export class ToolExecutionError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'tool', ...options });
		this.name = 'ToolExecutionError';
	}
}

/** Error related to agent routing, transfers, or subagent execution. */
export class AgentError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'agent', ...options });
		this.name = 'AgentError';
	}
}

/** Error in the memory extraction or consolidation pipeline. */
export class MemoryError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'memory', ...options });
		this.name = 'MemoryError';
	}
}

/** Error from input validation (Zod schema, config checks). */
export class ValidationError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'validation', ...options });
		this.name = 'ValidationError';
	}
}
