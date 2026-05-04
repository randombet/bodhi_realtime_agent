// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildVoiceWebSocketUrl } from '../../app/web-client/src/voice-ws-url.js';

describe('buildVoiceWebSocketUrl', () => {
	it('appends userId and agentProfile', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://localhost:9900',
			clientUserId: 'u1',
			agentProfile: 'standard',
		});
		expect(u).toContain('userId=u1');
		expect(u).toContain('agentProfile=standard');
	});

	it('forceClientMedia direct_rtc adds rtcAudio', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h/ws',
			clientUserId: 'x',
			agentProfile: 'standard',
			forceClientMedia: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
		});
		expect(u).toContain('clientMedia=direct_rtc');
		expect(u).toContain('rtcAudio=werift_opus');
	});

	it('forceClientMedia websocket does not add rtcAudio', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			forceClientMedia: { kind: 'websocket' },
		});
		expect(u).toContain('clientMedia=websocket');
		expect(u).not.toContain('rtcAudio=');
	});

	it('prefers forceClientMedia over clientMediaOverrideKind', () => {
		const u = buildVoiceWebSocketUrl({
			baseUrl: 'ws://h',
			clientUserId: 'x',
			agentProfile: 'standard',
			clientMediaOverrideKind: 'websocket',
			forceClientMedia: { kind: 'direct_rtc', rtcAudio: 'none' },
		});
		expect(u).toContain('clientMedia=direct_rtc');
		expect(u).toContain('rtcAudio=none');
		expect(u).not.toMatch(/clientMedia=websocket/);
	});
});
