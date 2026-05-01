// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBodhiAvatarFeatureEnvEnabled } from '../../app/lib/bodhi-avatar-feature.js';

describe('bodhi-avatar-feature', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('isBodhiAvatarFeatureEnvEnabled is false when empty', () => {
		vi.stubEnv('BODHI_AVATAR_ENABLED', '');
		expect(isBodhiAvatarFeatureEnvEnabled()).toBe(false);
	});

	it.each(['true', 'TRUE', '1', 'yes'])('treats %s as enabled', (v) => {
		vi.stubEnv('BODHI_AVATAR_ENABLED', v);
		expect(isBodhiAvatarFeatureEnvEnabled()).toBe(true);
	});

	it('treats arbitrary string as disabled', () => {
		vi.stubEnv('BODHI_AVATAR_ENABLED', 'maybe');
		expect(isBodhiAvatarFeatureEnvEnabled()).toBe(false);
	});
});
