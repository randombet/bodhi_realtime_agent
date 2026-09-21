/**
 * WebRTC signaling messages exchanged over the WebSocket JSON plane while
 * audio uses a direct RTC path. Moved from `src/types/rtc-signaling.ts`
 * (which re-exports), with the directionality corrected per the protocol
 * audit: the client sends offers and ICE candidates and *consumes* answers;
 * `rtc.error` is server→client (emitted by the RTC channel/engine on
 * signaling failure) and was previously untyped.
 */

/** Client → server signaling (carried as JSON `type` on the control WebSocket). */
export type RtcClientSignalingMessage =
	| { type: 'rtc.offer'; sdp: string }
	| { type: 'rtc.ice_candidate'; candidate: Record<string, unknown> };

/** Server → client signaling (same JSON plane). */
export type RtcServerSignalingMessage =
	| { type: 'rtc.answer'; sdp: string }
	| { type: 'rtc.ice_candidate'; candidate: Record<string, unknown> }
	| { type: 'rtc.error'; message: string };

const RTC_CLIENT_TYPES = new Set(['rtc.offer', 'rtc.ice_candidate']);

/**
 * If `msg` is a recognized **client→server** RTC signaling frame, return a
 * typed value; otherwise `null`. Unknown `type` values are ignored so normal
 * client messages are unaffected. (`rtc.answer` is server→client and is no
 * longer accepted inbound — the directionality fix.)
 */
export function tryParseRtcClientSignaling(
	msg: Record<string, unknown>,
): RtcClientSignalingMessage | null {
	const t = msg.type;
	if (typeof t !== 'string' || !RTC_CLIENT_TYPES.has(t)) return null;

	if (t === 'rtc.ice_candidate') {
		const candidate = msg.candidate;
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
		return { type: 'rtc.ice_candidate', candidate: candidate as Record<string, unknown> };
	}

	const sdp = msg.sdp;
	if (typeof sdp !== 'string' || sdp.length === 0) return null;
	return { type: 'rtc.offer', sdp };
}
