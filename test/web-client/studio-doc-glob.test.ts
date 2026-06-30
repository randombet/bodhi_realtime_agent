import { describe, expect, it } from 'vitest';
import { studioDocKeyFromGlobPath } from '../../app/web-client/src/lib/studio-doc-glob.js';

describe('studioDocKeyFromGlobPath', () => {
	it('maps Vite-relative app/docs paths (../docs/ from web-client)', () => {
		expect(studioDocKeyFromGlobPath('../../../docs/client-voice-transport.md')).toBe(
			'/studio/client-voice-transport',
		);
	});

	it('maps paths that still contain app/docs segment', () => {
		expect(studioDocKeyFromGlobPath('/repo/app/docs/client-voice-transport.md')).toBe(
			'/studio/client-voice-transport',
		);
	});

	it('does not treat main published guide paths under docs/ as studio', () => {
		expect(studioDocKeyFromGlobPath('../../../../docs/guide/voice-session.md')).toBeUndefined();
		expect(studioDocKeyFromGlobPath('foo/docs/service/hosted-voice-api.md')).toBeUndefined();
	});
});
