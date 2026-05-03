// SPDX-License-Identifier: MIT

import { TransportError } from '../core/errors.js';
import type { ClientMediaProfile } from '../types/client-media.js';
import type { IClientChannel } from '../types/session-client.js';
import type { SessionClientSender } from '../types/session-client.js';
import { ClientSenderAdapter } from './client-sender-adapter.js';
import { ClientTransport, type ClientTransportCallbacks } from './client-transport.js';
import { DirectRtcClientChannel } from './direct-rtc-client-channel.js';

/** Inputs needed to construct an `IClientChannel` for the active `ClientMediaProfile`. */
export interface CreateClientChannelParams {
	readonly profile: ClientMediaProfile;
	/** When set, server owns the WebSocket and feeds inbound audio/JSON via `VoiceSession.feedAudioFromClient`. */
	readonly clientSender?: SessionClientSender;
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
 * - **`direct_rtc`**: {@link DirectRtcClientChannel} — JSON/control on WebSocket, audio RTC engine wired later;
 *   requires `clientSender`. Until RTC is integrated, outbound PCM still uses `sendAudio` on the sender.
 */
export function createClientChannel(params: CreateClientChannelParams): IClientChannel {
	const { profile } = params;

	if (profile.kind === 'direct_rtc') {
		if (!params.clientSender) {
			throw new TransportError(
				'direct_rtc requires clientSender (WebSocket JSON/control plane). Local ClientTransport-only mode is not supported for direct_rtc.',
			);
		}
		return new DirectRtcClientChannel({
			sender: params.clientSender,
		});
	}

	if (params.clientSender) {
		return new ClientSenderAdapter(params.clientSender);
	}

	return new ClientTransport(
		params.port ?? 9900,
		params.callbacks,
		params.host ?? '0.0.0.0',
		params.listenTimeoutMs ?? 10_000,
	);
}
