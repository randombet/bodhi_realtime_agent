/**
 * Pacing constants shared by both ends of the wire.
 *
 * The server's playback-duration fallback and the client's Web Audio
 * scheduling must agree on the same floor and preset→rate mapping —
 * historically these lived as a private `MIN_PLAYBACK_RATE` in
 * `VoiceSession` and a magic table in the web client's legacy
 * `speech_speed` handler. This module is the single source.
 *
 * The behavior category key these rates apply to is `pacing`
 * (`set_speech_speed` → `behavior.changed { key: 'pacing', preset }`);
 * other categories reuse preset names like `normal`, so consumers MUST
 * filter by key before mapping preset → rate.
 */

/** Behavior category key that carries speech pacing. */
export const PACING_KEY = 'pacing' as const;

/** Floor for client playback rate; the server's playback-duration fallback
 *  assumes audio never plays slower than this. */
export const MIN_PLAYBACK_RATE = 0.85;

/** Default preset→playbackRate mapping for the `pacing` category. Consumers
 *  may override per-app, but must not go below {@link MIN_PLAYBACK_RATE}. */
export const PACING_PRESET_RATES: Readonly<Record<string, number>> = {
	slow: 0.85,
	normal: 1.0,
	fast: 1.2,
};
