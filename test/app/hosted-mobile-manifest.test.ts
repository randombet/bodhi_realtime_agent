import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	HOSTED_CLIENT_FIELDS,
	HOSTED_MOBILE_CLIENT_TYPES,
	HOSTED_MOBILE_SERVER_TYPES,
	HOSTED_SERVER_FIELDS,
	type HostedMobileClientMessage,
	type HostedMobileServerMessage,
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
		for (const [type, fields] of Object.entries(HOSTED_SERVER_FIELDS)) {
			expect(doc.get(type)?.sort(), `fields for ${type}`).toEqual([...fields].sort());
		}
	});

	it('doc client manifest matches the typed profile (fields)', () => {
		const doc = parseManifest('client');
		for (const [type, fields] of Object.entries(HOSTED_CLIENT_FIELDS)) {
			expect(doc.get(type)?.sort(), `fields for ${type}`).toEqual([...fields].sort());
		}
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
