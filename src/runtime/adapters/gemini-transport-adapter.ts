// SPDX-License-Identifier: MIT

/**
 * Gemini Live API transport adapter.
 *
 * Wraps a GeminiLiveTransport (or any LLMTransport implementing Gemini's
 * protocol) and exposes the canonical TransportAdapter interface.
 *
 * Audio stays on the fast path — this adapter only handles control events.
 */

import { BaseTransportAdapter } from './base-transport-adapter.js';

export class GeminiTransportAdapter extends BaseTransportAdapter {
	cancelGeneration(): void {
		// Gemini doesn't support cancel_generation as a distinct command;
		// interruption is signaled by the client starting to speak.
	}
}
