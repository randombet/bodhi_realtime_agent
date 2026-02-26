// SPDX-License-Identifier: MIT

import type { ExternalEvent, NotificationPriority } from './agent.js';
import type { SubagentResult } from './conversation.js';

/**
 * A notification produced by a service subagent, queued for delivery to the user.
 * Urgent notifications may interrupt the current turn; normal ones wait for a natural pause.
 */
export interface QueuedNotification {
	/** Human-readable notification text to speak/display. */
	text: string;
	/** Delivery urgency. */
	priority: NotificationPriority;
	/** Full subagent output that produced this notification. */
	result: SubagentResult;
	/** The external event that triggered the notification. */
	event: ExternalEvent;
	/** Unix timestamp (ms) when this notification was queued. */
	queuedAt: number;
}
