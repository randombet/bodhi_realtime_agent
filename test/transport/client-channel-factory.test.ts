import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TransportError } from '../../src/core/errors.js';
import { createClientChannel } from '../../src/transport/client-channel-factory.js';
import { ClientTransport } from '../../src/transport/client-transport.js';
import { DirectRtcClientChannel } from '../../src/transport/direct-rtc-client-channel.js';

/** Counts evaluations of the native RTC modules anywhere in this file's import graph. */
const nativeLoads = vi.hoisted(() => ({ werift: 0, opus: 0 }));
vi.mock('werift', () => {
	nativeLoads.werift++;
	return {};
});
vi.mock('@evan/opus', () => {
	nativeLoads.opus++;
	return {};
});

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
		// Normal browser PCM web sender — its producer declares support (audio
		// renders via playChunk and reports playback.ended).
		const webPcm = createClientChannel({
			profile: { kind: 'websocket' },
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn(), supportsPlaybackStateProtocol: true },
			callbacks: {},
		});
		expect(webPcm.supportsPlaybackStateProtocol).toBe(true);

		// Spatial Avatar sender — same WebSocket transport, but audio renders
		// through the avatar sink; its producer declares false.
		const avatar = createClientChannel({
			profile: { kind: 'websocket' },
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn(), supportsPlaybackStateProtocol: false },
			callbacks: {},
		});
		expect(avatar.supportsPlaybackStateProtocol).toBe(false);

		// Twilio sender — the phone leg sends no playback signal; producer
		// declares false.
		const twilio = createClientChannel({
			profile: { kind: 'websocket' },
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn(), supportsPlaybackStateProtocol: false },
			callbacks: {},
		});
		expect(twilio.supportsPlaybackStateProtocol).toBe(false);

		// A sender that omits the capability fails safe to false — it is never
		// inferred from the bare { sendAudio, sendJson } shape.
		const unset = createClientChannel({
			profile: { kind: 'websocket' },
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			callbacks: {},
		});
		expect(unset.supportsPlaybackStateProtocol).toBe(false);

		// direct_rtc with rtcAudio 'none' uses the WebSocket-PCM path → supported,
		// derived from the RTC audio mode (not the sender flag).
		const rtcNone = createClientChannel({
			profile: { kind: 'direct_rtc', rtcAudio: 'none' },
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			callbacks: {},
		});
		expect(rtcNone.supportsPlaybackStateProtocol).toBe(true);

		// direct_rtc with rtcAudio 'werift_opus' uses a separate Opus channel →
		// not supported (no directRtcMedia needed since the engine is lazy here).
		const rtcOpus = createClientChannel({
			profile: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			directRtcMedia: {
				inputPcmSampleRate: 16000,
				outputPcmSampleRate: 24000,
				onInboundPcm: vi.fn(),
			},
			callbacks: {},
		});
		expect(rtcOpus.supportsPlaybackStateProtocol).toBe(false);
		// The engine loads on the first rtc.offer: construction evaluates neither native module.
		expect(nativeLoads).toEqual({ werift: 0, opus: 0 });
	});

	it('throws TransportError for werift_opus without directRtcMedia', () => {
		expect(() =>
			createClientChannel({
				profile: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				callbacks: {},
			}),
		).toThrow(TransportError);
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

	it('buffers outbound audio during buffering and flushes it to the client on stopBuffering', () => {
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
		// Outbound assistant audio belongs to the client, never the LLM: the
		// reconnector pumps the return value into transport.sendAudio, so the
		// adapter flushes to the sender and returns [].
		expect(drained).toEqual([]);
		expect(sendAudio).toHaveBeenCalledOnce();
		expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9]));
	});

	it('returns ClientTransport for websocket profile without clientSender', () => {
		const ch = createClientChannel({
			profile: { kind: 'websocket' },
			callbacks: {},
			port: 19_876,
		});
		expect(ch).toBeInstanceOf(ClientTransport);
	});

	it('passes options.probeState to the owned ClientTransport', async () => {
		const probeState = vi.fn(() => ({ type: 'agent.state', v: 1, initialized: true }));
		const ch = createClientChannel({
			profile: { kind: 'websocket' },
			callbacks: {},
			port: 19_877,
			host: '127.0.0.1',
			options: { probeState },
		});
		expect(ch).toBeInstanceOf(ClientTransport);
		await ch.start();
		try {
			const frames = await new Promise<string[]>((resolve, reject) => {
				const received: string[] = [];
				const ws = new WebSocket('ws://127.0.0.1:19877/?probe=1');
				ws.on('message', (data, isBinary) => {
					if (!isBinary) received.push(data.toString());
				});
				ws.on('close', () => resolve(received));
				ws.on('error', reject);
			});
			expect(frames.map((frame) => JSON.parse(frame))).toEqual([
				{ type: 'agent.state', v: 1, initialized: true },
			]);
			expect(probeState).toHaveBeenCalledOnce();
		} finally {
			await ch.stop();
		}
	});
});
