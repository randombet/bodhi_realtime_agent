// SPDX-License-Identifier: MIT

export type { ActorId, CorrelationId, Envelope } from './envelope.js';
export { createEnvelope } from './envelope.js';

export type { RuntimeMessage, RuntimeMessageType } from './messages.js';
export { assertNever } from './messages.js';

export type { Actor } from './actor-runtime.js';
export { ActorRuntime } from './actor-runtime.js';

export type { SupervisionAction, SupervisionDecision, SupervisionPolicy } from './supervisor.js';
export { Supervisor, DEFAULT_POLICIES } from './supervisor.js';
