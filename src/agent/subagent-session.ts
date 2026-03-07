// SPDX-License-Identifier: MIT

import { FrameworkError } from '../core/errors.js';
import type { SubagentConfig } from '../types/agent.js';
import type { UIPayload } from '../types/conversation.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Thrown when a SubagentSession is cancelled (user disconnect, agent transfer, explicit cancel). */
export class CancelledError extends FrameworkError {
	constructor(message = 'Subagent session cancelled') {
		super(message, { component: 'subagent-session', severity: 'warn' });
		this.name = 'CancelledError';
	}
}

/** Thrown when waitForInput() exceeds its timeout. */
export class InputTimeoutError extends FrameworkError {
	constructor(timeoutMs: number) {
		super(`waitForInput timed out after ${timeoutMs}ms`, {
			component: 'subagent-session',
			severity: 'warn',
		});
		this.name = 'InputTimeoutError';
	}
}

/** Thrown when the session completes while a waitForInput()/nextUserInput() is pending. */
export class SessionCompletedError extends FrameworkError {
	constructor() {
		super('Subagent session completed while waiting for input', {
			component: 'subagent-session',
			severity: 'warn',
		});
		this.name = 'SessionCompletedError';
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Message sent from a subagent to the user via the main voice agent. */
export interface SubagentMessage {
	type: 'progress' | 'question' | 'approval_request' | 'result';
	text: string;
	action?: string;
	blocking?: boolean;
	uiPayload?: UIPayload;
}

/** SubagentSession lifecycle states. */
export type SubagentSessionState = 'running' | 'waiting_for_input' | 'completed' | 'cancelled';

/** Extends SubagentConfig with interactive session options. */
export interface InteractiveSubagentConfig extends SubagentConfig {
	/** Whether this subagent supports interactive user input. */
	interactive?: boolean;
	/** Timeout per waitForInput() call in ms. Default: 120_000 (2 min). */
	inputTimeout?: number;
	/** Max retries before cancellation on timeout. Default: 3. */
	maxInputRetries?: number;
}

type MessageHandler = (msg: SubagentMessage) => void;
type StateChangeHandler = (newState: SubagentSessionState, oldState: SubagentSessionState) => void;

// ---------------------------------------------------------------------------
// SubagentSession interface
// ---------------------------------------------------------------------------

/** Public interface for interacting with an interactive subagent session. */
export interface SubagentSession {
	readonly toolCallId: string;
	readonly state: SubagentSessionState;

	sendToUser(msg: SubagentMessage): void;
	sendToSubagent(input: string): void;

	waitForInput(timeoutMs?: number): Promise<string>;
	nextUserInput(): Promise<string>;
	cancellation(): Promise<never>;

	onMessage(handler: MessageHandler): void;
	onStateChange(handler: StateChangeHandler): void;

	cancel(): void;
	complete(result: unknown): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface PendingInput {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
}

export class SubagentSessionImpl implements SubagentSession {
	readonly toolCallId: string;

	private _state: SubagentSessionState = 'running';
	private readonly config: InteractiveSubagentConfig | undefined;
	private readonly messageHandlers: MessageHandler[] = [];
	private readonly stateChangeHandlers: StateChangeHandler[] = [];

	/** At most one pending waitForInput()/nextUserInput() at a time. */
	private pendingInput: PendingInput | null = null;

	/** Pending cancellation() Promise — rejects on cancel(). */
	private pendingCancellation: PendingInput | null = null;

	constructor(toolCallId: string, config?: InteractiveSubagentConfig) {
		this.toolCallId = toolCallId;
		this.config = config;
	}

	get state(): SubagentSessionState {
		return this._state;
	}

	// -- Message passing ----------------------------------------------------

	sendToUser(msg: SubagentMessage): void {
		if (this._state === 'completed' || this._state === 'cancelled') {
			throw new FrameworkError(`Cannot sendToUser in state '${this._state}'`, {
				component: 'subagent-session',
			});
		}

		for (const handler of this.messageHandlers) {
			handler(msg);
		}

		// STATE TRIGGER: blocking messages transition to waiting_for_input
		if (msg.blocking) {
			this.transitionTo('waiting_for_input');
		}
	}

	sendToSubagent(input: string): void {
		if (this._state !== 'waiting_for_input') {
			throw new FrameworkError(
				`Cannot sendToSubagent in state '${this._state}' (must be 'waiting_for_input')`,
				{ component: 'subagent-session' },
			);
		}

		this.transitionTo('running');

		if (this.pendingInput) {
			const { resolve } = this.pendingInput;
			this.pendingInput = null;
			resolve(input);
		}
	}

	// -- Async input waiting ------------------------------------------------

	waitForInput(timeoutMs?: number): Promise<string> {
		if (this.pendingInput) {
			throw new FrameworkError('Only one pending waitForInput()/nextUserInput() at a time', {
				component: 'subagent-session',
			});
		}
		if (this._state === 'cancelled') {
			return Promise.reject(new CancelledError());
		}
		if (this._state === 'completed') {
			return Promise.reject(new SessionCompletedError());
		}

		const resolvedTimeout = timeoutMs ?? this.config?.inputTimeout ?? 120_000;

		return new Promise<string>((resolve, reject) => {
			this.pendingInput = { resolve, reject };

			const timer = setTimeout(() => {
				if (this.pendingInput?.reject === reject) {
					this.pendingInput = null;
					reject(new InputTimeoutError(resolvedTimeout));
				}
			}, resolvedTimeout);

			// Ensure timer doesn't block process exit in tests
			if (typeof timer === 'object' && 'unref' in timer) {
				timer.unref();
			}
		});
	}

	nextUserInput(): Promise<string> {
		if (this.pendingInput) {
			throw new FrameworkError('Only one pending waitForInput()/nextUserInput() at a time', {
				component: 'subagent-session',
			});
		}
		if (this._state === 'cancelled') {
			return Promise.reject(new CancelledError());
		}
		if (this._state === 'completed') {
			return Promise.reject(new SessionCompletedError());
		}

		return new Promise<string>((resolve, reject) => {
			this.pendingInput = { resolve, reject };
		});
	}

	cancellation(): Promise<never> {
		if (this._state === 'cancelled') {
			return Promise.reject(new CancelledError());
		}
		return new Promise<never>((_resolve, reject) => {
			// cancellation() never resolves — only rejects. Store a no-op resolve.
			this.pendingCancellation = {
				resolve: () => {},
				reject,
			};
		});
	}

	// -- Event subscription -------------------------------------------------

	onMessage(handler: MessageHandler): void {
		this.messageHandlers.push(handler);
	}

	onStateChange(handler: StateChangeHandler): void {
		this.stateChangeHandlers.push(handler);
	}

	// -- Terminal transitions -----------------------------------------------

	cancel(): void {
		if (this._state === 'cancelled') return; // idempotent
		if (this._state === 'completed') return; // already terminal

		this.transitionTo('cancelled');
		this.rejectAllPending(new CancelledError());
	}

	complete(_result: unknown): void {
		if (this._state === 'completed' || this._state === 'cancelled') {
			return; // idempotent for terminal states
		}

		this.transitionTo('completed');
		this.rejectAllPending(new SessionCompletedError());
	}

	// -- Internal -----------------------------------------------------------

	private transitionTo(newState: SubagentSessionState): void {
		const oldState = this._state;
		if (oldState === newState) return;

		this._state = newState;
		for (const handler of this.stateChangeHandlers) {
			handler(newState, oldState);
		}
	}

	private rejectAllPending(err: Error): void {
		if (this.pendingInput) {
			const { reject } = this.pendingInput;
			this.pendingInput = null;
			reject(err);
		}
		if (this.pendingCancellation) {
			const { reject } = this.pendingCancellation;
			this.pendingCancellation = null;
			reject(err);
		}
	}
}
