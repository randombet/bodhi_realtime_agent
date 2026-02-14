export type ErrorSeverity = 'warn' | 'error' | 'fatal';

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

export class TransportError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'transport', ...options });
		this.name = 'TransportError';
	}
}

export class SessionError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'session', ...options });
		this.name = 'SessionError';
	}
}

export class ToolExecutionError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'tool', ...options });
		this.name = 'ToolExecutionError';
	}
}

export class AgentError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'agent', ...options });
		this.name = 'AgentError';
	}
}

export class MemoryError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'memory', ...options });
		this.name = 'MemoryError';
	}
}

export class ValidationError extends FrameworkError {
	constructor(message: string, options?: { severity?: ErrorSeverity; cause?: Error }) {
		super(message, { component: 'validation', ...options });
		this.name = 'ValidationError';
	}
}
