export {
	AgentError,
	CachePrefixMutationError,
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

export { Turn } from './turn.js';
export type { TurnMatch, TurnSignalPurpose, TurnState } from './turn.js';

export {
	computeCacheHitRatio,
	deriveProviderItemId,
	deriveUsageSource,
} from './usage-helpers.js';
// RealtimeUsageSource is exported from src/types/index.ts as the canonical
// public type (defined identically in both modules to avoid an import cycle
// between types/events.ts and core/usage-helpers.ts).

export { RECOVERY_CAPABILITIES } from './host-recovery.js';
export type {
	RecoverUpstreamArgs,
	RecoverUpstreamResult,
	RecoveryCapabilities,
} from './host-recovery.js';

export { VoiceSession } from './voice-session.js';
export type {
	InjectTextOptions,
	VoiceSessionConfig,
	VoiceSessionDiagnostics,
} from './voice-session.js';
