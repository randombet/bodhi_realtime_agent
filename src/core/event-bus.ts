import type { EventPayload, EventPayloadMap, EventType, Unsubscribe } from '../types/events.js';

export type EventHandler<T extends EventType> = (payload: EventPayload<T>) => void;

export interface IEventBus {
	publish<T extends EventType>(event: T, payload: EventPayloadMap[T]): void;
	subscribe<T extends EventType>(event: T, handler: EventHandler<T>): Unsubscribe;
	clear(): void;
}

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
