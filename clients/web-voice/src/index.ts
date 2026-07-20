/**
 * @bodhi/web-voice-client — the shared browser voice client for bodhi
 * sessions (plan phase B). PCM capture/playback, typed protocol dispatch,
 * playback-state handshake, pacing, and the renderer/extension seams.
 *
 * Consumed as TypeScript source through each app's bundler; sole runtime
 * dependency is @bodhi/client-protocol.
 */

export * from './pacing.js';
export * from './pcm-audio.js';
export * from './playback-ended-gate.js';
export * from './renderer.js';
export * from './voice-client.js';
