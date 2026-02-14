import type { ExternalEvent, NotificationPriority } from './agent.js';
import type { SubagentResult } from './conversation.js';

/** Queued notification waiting for delivery */
export interface QueuedNotification {
	text: string;
	priority: NotificationPriority;
	result: SubagentResult;
	event: ExternalEvent;
	queuedAt: number;
}
