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
});
