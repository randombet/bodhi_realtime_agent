// SPDX-License-Identifier: MIT

/**
 * How the framework attaches to one end-user client for the realtime **media** plane.
 * Control JSON (UI, files, text, session signals) stays on WebSocket unless a channel
 * implementation chooses otherwise.
 *
 * Default when omitted on `VoiceSessionConfig`: `{ kind: 'websocket' }`.
 */
export type ClientMediaProfile =
	| { readonly kind: 'websocket' }
	| {
			readonly kind: 'direct_rtc';
			/**
			 * Optional ICE server list for the future browser↔framework RTC engine.
			 * Not consumed until the media stack is wired; safe to omit.
			 */
			readonly iceServers?: readonly IceServerEntry[];
			/**
			 * `none` (default): mic + assistant PCM on the WebSocket binary path.
			 * `werift_opus`: Opus RTP over an embedded werift `RTCPeerConnection` (requires `VoiceSession` to pass `directRtcMedia` via `createClientChannel`).
			 */
			readonly rtcAudio?: 'none' | 'werift_opus';
	  };

/** STUN/TURN entry for `direct_rtc` (forwarded to the RTC stack when implemented). */
export interface IceServerEntry {
	readonly urls: string | readonly string[];
	readonly username?: string;
	readonly credential?: string;
}

/** Default client media profile: binary PCM + JSON over WebSocket (`IClientChannel`). */
export const DEFAULT_CLIENT_MEDIA_PROFILE: ClientMediaProfile = { kind: 'websocket' };

/** Current control/signaling plane used by Bodhi client sessions. */
export type ClientSignalSource = 'websocket_json';

/** Current audio plane used on the client leg. */
export type ClientAudioSource = 'websocket_pcm' | 'rtc_opus';

/** Wire-visible transport summary for a client session. */
export interface ClientTransportDescriptor {
	readonly clientMedia: ClientMediaProfile;
	readonly clientSignalSource: ClientSignalSource;
	readonly clientAudioSource: ClientAudioSource;
}

export function describeClientTransport(
	profile: ClientMediaProfile = DEFAULT_CLIENT_MEDIA_PROFILE,
): ClientTransportDescriptor {
	return {
		clientMedia: profile,
		clientSignalSource: 'websocket_json',
		clientAudioSource:
			profile.kind === 'direct_rtc' && profile.rtcAudio === 'werift_opus'
				? 'rtc_opus'
				: 'websocket_pcm',
	};
}
