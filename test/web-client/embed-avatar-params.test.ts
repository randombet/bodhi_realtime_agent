// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { parseEmbedParams } from '../../app/web-client/src/pages/EmbedAvatarPage.js';

describe('parseEmbedParams', () => {
	it('uses avatarPresetId as the canonical provider-neutral preset field', () => {
		const params = parseEmbedParams(
			'?embedSessionIntentId=emb_1&embedToken=t&agentProfile=ua_1&embedMode=voice_avatar&avatarProviderId=heygen_liveavatar&avatarPresetId=avatar-a',
		);

		expect(params).toMatchObject({
			avatarProviderId: 'heygen_liveavatar',
			avatarPresetId: 'avatar-a',
			spatialAvatarId: '',
			embedMode: 'voice_avatar',
		});
	});

	it('keeps spatialAvatarId as a legacy alias for Spatial embeds', () => {
		const params = parseEmbedParams(
			'?embedSessionIntentId=emb_1&embedToken=t&agentProfile=ua_1&avatarProviderId=spatialreal&spatialAvatarId=spatial-a',
		);

		expect(params).toMatchObject({
			avatarProviderId: 'spatialreal',
			avatarPresetId: 'spatial-a',
			spatialAvatarId: 'spatial-a',
			embedMode: 'voice_avatar',
		});
	});
});
