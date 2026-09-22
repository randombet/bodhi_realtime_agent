/**
 * @bodhi/client-protocol — the client-plane wire contract.
 *
 * Canonical owner of the message unions and wire shapes exchanged between a
 * bodhi voice server and its browser/device clients, plus the few runtime
 * constants both sides must agree on (pacing table, client-media default).
 *
 * Rules (enforced):
 * - Zero dependencies, browser-safe: no Node, DOM-optional, no framework
 *   imports. A lint check forbids `src/` imports from this package.
 * - `src/types/client-protocol.ts` re-exports this package for framework-side
 *   importers; app servers and peers extend it via the module-augmentation
 *   registries.
 */

export const PROTOCOL_PACKAGE = '@bodhi/client-protocol' as const;

export * from './client-media.js';
export * from './messages.js';
export * from './pacing.js';
export * from './rtc.js';
