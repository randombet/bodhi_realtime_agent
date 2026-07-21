/**
 * Client-media wire types — how a session's media plane is described on the
 * wire (`session.config` / `session.ready`). Moved from
 * `src/types/client-media.ts`, which re-exports these and keeps the
 * framework-side `describeClientTransport()` runtime helper.
 */

export type ClientMediaProfile =
	| { readonly kind: 'websocket' }
	| {
			readonly kind: 'direct_rtc';
			/** Optional ICE server list for the browser↔framework RTC engine. */
			readonly iceServers?: readonly IceServerEntry[];
			/**
			 * `none` (default): mic + assistant PCM on the WebSocket binary path.
			 * `werift_opus`: Opus RTP over an embedded werift `RTCPeerConnection`.
			 */
			readonly rtcAudio?: 'none' | 'werift_opus';
	  };

/** STUN/TURN entry for `direct_rtc`. */
export interface IceServerEntry {
	readonly urls: string | readonly string[];
	readonly username?: string;
	readonly credential?: string;
}

/** Default client media profile: binary PCM + JSON over WebSocket. */
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

/** Audio format specification advertised by a transport (rides in
 *  `session.config`). Input and output rates / encodings may differ —
 *  e.g. Gemini: 16 kHz in / 24 kHz out (both PCM). */
export interface AudioFormatSpec {
	inputSampleRate: number;
	outputSampleRate: number;
	channels: number;
	/** Bits per sample, INPUT side. */
	bitDepth: number;
	/** Wire encoding, INPUT side. `'pcm'` is signed 16-bit linear; `'pcmu'`
	 *  is G.711 μ-law for telephony bridges. */
	encoding: 'pcm' | 'pcmu';
	/** OUTPUT side bit depth. Defaults to `bitDepth` if omitted. */
	outputBitDepth?: number;
	/** OUTPUT side encoding. Defaults to `encoding` if omitted. */
	outputEncoding?: 'pcm' | 'pcmu';
}
