// SPDX-License-Identifier: MIT

/**
 * OpenAI session update serializer.
 *
 * Ensures session.update, response.create, and response.cancel operations
 * are serialized — no concurrent updates. Each operation waits for its
 * confirmation before allowing the next.
 */

/** A pending operation waiting for confirmation. */
interface PendingOperation {
	type: 'session.update' | 'response.create' | 'response.cancel';
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Serializes session/response operations to prevent race conditions.
 *
 * Usage:
 * ```
 * const ticket = await serializer.acquire('session.update');
 * rt.send({ type: 'session.update', ... });
 * // ... on session.updated event:
 * serializer.release();
 * ```
 */
export class OpenAISessionSerializer {
	private queue: Array<{
		type: PendingOperation['type'];
		resolve: () => void;
		reject: (error: Error) => void;
	}> = [];
	private current: PendingOperation | null = null;
	private timeoutMs: number;

	constructor(timeoutMs = 15_000) {
		this.timeoutMs = timeoutMs;
	}

	/** Acquire a slot for an operation. Resolves when it's your turn. */
	async acquire(type: PendingOperation['type']): Promise<void> {
		if (!this.current) {
			this.startOperation(type);
			return;
		}

		return new Promise<void>((resolve, reject) => {
			this.queue.push({ type, resolve, reject });
		});
	}

	/** Release the current slot (confirmation received). */
	release(): void {
		if (this.current) {
			clearTimeout(this.current.timer);
			this.current.resolve();
			this.current = null;
		}

		// Start next queued operation
		if (this.queue.length > 0) {
			const next = this.queue.shift();
			if (next) {
				this.startOperation(next.type, next.resolve, next.reject);
			}
		}
	}

	/** Reject the current operation (e.g., on error). */
	reject(error: Error): void {
		if (this.current) {
			clearTimeout(this.current.timer);
			this.current.reject(error);
			this.current = null;
		}

		// Drain queue with error
		for (const item of this.queue) {
			item.reject(error);
		}
		this.queue = [];
	}

	/** Whether an operation is currently in progress. */
	get isBusy(): boolean {
		return this.current !== null;
	}

	/** Number of operations waiting in queue. */
	get queueLength(): number {
		return this.queue.length;
	}

	/** Current operation type, or null. */
	get currentType(): PendingOperation['type'] | null {
		return this.current?.type ?? null;
	}

	/** Reset (e.g., on disconnect). */
	reset(): void {
		if (this.current) {
			clearTimeout(this.current.timer);
		}
		this.current = null;
		for (const item of this.queue) {
			item.reject(new Error('Serializer reset'));
		}
		this.queue = [];
	}

	private startOperation(
		type: PendingOperation['type'],
		existingResolve?: () => void,
		_existingReject?: (error: Error) => void,
	): void {
		if (existingResolve) {
			// Queued operation — resolve the acquire promise to signal "your turn"
			existingResolve();
		}

		// Current slot uses no-ops; the acquire promise is already settled
		const resolve: () => void = () => {};
		const reject: (error: Error) => void = () => {};

		const timer = setTimeout(() => {
			if (this.current?.type === type) {
				this.current = null;
				reject(new Error(`${type} timed out after ${this.timeoutMs}ms`));
				// Process next in queue
				if (this.queue.length > 0) {
					const next = this.queue.shift();
					if (next) {
						this.startOperation(next.type, next.resolve, next.reject);
					}
				}
			}
		}, this.timeoutMs);

		this.current = { type, resolve, reject, timer };
	}
}
