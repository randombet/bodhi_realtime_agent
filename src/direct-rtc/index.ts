/**
 * Internal engine entry — the werift + `@evan/opus` RTC audio engine behind
 * `clientMedia: { kind: 'direct_rtc', rtcAudio: 'werift_opus' }`.
 *
 * Not a public entry point: the package maps it through its private `#direct-rtc`
 * import, so only the package's own files load it. It is the only entry that loads
 * werift and the native Opus codec. The root entry never references it statically, so
 * `bodhi-realtime-agent` bundles without native dependencies; a `werift_opus` session
 * loads this module on its first `rtc.offer`. No configuration is needed to use it.
 */

import { WeriftOpusRtcEngine } from '../transport/werift-opus-rtc-engine.js';
import type { RtcAudioEngine, RtcAudioEngineOptions } from '../types/rtc-engine.js';

/** Builds the werift + Opus engine for one `DirectRtcClientChannel`. */
export const createWeriftOpusRtcEngine = (options: RtcAudioEngineOptions): RtcAudioEngine =>
	new WeriftOpusRtcEngine(options);
