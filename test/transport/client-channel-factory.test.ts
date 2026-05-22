// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { TransportError } from '../../src/core/errors.js';
import { createClientChannel } from '../../src/transport/client-channel-factory.js';
import { ClientTransport } from '../../src/transport/client-transport.js';
import { DirectRtcClientChannel } from '../../src/transport/direct-rtc-client-channel.js';

describe('createClientChannel', () => {
	it('throws TransportError for direct_rtc without clientSender', () => {
		expect(() =>
			createClientChannel({
				profile: { kind: 'direct_rtc' },
				callbacks: {},
			}),
		).toThrow(TransportError);
	});

	it('returns DirectRtcClientChannel for direct_rtc with clientSender', () => {
		const sendAudio = vi.fn();
		const sendJson = vi.fn();
		const ch = createClientChannel({
			profile: { kind: 'direct_rtc' },
			clientSender: { sendAudio, sendJson },
			callbacks: {},
		});
		expect(ch).toBeInstanceOf(DirectRtcClientChannel);
		const buf = Buffer.from([1, 2, 3]);
		ch.sendAudioToClient(buf);
		expect(sendAudio).toHaveBeenCalledWith(buf);
	});

	it('wires supportsPlaybackStateProtocol per surface', () => {
		const sender = { sendAudio: vi.fn(), sendJson: vi.fn() };
		// WebSocket-PCM web path → supported.
		const webChannel = createClientChannel({
			profile: { kind: 'websocket' },
			clientSender: sender,
			callbacks: {},
		});
		expect(webChannel.supportsPlaybackStateProtocol).toBe(true);

		// direct_rtc with rtcAudio 'none' uses the WebSocket-PCM path → supported.
		const rtcNone = createClientChannel({
			profile: { kind: 'direct_rtc', rtcAudio: 'none' },
			clientSender: sender,
			callbacks: {},
		});
		expect(rtcNone.supportsPlaybackStateProtocol).toBe(true);

		// direct_rtc with rtcAudio 'werift_opus' uses a separate Opus channel →
		// not supported (no directRtcMedia needed since the engine is lazy here).
		const rtcOpus = createClientChannel({
			profile: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
			clientSender: sender,
			directRtcMedia: {
				inputPcmSampleRate: 16000,
				outputPcmSampleRate: 24000,
				onInboundPcm: vi.fn(),
			},
			callbacks: {},
		});
		expect(rtcOpus.supportsPlaybackStateProtocol).toBe(false);
	});

	it('routes sendAudioToClient through SessionClientSender when websocket + clientSender', () => {
		const sendAudio = vi.fn();
		const sendJson = vi.fn();
		const ch = createClientChannel({
			profile: { kind: 'websocket' },
			clientSender: { sendAudio, sendJson },
			callbacks: {},
		});
		const buf = Buffer.from([1, 2, 3]);
		ch.sendAudioToClient(buf);
		expect(sendAudio).toHaveBeenCalledOnce();
		expect(sendAudio).toHaveBeenCalledWith(buf);
	});

	it('buffers outbound audio when using ClientSenderAdapter buffering', () => {
		const sendAudio = vi.fn();
		const sendJson = vi.fn();
		const ch = createClientChannel({
			profile: { kind: 'websocket' },
			clientSender: { sendAudio, sendJson },
			callbacks: {},
		});
		ch.startBuffering();
		ch.sendAudioToClient(Buffer.from([9]));
		expect(sendAudio).not.toHaveBeenCalled();
		const drained = ch.stopBuffering();
		expect(drained).toHaveLength(1);
		expect(drained[0]).toEqual(Buffer.from([9]));
	});

	it('returns ClientTransport for websocket profile without clientSender', () => {
		const ch = createClientChannel({
			profile: { kind: 'websocket' },
			callbacks: {},
			port: 19_876,
		});
		expect(ch).toBeInstanceOf(ClientTransport);
	});
});
