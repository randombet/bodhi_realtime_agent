// SPDX-License-Identifier: MIT

import type { EventPayload, EventPayloadMap, EventType, Unsubscribe } from '../types/events.js';

/** Callback function type for a specific event type. */
export type EventHandler<T extends EventType> = (payload: EventPayload<T>) => void;

/**
 * Type-safe event bus interface.
 * All framework components communicate via this bus for loose coupling.
 */
export interface IEventBus {
	/** Synchronously dispatch an event to all registered handlers. */
	publish<T extends EventType>(event: T, payload: EventPayloadMap[T]): void;
	/** Register a handler for an event type. Returns an unsubscribe function. */
	subscribe<T extends EventType>(event: T, handler: EventHandler<T>): Unsubscribe;
	/** Remove all handlers (used for cleanup in tests and session teardown). */
	clear(): void;
}

/**
 * In-memory, synchronous event bus.
 * Handler exceptions are caught and logged — they never propagate to the publisher.
 */
export class EventBus implements IEventBus {
	private handlers = new Map<string, Set<EventHandler<EventType>>>();

	publish<T extends EventType>(event: T, payload: EventPayloadMap[T]): void {
		const set = this.handlers.get(event);
		if (!set) return;

		for (const handler of set) {
			try {
				handler(payload as EventPayload<EventType>);
			} catch (err) {
				console.error(`[EventBus] handler error for "${event}":`, err);
			}
		}
	}

	subscribe<T extends EventType>(event: T, handler: EventHandler<T>): Unsubscribe {
		let set = this.handlers.get(event);
		if (!set) {
			set = new Set();
			this.handlers.set(event, set);
		}
		const captured = set;
		captured.add(handler as EventHandler<EventType>);

		return () => {
			captured.delete(handler as EventHandler<EventType>);
			if (captured.size === 0) {
				this.handlers.delete(event);
			}
		};
	}

	clear(): void {
		this.handlers.clear();
	}
}
