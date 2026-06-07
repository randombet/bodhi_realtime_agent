// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ANAM_BYO_LLM_ID,
	buildAnamPersonaConfig,
	createAnamSessionToken,
	loadAnamServerConfigFromEnv,
} from '../app/lib/anam/anam-live-avatar-config.js';

describe('anam live avatar config', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('loadAnamServerConfigFromEnv fails without API key', () => {
		vi.stubEnv('ANAM_API_KEY', '');
		expect(loadAnamServerConfigFromEnv()).toEqual({ ok: false });
	});

	it('buildAnamPersonaConfig defaults to CUSTOMER_CLIENT_V1', () => {
		vi.stubEnv('ANAM_API_KEY', 'test-key');
		const loaded = loadAnamServerConfigFromEnv();
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		const persona = buildAnamPersonaConfig(loaded.value, 'avatar-uuid');
		expect(persona.avatarId).toBe('avatar-uuid');
		expect(persona.llmId).toBe(ANAM_BYO_LLM_ID);
	});

	it('createAnamSessionToken posts personaConfig', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ sessionToken: 'tok-1' }),
		});
		vi.stubGlobal('fetch', fetchMock);

		const token = await createAnamSessionToken(
			{
				apiKey: 'test-key',
				apiBaseUrl: 'https://api.anam.test',
				defaultVoiceId: 'voice-1',
				defaultLlmId: ANAM_BYO_LLM_ID,
				personaName: 'Test',
				systemPrompt: 'Be helpful.',
			},
			'avatar-uuid',
		);

		expect(token).toBe('tok-1');
		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.anam.test/v1/auth/session-token',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer test-key',
				}),
				body: JSON.stringify({
					personaConfig: {
						name: 'Test',
						avatarId: 'avatar-uuid',
						voiceId: 'voice-1',
						llmId: ANAM_BYO_LLM_ID,
						systemPrompt: 'Be helpful.',
					},
				}),
			}),
		);
	});
});
