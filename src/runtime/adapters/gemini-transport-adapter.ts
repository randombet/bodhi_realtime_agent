/**
 * Gemini Live API transport adapter.
 *
 * Wraps a GeminiLiveTransport (or any LLMTransport implementing Gemini's
 * protocol) and exposes the canonical TransportAdapter interface.
 *
 * Audio stays on the fast path — this adapter only handles control events.
 */

import { BaseTransportAdapter } from './base-transport-adapter.js';

/**
 * Gemini-specific adapter. The base class's default `cancelGeneration()` —
 * which calls `transport.cancelResponse?.({})` — resolves to a no-op for
 * Gemini (no distinct cancel-generation wire command; interruption is
 * provider-driven via `serverContent.interrupted`), so no override is needed.
 */
export class GeminiTransportAdapter extends BaseTransportAdapter {}
