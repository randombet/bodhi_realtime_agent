// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------------------
// Core runtime
// ---------------------------------------------------------------------------

export type { ActorId, CorrelationId, Envelope } from './envelope.js';
export { createEnvelope } from './envelope.js';

export type { RuntimeMessage, RuntimeMessageType } from './messages.js';
export { assertNever } from './messages.js';

export type { Actor } from './actor-runtime.js';
export { ActorRuntime } from './actor-runtime.js';

export type { SupervisionAction, SupervisionDecision, SupervisionPolicy } from './supervisor.js';
export { Supervisor, DEFAULT_POLICIES } from './supervisor.js';

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export { TransportActor } from './actors/transport-actor.js';
export { SessionActor } from './actors/session-actor.js';
export type { ReconnectPolicy, SessionPhase } from './actors/session-actor.js';
export { ToolRouterActor } from './actors/tool-router-actor.js';
export type { ToolRoutingInfo, InlineToolExecutor } from './actors/tool-router-actor.js';
export { SubagentSupervisorActor } from './actors/subagent-supervisor-actor.js';
export { MainAgentActor } from './actors/main-agent-actor.js';
export type { AgentDefinition, MainAgentHooks } from './actors/main-agent-actor.js';
export { ClientGatewayActor } from './actors/client-gateway-actor.js';
export type { ClientSendFn } from './actors/client-gateway-actor.js';

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export type { TransportAdapter, AdapterToolCall } from './adapters/transport-adapter.js';
export { BaseTransportAdapter } from './adapters/base-transport-adapter.js';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export type {
	SubagentCompletion,
	SubagentCompletionStatus,
	SubagentArtifact,
	SubagentCompletionMetadata,
} from './subagent-completion.js';
export {
	buildSuccessCompletion,
	buildFailureCompletion,
	buildCancelledCompletion,
} from './subagent-completion.js';

export { RuntimeObserver } from './observability.js';
export type { ObservabilityListener, ObservableEvent, RuntimeMetrics } from './observability.js';

export { DeadLetterQueue } from './dead-letter-queue.js';
export type { DeadLetterEntry } from './dead-letter-queue.js';

export { ReconnectRecovery } from './reconnect-recovery.js';
export type { RecoverableWorkflow } from './reconnect-recovery.js';

// ---------------------------------------------------------------------------
// Orchestrator (convenience wiring)
// ---------------------------------------------------------------------------

export { RuntimeOrchestrator } from './runtime-orchestrator.js';
export type { OrchestratorConfig } from './runtime-orchestrator.js';
