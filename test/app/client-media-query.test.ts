// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { parseClientMediaQuery } from '../../app/server/client-media-query.js';

describe('parseClientMediaQuery', () => {
	it('returns empty result when query omits clientMedia', () => {
		expect(parseClientMediaQuery(new URLSearchParams())).toEqual({});
	});

	it('parses websocket aliases', () => {
		expect(parseClientMediaQuery(new URLSearchParams('clientMedia=websocket'))).toEqual({
			profile: { kind: 'websocket' },
		});
		expect(parseClientMediaQuery(new URLSearchParams('clientMedia=pcm'))).toEqual({
			profile: { kind: 'websocket' },
		});
	});

	it('parses direct_rtc with default rtcAudio', () => {
		expect(parseClientMediaQuery(new URLSearchParams('clientMedia=direct_rtc'))).toEqual({
			profile: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
		});
	});

	it('parses direct_rtc with rtcAudio and rtcIceServer params', () => {
		const params = new URLSearchParams();
		params.set('clientMedia', 'direct_rtc');
		params.set('rtcAudio', 'none');
		params.append('rtcIceServer', 'stun:stun1.example.net:3478');
		params.append('rtcIceServer', 'turn:turn.example.net:3478');
		expect(parseClientMediaQuery(params)).toEqual({
			profile: {
				kind: 'direct_rtc',
				rtcAudio: 'none',
				iceServers: [
					{ urls: 'stun:stun1.example.net:3478' },
					{ urls: 'turn:turn.example.net:3478' },
				],
			},
		});
	});

	it('returns error for invalid clientMedia', () => {
		expect(parseClientMediaQuery(new URLSearchParams('clientMedia=livekit'))).toEqual({
			error: 'Invalid clientMedia="livekit". Expected websocket or direct_rtc.',
		});
	});

	it('returns error for invalid rtcAudio', () => {
		expect(
			parseClientMediaQuery(new URLSearchParams('clientMedia=direct_rtc&rtcAudio=aac')),
		).toEqual({
			error: 'Invalid rtcAudio="aac". Expected none or werift_opus.',
		});
	});
});
