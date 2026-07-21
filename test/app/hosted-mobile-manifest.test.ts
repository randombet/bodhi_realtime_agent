import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sendAtClientMessageBoundary } from '../../app/lib/client/client-message-boundary.js';
import {
	HOSTED_CLIENT_SHAPES,
	HOSTED_MOBILE_CLIENT_TYPES,
	HOSTED_MOBILE_SERVER_TYPES,
	HOSTED_SERVER_SHAPES,
	type HostedMobileClientMessage,
	type HostedMobileServerMessage,
	isExcludedHostedMobileClientMessage,
	isHostedMobileClientMessage,
	isHostedMobileServerMessage,
	renderHostedMobileShapeManifest,
} from '../../app/lib/client/hosted-mobile-profile.js';

// Doc-drift guard for the hosted mobile API (plan step A7): §4.3 of
// docs/service/hosted-voice-api.md embeds machine-readable manifest blocks;
// this test diffs them against the typed profile. A hosted-profile change
// without a doc update (or vice versa) fails here.

const DOC = readFileSync(
	join(__dirname, '..', '..', 'docs', 'service', 'hosted-voice-api.md'),
	'utf8',
);

function parseManifest(kind: 'server' | 'client'): Map<string, string[]> {
	const m = DOC.match(new RegExp(`<!-- hosted-mobile-manifest:${kind}\\n([\\s\\S]*?)-->`));
	if (!m) throw new Error(`manifest block '${kind}' not found in hosted-voice-api.md §4.3`);
	const rows = new Map<string, string[]>();
	for (const line of m[1].trim().split('\n')) {
		const [type, fields] = line.trim().split(/\s+/);
		rows.set(type, fields.split(','));
	}
	return rows;
}

describe('hosted mobile §4 ↔ profile drift guard', () => {
	it('doc server manifest matches the typed profile (names)', () => {
		const doc = parseManifest('server');
		expect([...doc.keys()].sort()).toEqual([...HOSTED_MOBILE_SERVER_TYPES].sort());
	});

	it('doc client manifest matches the typed profile (names)', () => {
		const doc = parseManifest('client');
		expect([...doc.keys()].sort()).toEqual([...HOSTED_MOBILE_CLIENT_TYPES].sort());
	});

	it('doc server manifest matches the typed profile (fields)', () => {
		const doc = parseManifest('server');
		const expected = renderHostedMobileShapeManifest(HOSTED_SERVER_SHAPES);
		for (const [type, fields] of expected) {
			expect(doc.get(type), `shape for ${type}`).toEqual(fields);
		}
	});

	it('doc client manifest matches the typed profile (fields)', () => {
		const doc = parseManifest('client');
		const expected = renderHostedMobileShapeManifest(HOSTED_CLIENT_SHAPES);
		for (const [type, fields] of expected) {
			expect(doc.get(type), `shape for ${type}`).toEqual(fields);
		}
	});

	it('runtime guards bind real app-owned frames to the mobile boundary', () => {
		expect(
			isHostedMobileServerMessage({
				type: 'session.notice',
				code: 'session_time_limit_warning',
				message: 'This session will end in 1 minute.',
			}),
		).toBe(true);
		expect(isHostedMobileServerMessage({ type: 'sessions_list', sessions: [] })).toBe(true);
		expect(isHostedMobileServerMessage({ type: 'session_end', reason: 'user_goodbye' })).toBe(true);
		expect(isHostedMobileServerMessage({ type: 'rtc.answer', sdp: 'no-mobile-rtc' })).toBe(false);
		expect(
			isHostedMobileServerMessage({
				type: 'session.config',
				audioFormat: {
					inputSampleRate: 24000,
					outputSampleRate: 24000,
					channels: 1,
					bitDepth: 16,
					encoding: 'pcm',
				},
				clientMedia: { kind: 'direct_rtc' },
				clientSignalSource: 'websocket_json',
				clientAudioSource: 'rtc_opus',
			}),
		).toBe(false);
		expect(
			isHostedMobileServerMessage({
				type: 'session.config',
				audioFormat: {
					inputSampleRate: 16000,
					outputSampleRate: 24000,
					channels: 1,
					bitDepth: 16,
					encoding: 'pcm',
				},
				clientMedia: { kind: 'websocket' },
				clientSignalSource: 'websocket_json',
				clientAudioSource: 'websocket_pcm',
			}),
		).toBe(true);
		expect(
			isHostedMobileServerMessage({
				type: 'session.config',
				audioFormat: {
					inputSampleRate: 8000,
					outputSampleRate: 8000,
					channels: 1,
					bitDepth: 8,
					encoding: 'pcmu',
				},
				clientMedia: { kind: 'websocket' },
				clientSignalSource: 'websocket_json',
				clientAudioSource: 'websocket_pcm',
			}),
		).toBe(false);

		expect(isHostedMobileClientMessage({ type: 'list_sessions' })).toBe(true);
		expect(isHostedMobileClientMessage({ type: 'mobile.device_event' })).toBe(false);
		expect(isExcludedHostedMobileClientMessage({ type: 'rtc.offer', sdp: 'excluded' })).toBe(true);
		expect(isExcludedHostedMobileClientMessage({ type: 'future.extension' })).toBe(false);
	});

	it('the mobile send boundary rejects excluded frames and session_end closes every socket', () => {
		const sent: string[] = [];
		const closed: Array<[number, string]> = [];
		const ended: string[] = [];
		const boundary = {
			hostedMobile: true,
			send: (message: { type: string }) => sent.push(message.type),
			close: (code: number, reason: string) => closed.push([code, reason]),
			endSession: (reason: string) => ended.push(reason),
		};

		expect(sendAtClientMessageBoundary(boundary, { type: 'rtc.answer', sdp: 'excluded' })).toBe(
			'rejected',
		);
		expect(sent).toEqual([]);
		expect(closed).toEqual([[1011, 'hosted_mobile_protocol_violation']]);

		closed.length = 0;
		expect(
			sendAtClientMessageBoundary(boundary, {
				type: 'session_end',
				reason: 'user_goodbye',
			}),
		).toBe('sent_and_closed');
		expect(sent).toEqual(['session_end']);
		expect(closed).toEqual([]);
		expect(ended).toEqual(['user_goodbye']);
	});

	it("§4.4's JSON examples compile against the profile members", () => {
		// Mirrors the fenced examples in §4.4 — if the doc's examples change
		// shape, update these typed fixtures in the same PR (and vice versa).
		const audioDone: HostedMobileServerMessage = { type: 'audio.done', playbackId: 7 };
		const playbackEnded: HostedMobileClientMessage = { type: 'playback.ended', playbackId: 7 };
		expect(DOC).toContain('{ "type": "audio.done", "playbackId": 7 }');
		expect(DOC).toContain('{ "type": "playback.ended", "playbackId": 7 }');
		expect(audioDone.playbackId).toBe(playbackEnded.playbackId);
	});
});
