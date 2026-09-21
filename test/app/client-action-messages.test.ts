import { describe, expect, it } from 'vitest';
import { buildSessionReady } from '../../app/lib/client/client-action-messages.js';

describe('buildSessionReady', () => {
	it('includes default websocket transport fields when extras are omitted', () => {
		expect(buildSessionReady('u1', 's1', 'standard')).toEqual({
			type: 'session.ready',
			userId: 'u1',
			sessionId: 's1',
			agentProfile: 'standard',
			clientMedia: { kind: 'websocket' },
			clientSignalSource: 'websocket_json',
			clientAudioSource: 'websocket_pcm',
		});
	});

	it('includes derived transport fields for direct_rtc extras', () => {
		const clientMedia = {
			kind: 'direct_rtc' as const,
			iceServers: [{ urls: 'stun:example.com:19302' as const }],
			rtcAudio: 'werift_opus' as const,
		};
		expect(buildSessionReady('u1', 's1', 'standard', { clientMedia })).toEqual({
			type: 'session.ready',
			userId: 'u1',
			sessionId: 's1',
			agentProfile: 'standard',
			clientMedia,
			clientSignalSource: 'websocket_json',
			clientAudioSource: 'rtc_opus',
		});
	});
});
