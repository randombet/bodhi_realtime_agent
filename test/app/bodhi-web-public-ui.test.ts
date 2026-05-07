// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBodhiAvatarStudioNavEnabled } from '../../app/lib/bodhi-web-public-ui.js';

describe('isBodhiAvatarStudioNavEnabled', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('is false when unset', () => {
		vi.stubEnv('BODHI_AVATAR_STUDIO_NAV_ENABLED', '');
		expect(isBodhiAvatarStudioNavEnabled()).toBe(false);
	});

	it.each(['1', 'true', 'yes', 'TRUE', ' Yes '])('is true for %j', (v) => {
		vi.stubEnv('BODHI_AVATAR_STUDIO_NAV_ENABLED', v);
		expect(isBodhiAvatarStudioNavEnabled()).toBe(true);
	});

	it('is false for other strings', () => {
		vi.stubEnv('BODHI_AVATAR_STUDIO_NAV_ENABLED', 'maybe');
		expect(isBodhiAvatarStudioNavEnabled()).toBe(false);
	});
});
