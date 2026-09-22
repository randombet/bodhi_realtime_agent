/**
 * WebRTC signaling messages exchanged over the existing WebSocket JSON plane
 * (`sendJsonToClient` / `feedJsonFromClient`) while audio uses a direct RTC path.
 *
 * Canonically owned by `@bodhi/client-protocol` (directionality corrected
 * there: client sends `rtc.offer`/`rtc.ice_candidate`, server sends
 * `rtc.answer`/`rtc.ice_candidate`/`rtc.error`); re-exported here for
 * framework-side importers.
 */

export type { RtcClientSignalingMessage, RtcServerSignalingMessage } from '@bodhi/client-protocol';
export { tryParseRtcClientSignaling } from '@bodhi/client-protocol';
