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

describe('ClientSenderAdapter — reconnect-drain semantics', () => {
	it('stopBuffering flushes buffered OUTBOUND audio to the client sender and returns []', () => {
		const sender = mockSender();
		const adapter = new ClientSenderAdapter(sender);
		adapter.startBuffering();
		const a = Buffer.from([1, 2]);
		const b = Buffer.from([3, 4]);
		adapter.sendAudioToClient(a);
		adapter.sendAudioToClient(b);
		expect(sender.sendAudio).not.toHaveBeenCalled();

		const drained = adapter.stopBuffering();

		// The buffer holds ASSISTANT audio — it belongs to the client, never the
		// LLM. The reconnector's drain loop pumps the return value into
		// transport.sendAudio, so the return value MUST be empty.
		expect(drained).toEqual([]);
		expect(sender.sendAudio).toHaveBeenCalledTimes(2);
		expect(sender.sendAudio).toHaveBeenNthCalledWith(1, a);
		expect(sender.sendAudio).toHaveBeenNthCalledWith(2, b);
	});

	it('audio sent after stopBuffering flows directly to the sender in order', () => {
		const sender = mockSender();
		const adapter = new ClientSenderAdapter(sender);
		adapter.startBuffering();
		adapter.sendAudioToClient(Buffer.from([1]));
		adapter.stopBuffering();
		adapter.sendAudioToClient(Buffer.from([2]));
		expect(sender.sendAudio).toHaveBeenCalledTimes(2);
	});
});
