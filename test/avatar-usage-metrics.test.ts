// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	AVATAR_USAGE_METRICS,
	buildAvatarSessionUsageMetadata,
	normalizeAvatarSessionDurationMs,
} from '../app/lib/avatars/avatar-usage-metrics.js';

describe('avatar usage metrics', () => {
	it('normalizes positive duration', () => {
		expect(normalizeAvatarSessionDurationMs(12_345.6)).toBe(12346);
	});

	it('rejects invalid duration', () => {
		expect(normalizeAvatarSessionDurationMs(0)).toBeNull();
		expect(normalizeAvatarSessionDurationMs(-1)).toBeNull();
		expect(normalizeAvatarSessionDurationMs(Number.NaN)).toBeNull();
	});

	it('builds metadata for usage rows', () => {
		expect(
			buildAvatarSessionUsageMetadata({
				providerId: 'heygen',
				presetId: 'avatar-a',
				durationMs: 1000,
				avatarKind: 'heygen_liveavatar',
				livePreview: true,
				voiceSessionId: 'sess-1',
			}),
		).toEqual({
			avatarProviderId: 'heygen',
			avatarPresetId: 'avatar-a',
			avatarKind: 'heygen_liveavatar',
			livePreview: true,
			voiceSessionId: 'sess-1',
		});
	});

	it('exports stable metric names', () => {
		expect(AVATAR_USAGE_METRICS.sessionMs).toBe('avatar_session_ms');
		expect(AVATAR_USAGE_METRICS.sessionToken).toBe('avatar_session_token');
	});
});
