/**
 * Engine-neutral contract for the server-side RTC audio engine behind
 * `clientMedia: { kind: 'direct_rtc', rtcAudio: 'werift_opus' }`.
 *
 * Internal: not exported from the root entry. The root import graph only ever names
 * these types; the concrete werift + `@evan/opus` implementation lives in the internal
 * `#direct-rtc` engine entry and is loaded on first use, so the root bundle carries no
 * native dependency.
 */

import type { IceServerEntry } from './client-media.js';
import type { CoreServerToClientMessage } from './client-protocol.js';
import type { RtcClientSignalingMessage } from './rtc-signaling.js';

/** Construction inputs the client channel hands to the RTC audio engine. */
export interface RtcAudioEngineOptions {
	readonly iceServers: readonly IceServerEntry[] | undefined;
	/** PCM16 rate delivered to `onInboundPcm` (the LLM transport's input rate). */
	readonly inputPcmSampleRate: number;
	/** PCM16 rate of the assistant audio passed to `sendAssistantPcm`. */
	readonly outputPcmSampleRate: number;
	readonly onInboundPcm: (pcm: Buffer) => void;
	/** Server→client signaling (`rtc.answer`, `rtc.ice_candidate`, `rtc.error`) on the JSON plane. */
	readonly emitServerJson: (msg: CoreServerToClientMessage) => void;
	readonly onLog?: (message: string) => void;
	/** Fired once when outbound RTC audio is wired (flush any pre-negotiation assistant PCM). */
	readonly onMediaReady?: () => void;
}

/** One peer's RTC audio engine, owned by `DirectRtcClientChannel`. */
export interface RtcAudioEngine {
	/** True once outbound audio can be sent to the peer. */
	readonly mediaReady: boolean;
	handleClientSignaling(msg: RtcClientSignalingMessage): Promise<void>;
	sendAssistantPcm(pcm: Buffer): void;
	dispose(): Promise<void>;
}
