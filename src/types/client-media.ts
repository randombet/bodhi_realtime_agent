/**
 * How the framework attaches to one end-user client for the realtime **media** plane.
 * Control JSON (UI, files, text, session signals) stays on WebSocket unless a channel
 * implementation chooses otherwise.
 *
 * Wire types are canonically owned by `@bodhi/client-protocol` (browser-safe,
 * zero-dep) and re-exported here so framework-side importers keep one door.
 * The runtime helper `describeClientTransport()` is framework-side and stays.
 *
 * Default when omitted on `VoiceSessionConfig`: `{ kind: 'websocket' }`.
 */

import type { ClientMediaProfile, ClientTransportDescriptor } from '@bodhi/client-protocol';
import { DEFAULT_CLIENT_MEDIA_PROFILE } from '@bodhi/client-protocol';

export type {
	AudioFormatSpec,
	ClientAudioSource,
	ClientMediaProfile,
	ClientSignalSource,
	ClientTransportDescriptor,
	IceServerEntry,
} from '@bodhi/client-protocol';
export { DEFAULT_CLIENT_MEDIA_PROFILE } from '@bodhi/client-protocol';

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
