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
	  };

/** STUN/TURN entry for `direct_rtc` (forwarded to the RTC stack when implemented). */
export interface IceServerEntry {
	readonly urls: string | readonly string[];
	readonly username?: string;
	readonly credential?: string;
}

/** Default client media profile: binary PCM + JSON over WebSocket (`IClientChannel`). */
export const DEFAULT_CLIENT_MEDIA_PROFILE: ClientMediaProfile = { kind: 'websocket' };
