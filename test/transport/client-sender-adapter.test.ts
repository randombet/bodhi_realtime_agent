// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { ClientSenderAdapter } from '../../src/transport/client-sender-adapter.js';
import type { SessionClientSender } from '../../src/types/session-client.js';

function mockSender(): SessionClientSender & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		sendAudio: vi.fn(() => {
			calls.push('audio');
		}),
		sendJson: vi.fn((m: Record<string, unknown>) => {
			calls.push(`json:${String(m.type)}`);
		}),
	};
}

describe('ClientSenderAdapter — playback-state protocol', () => {
	it('sendJsonAfterAudio delivers JSON after the audio, in call order', () => {
		const sender = mockSender();
		const adapter = new ClientSenderAdapter(sender);
		adapter.sendAudioToClient(Buffer.from([1, 2]));
		adapter.sendJsonAfterAudio({ type: 'audio.done' });
		expect(sender.calls).toEqual(['audio', 'json:audio.done']);
	});

	it('drops sendJsonAfterAudio during a reconnect-buffering window', () => {
		const sender = mockSender();
		const adapter = new ClientSenderAdapter(sender);
		adapter.startBuffering();
		adapter.sendAudioToClient(Buffer.from([1, 2]));
		adapter.sendJsonAfterAudio({ type: 'audio.done' });
		// Audio buffered for replay, audio.done dropped — turn falls to fallback.
		expect(sender.sendJson).not.toHaveBeenCalled();
		expect(sender.calls).toEqual([]);
	});

	it('supportsPlaybackStateProtocol defaults false and is constructor-set', () => {
		expect(new ClientSenderAdapter(mockSender()).supportsPlaybackStateProtocol).toBe(false);
		expect(new ClientSenderAdapter(mockSender(), true).supportsPlaybackStateProtocol).toBe(true);
	});
});
