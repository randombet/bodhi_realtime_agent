/**
 * OpenAI Realtime API transport adapter.
 *
 * Wraps an OpenAIRealtimeTransport (or any LLMTransport implementing OpenAI's
 * protocol) and exposes the canonical TransportAdapter interface.
 *
 * Audio stays on the fast path — this adapter only handles control events.
 */

import { BaseTransportAdapter } from './base-transport-adapter.js';

/**
 * OpenAI-specific adapter. The base class's default `cancelGeneration()` —
 * which routes through `transport.cancelResponse?.({})` — is the correct
 * behaviour for OpenAI, so no override is needed.
 *
 * Historically this class called `transport.clearAudio()`, which cleared
 * the input audio buffer rather than cancelling the response. That bug is
 * now fixed by the base implementation.
 */
export class OpenAITransportAdapter extends BaseTransportAdapter {}
