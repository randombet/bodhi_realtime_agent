// SPDX-License-Identifier: MIT

/**
 * OpenAI Realtime API transport adapter.
 *
 * Wraps an OpenAIRealtimeTransport (or any LLMTransport implementing OpenAI's
 * protocol) and exposes the canonical TransportAdapter interface.
 *
 * Audio stays on the fast path — this adapter only handles control events.
 */

import { BaseTransportAdapter } from './base-transport-adapter.js';

export class OpenAITransportAdapter extends BaseTransportAdapter {
	cancelGeneration(): void {
		// OpenAI supports explicit response cancellation via clearAudio.
		this.transport.clearAudio();
	}
}
