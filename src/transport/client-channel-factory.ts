// SPDX-License-Identifier: MIT

import { TransportError } from '../core/errors.js';
import type { ClientMediaProfile } from '../types/client-media.js';
import type { IClientChannel } from '../types/session-client.js';
import type { SessionClientSender } from '../types/session-client.js';
import { ClientSenderAdapter } from './client-sender-adapter.js';
import { ClientTransport, type ClientTransportCallbacks } from './client-transport.js';
import { DirectRtcClientChannel } from './direct-rtc-client-channel.js';

/** PCM bridge for `direct_rtc` + `rtcAudio: 'werift_opus'` (see {@link createClientChannel}). */
export interface DirectRtcMediaParams {
	readonly inputPcmSampleRate: number;
	readonly outputPcmSampleRate: number;
	readonly onInboundPcm: (pcm: Buffer) => void;
}

/** Inputs needed to construct an `IClientChannel` for the active `ClientMediaProfile`. */
export interface CreateClientChannelParams {
	readonly profile: ClientMediaProfile;
	/** When set, server owns the WebSocket and feeds inbound audio/JSON via `VoiceSession.feedAudioFromClient`. */
	readonly clientSender?: SessionClientSender;
	/** Required when `profile` is `direct_rtc` with `rtcAudio: 'werift_opus'`. */
	readonly directRtcMedia?: DirectRtcMediaParams;
	/** Local `ClientTransport` listen port (ignored when `clientSender` is set). */
	readonly port?: number;
	readonly host?: string;
	readonly listenTimeoutMs?: number;
	readonly callbacks: ClientTransportCallbacks;
}

/**
 * Builds the client ↔ session media channel for a `VoiceSession`.
 *
 * - **`websocket`**: `SessionClientSender` → {@link ClientSenderAdapter}; otherwise {@link ClientTransport}.
 * - **`direct_rtc`**: {@link DirectRtcClientChannel} — JSON/control on WebSocket; optional **Opus RTP** when
 *   `rtcAudio: 'werift_opus'` (requires `directRtcMedia` + runtime `werift` / `@evan/opus`). Otherwise outbound PCM uses `sendAudio`.
 */
export function createClientChannel(params: CreateClientChannelParams): IClientChannel {
	const { profile } = params;

	if (profile.kind === 'direct_rtc') {
		if (!params.clientSender) {
			throw new TransportError(
				'direct_rtc requires clientSender (WebSocket JSON/control plane). Local ClientTransport-only mode is not supported for direct_rtc.',
			);
		}
		const rtcAudio = profile.rtcAudio ?? 'none';
		if (rtcAudio === 'werift_opus' && !params.directRtcMedia) {
			throw new TransportError(
				'direct_rtc with rtcAudio werift_opus requires directRtcMedia (PCM sample rates + onInboundPcm callback).',
			);
		}
		const weriftOpus =
			rtcAudio === 'werift_opus' && params.directRtcMedia
				? {
						iceServers: profile.iceServers,
						inputPcmSampleRate: params.directRtcMedia.inputPcmSampleRate,
						outputPcmSampleRate: params.directRtcMedia.outputPcmSampleRate,
						onInboundPcm: params.directRtcMedia.onInboundPcm,
					}
				: undefined;
		return new DirectRtcClientChannel({
			sender: params.clientSender,
			weriftOpus,
			// Opus RTP sends audio on a separate channel from JSON control —
			// the playback-state protocol needs one ordered channel, so it is
			// supported only for the `rtcAudio: 'none'` WebSocket-PCM path.
			supportsPlaybackStateProtocol: rtcAudio !== 'werift_opus',
		});
	}

	if (params.clientSender) {
		// Playback-state support depends on the rendering sink, not just
		// transport ordering: the Spatial Avatar and Twilio senders also write
		// audio + JSON FIFO on one socket, but render through a sink that cannot
		// report playback completion. The sender's producer declares the
		// capability via SessionClientSender.supportsPlaybackStateProtocol;
		// absent ⇒ false.
		return new ClientSenderAdapter(
			params.clientSender,
			params.clientSender.supportsPlaybackStateProtocol === true,
		);
	}

	return new ClientTransport(
		params.port ?? 9900,
		params.callbacks,
		params.host ?? '0.0.0.0',
		params.listenTimeoutMs ?? 10_000,
	);
}
