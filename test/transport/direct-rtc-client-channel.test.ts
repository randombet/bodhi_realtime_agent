// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { DirectRtcClientChannel } from '../../src/transport/direct-rtc-client-channel.js';

describe('DirectRtcClientChannel', () => {
	it('forwards JSON via sender', () => {
		const sendJson = vi.fn();
		const sendAudio = vi.fn();
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio, sendJson },
		});
		ch.sendJsonToClient({ type: 'session.config', audioFormat: { inputSampleRate: 16000 } });
		expect(sendJson).toHaveBeenCalledOnce();
	});

	it('records feedSignaling', () => {
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		});
		const msg = { type: 'rtc.offer' as const, sdp: 'v=0' };
		ch.feedSignaling(msg);
		expect(ch.lastClientSignaling).toEqual(msg);
	});

	it('stopBuffering() flushes buffered assistant audio to the client sink and returns []', () => {
		// H1 (design-hosted-replay-recovery-rollout.md P1): buffered audio is
		// OUTBOUND assistant speech — it must reach the client, never the
		// reconnect drain (which pumps returned chunks into the LLM as input).
		const sendAudio = vi.fn();
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio, sendJson: vi.fn() },
		});

		ch.startBuffering();
		ch.sendAudioToClient(Buffer.from('assistant-one'));
		ch.sendAudioToClient(Buffer.from('assistant-two'));
		expect(sendAudio).not.toHaveBeenCalled(); // held while buffering

		const drained = ch.stopBuffering();
		expect(drained).toEqual([]);
		expect(sendAudio.mock.calls.map((c) => c[0])).toEqual([
			Buffer.from('assistant-one'),
			Buffer.from('assistant-two'),
		]);
	});

	it('audio sent after stopBuffering() flows to the sink directly (no re-buffer)', () => {
		const sendAudio = vi.fn();
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio, sendJson: vi.fn() },
		});
		ch.startBuffering();
		ch.stopBuffering();
		ch.sendAudioToClient(Buffer.from('live'));
		expect(sendAudio).toHaveBeenCalledWith(Buffer.from('live'));
	});
});
