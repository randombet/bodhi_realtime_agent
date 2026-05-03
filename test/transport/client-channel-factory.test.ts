// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { TransportError } from '../../src/core/errors.js';
import { createClientChannel } from '../../src/transport/client-channel-factory.js';
import { ClientTransport } from '../../src/transport/client-transport.js';

describe('createClientChannel', () => {
	it('throws TransportError for livekit profile', () => {
		expect(() =>
			createClientChannel({
				profile: {
					kind: 'livekit',
					serverUrl: 'wss://example.invalid',
					roomName: 'room',
					participantToken: 'token',
				},
				callbacks: {},
			}),
		).toThrow(TransportError);
	});

	it('routes sendAudioToClient through SessionClientSender when clientSender is set', () => {
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
