// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
	getSpatialRealPresetIdSet,
	loadAvatarCatalog,
	resolveSpatialRealSessionAvatarId,
} from '../app/lib/avatars/index.js';

describe('resolveSpatialRealSessionAvatarId', () => {
	const envDefault = 'c067bb81-93cc-4a39-9622-9fb1c593cda6';

	it('uses env default when query empty', () => {
		const r = resolveSpatialRealSessionAvatarId('', envDefault);
		expect(r).toEqual({ ok: true, avatarId: envDefault });
	});

	it('accepts a curated preset id', () => {
		const mia = 'ca9c5c22-6dba-4b59-ae3b-d26066f8c017';
		const r = resolveSpatialRealSessionAvatarId(mia, envDefault);
		expect(r).toEqual({ ok: true, avatarId: mia });
	});

	it('accepts a custom env default not in the preset list', () => {
		const custom = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		const r = resolveSpatialRealSessionAvatarId('', custom);
		expect(r).toEqual({ ok: true, avatarId: custom });
	});

	it('rejects unknown ids', () => {
		const r = resolveSpatialRealSessionAvatarId('00000000-0000-0000-0000-000000000000', envDefault);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.code).toBe('invalid_spatial_avatar_id');
		}
	});

	it('catalog has 13 Spatial Real presets', () => {
		const cat = loadAvatarCatalog();
		const spatial = cat.providers.find((p) => p.kind === 'spatialreal');
		expect(spatial?.presets.length).toBe(13);
		expect(getSpatialRealPresetIdSet().size).toBe(13);
	});
});
