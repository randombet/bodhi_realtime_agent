// SPDX-License-Identifier: MIT

/**
 * WebRTC signaling messages exchanged over the existing WebSocket JSON plane
 * (`sendJsonToClient` / `feedJsonFromClient`) while audio uses a direct RTC path.
 */

/** Client → server signaling (carried as JSON `type` on the control WebSocket). */
export type RtcClientSignalingMessage =
	| { type: 'rtc.offer'; sdp: string }
	| { type: 'rtc.answer'; sdp: string }
	| { type: 'rtc.ice_candidate'; candidate: Record<string, unknown> };

/** Server → client signaling (same JSON plane). */
export type RtcServerSignalingMessage =
	| { type: 'rtc.answer'; sdp: string }
	| { type: 'rtc.ice_candidate'; candidate: Record<string, unknown> };

const RTC_TYPES = new Set(['rtc.offer', 'rtc.answer', 'rtc.ice_candidate']);

/**
 * If `msg` is a recognized RTC signaling frame, return a typed value; otherwise `null`.
 * Unknown `type` values are ignored so normal client messages are unaffected.
 */
export function tryParseRtcClientSignaling(
	msg: Record<string, unknown>,
): RtcClientSignalingMessage | null {
	const t = msg.type;
	if (typeof t !== 'string' || !RTC_TYPES.has(t)) return null;

	if (t === 'rtc.ice_candidate') {
		const candidate = msg.candidate;
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
		return { type: 'rtc.ice_candidate', candidate: candidate as Record<string, unknown> };
	}

	const sdp = msg.sdp;
	if (typeof sdp !== 'string' || sdp.length === 0) return null;
	if (t === 'rtc.offer') return { type: 'rtc.offer', sdp };
	return { type: 'rtc.answer', sdp };
}
