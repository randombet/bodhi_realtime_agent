// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { tryParseRtcClientSignaling } from '../../src/types/rtc-signaling.js';

describe('tryParseRtcClientSignaling', () => {
	it('returns null for unrelated messages', () => {
		expect(tryParseRtcClientSignaling({ type: 'text_input', text: 'hi' })).toBeNull();
		expect(tryParseRtcClientSignaling({})).toBeNull();
	});

	it('parses rtc.offer', () => {
		expect(tryParseRtcClientSignaling({ type: 'rtc.offer', sdp: 'v=0\r\n' })).toEqual({
			type: 'rtc.offer',
			sdp: 'v=0\r\n',
		});
	});

	it('parses rtc.answer', () => {
		expect(tryParseRtcClientSignaling({ type: 'rtc.answer', sdp: 'v=0\r\n' })).toEqual({
			type: 'rtc.answer',
			sdp: 'v=0\r\n',
		});
	});

	it('parses rtc.ice_candidate', () => {
		const candidate = { candidate: 'c', sdpMid: '0' };
		expect(tryParseRtcClientSignaling({ type: 'rtc.ice_candidate', candidate })).toEqual({
			type: 'rtc.ice_candidate',
			candidate,
		});
	});

	it('rejects rtc.ice_candidate without object candidate', () => {
		expect(tryParseRtcClientSignaling({ type: 'rtc.ice_candidate', candidate: 'x' })).toBeNull();
	});

	it('rejects offer without sdp', () => {
		expect(tryParseRtcClientSignaling({ type: 'rtc.offer' })).toBeNull();
	});
});
