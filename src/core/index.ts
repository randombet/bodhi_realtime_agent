// SPDX-License-Identifier: MIT

export {
	AgentError,
	FrameworkError,
	MemoryError,
	SessionError,
	ToolExecutionError,
	TransportError,
	ValidationError,
} from './errors.js';
export type { ErrorSeverity } from './errors.js';

export { BackgroundNotificationQueue } from './background-notification-queue.js';
export type { SendOrQueueOptions } from './background-notification-queue.js';

export {
	DEFAULT_CONNECT_TIMEOUT_MS,
	DEFAULT_EXTRACTION_TIMEOUT_MS,
	DEFAULT_RECONNECT_TIMEOUT_MS,
	DEFAULT_SUBAGENT_TIMEOUT_MS,
	DEFAULT_TOOL_TIMEOUT_MS,
} from './constants.js';

export { DirectiveManager } from './directive-manager.js';

export { InteractionModeManager } from './interaction-mode.js';
export type { SessionInteractionMode } from './interaction-mode.js';

export { EventBus } from './event-bus.js';
export type { EventHandler, IEventBus } from './event-bus.js';

export { HooksManager } from './hooks.js';

export { ConversationContext } from './conversation-context.js';

export { ConversationHistoryWriter } from './conversation-history-writer.js';

export { SessionManager } from './session-manager.js';

export { InMemorySessionStore } from './session-store.js';
export type { SessionStore } from './session-store.js';

export { MemoryCacheManager } from './memory-cache-manager.js';

export { ToolCallRouter } from './tool-call-router.js';
export type { ToolCallRouterDeps } from './tool-call-router.js';

export { TranscriptManager } from './transcript-manager.js';
export type { TranscriptSink } from './transcript-manager.js';

export { VoiceSession } from './voice-session.js';
export type { VoiceSessionConfig } from './voice-session.js';
