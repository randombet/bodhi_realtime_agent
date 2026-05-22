// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { GeminiLiveTransport } from '../../src/transport/gemini-live-transport.js';
import { OpenAIRealtimeTransport } from '../../src/transport/openai-realtime-transport.js';
import { DEFAULT_TRANSPORT_CAPABILITIES } from '../../src/types/transport.js';

describe('TransportCapabilities defaults', () => {
	it('playbackGatedTurnComplete defaults to false', () => {
		expect(DEFAULT_TRANSPORT_CAPABILITIES.playbackGatedTurnComplete).toBe(false);
	});
});

describe('playbackGatedTurnComplete per transport', () => {
	it('Gemini Live: turnComplete is playback-gated → true', () => {
		const t = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
		expect(t.capabilities.playbackGatedTurnComplete).toBe(true);
	});

	it('OpenAI Realtime: response.done is generation-gated → false', () => {
		const t = new OpenAIRealtimeTransport({ apiKey: 'test-key', model: 'gpt-realtime' });
		expect(t.capabilities.playbackGatedTurnComplete).toBe(false);
	});
});
