// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	type AvatarClientConfig,
	resolvePresetThumbnail,
} from '../../app/web-client/src/spatial-web-avatar/use-spatial-web-avatar-host.js';

const cfg: AvatarClientConfig = {
	enabled: true,
	defaultProviderId: 'heygen',
	avatarProviders: [
		{
			id: 'heygen',
			label: 'HeyGen',
			kind: 'heygen_liveavatar',
			presets: [
				{
					id: 'preset-a',
					name: 'Wayne',
					imageUrl: 'https://example.com/wayne.webp',
				},
			],
		},
		{
			id: 'spatialreal',
			label: 'Spatial Real',
			kind: 'spatialreal',
			presets: [{ id: 'preset-b', name: 'Lucas' }],
		},
	],
};

describe('resolvePresetThumbnail', () => {
	it('returns imageUrl when catalog preset has one', () => {
		expect(resolvePresetThumbnail(cfg, 'heygen', 'preset-a')).toEqual({
			imageUrl: 'https://example.com/wayne.webp',
			name: 'Wayne',
		});
	});

	it('returns null imageUrl with name when preset has no thumbnail', () => {
		expect(resolvePresetThumbnail(cfg, 'spatialreal', 'preset-b')).toEqual({
			imageUrl: null,
			name: 'Lucas',
		});
	});

	it('returns nulls for unknown preset', () => {
		expect(resolvePresetThumbnail(cfg, 'heygen', 'missing')).toEqual({
			imageUrl: null,
			name: null,
		});
	});
});
