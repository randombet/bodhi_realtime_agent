// SPDX-License-Identifier: MIT

/**
 * How the framework attaches to one end-user client for the realtime **media** plane
 * (PCM today; WebRTC/SFU in later phases). Control JSON may use the same socket (WS)
 * or a split channel; that is decided by the concrete `IClientChannel` implementation.
 *
 * Default when omitted on `VoiceSessionConfig`: `{ kind: 'websocket' }`.
 */
export type ClientMediaProfile =
	| { readonly kind: 'websocket' }
	| {
			readonly kind: 'livekit';
			/** LiveKit server URL (e.g. `wss://project.region.livekit.cloud`). */
			readonly serverUrl: string;
			/** Room name the session joins. */
			readonly roomName: string;
			/** Short-lived JWT for the agent/backend participant. */
			readonly participantToken: string;
	  };

/** Default client media profile: binary PCM + JSON over WebSocket (`IClientChannel`). */
export const DEFAULT_CLIENT_MEDIA_PROFILE: ClientMediaProfile = { kind: 'websocket' };
