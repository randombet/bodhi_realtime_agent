// SPDX-License-Identifier: MIT

import { TransportError } from '../core/errors.js';
import type { ClientMediaProfile } from '../types/client-media.js';
import type { IClientChannel } from '../types/session-client.js';
import type { SessionClientSender } from '../types/session-client.js';
import { ClientSenderAdapter } from './client-sender-adapter.js';
import { ClientTransport, type ClientTransportCallbacks } from './client-transport.js';

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
 * - **`livekit`**: not implemented yet (throws {@link TransportError}); reserved for P1b.
 */
export function createClientChannel(params: CreateClientChannelParams): IClientChannel {
	const { profile } = params;
	if (profile.kind === 'livekit') {
		throw new TransportError(
			'LiveKit client media profile is not implemented yet. Use { kind: "websocket" } or omit clientMedia.',
		);
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
