import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildSpatialrealPublicClientConfig,
	loadAvatarCatalog,
	resetAvatarCatalogCacheForTests,
	resolveAvatarRuntimeSelection,
} from '../app/lib/avatars/index.js';
import {
	createHeyGenStreamingToken,
	loadHeyGenServerConfigFromEnv,
} from '../app/lib/heygen/heygen-live-avatar-config.js';

function withCatalog(catalog: unknown): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'bodhi-avatar-catalog-'));
	const file = path.join(dir, 'avatar-catalog.json');
	writeFileSync(file, JSON.stringify(catalog), 'utf8');
	vi.stubEnv('BODHI_AVATAR_CATALOG_PATH', file);
	resetAvatarCatalogCacheForTests();
	return file;
}

describe('avatar provider runtime boundary', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		resetAvatarCatalogCacheForTests();
	});

	it('loads non-UUID provider preset ids for non-Spatial vendors', () => {
		withCatalog({
			version: 1,
			defaultProviderId: 'heygen_liveavatar',
			providers: [
				{
					id: 'heygen_liveavatar',
					label: 'HeyGen LiveAvatar',
					kind: 'heygen_liveavatar',
					presets: [{ id: 'heygen-avatar-001', name: 'HeyGen Avatar' }],
				},
			],
		});

		const catalog = loadAvatarCatalog();
		expect(catalog.providers[0]?.presets[0]?.id).toBe('heygen-avatar-001');
	});

	it('resolves configured HeyGen presets but rejects WebSocket driving until a client adapter exists', () => {
		vi.stubEnv('HEYGEN_LIVEAVATAR_API_KEY', 'heygen-key');
		withCatalog({
			version: 1,
			defaultProviderId: 'heygen_liveavatar',
			providers: [
				{
					id: 'heygen_liveavatar',
					label: 'HeyGen LiveAvatar',
					kind: 'heygen_liveavatar',
					presets: [{ id: 'avatar-a', name: 'Avatar A' }],
				},
			],
		});

		const tokenRuntime = resolveAvatarRuntimeSelection({
			providerId: 'heygen_liveavatar',
			presetId: 'avatar-a',
		});
		expect(tokenRuntime).toMatchObject({
			ok: true,
			value: { providerId: 'heygen_liveavatar', presetId: 'avatar-a' },
		});

		const drivingRuntime = resolveAvatarRuntimeSelection({
			providerId: 'heygen_liveavatar',
			presetId: 'avatar-a',
			requireWebSocketDriving: true,
		});
		expect(drivingRuntime).toMatchObject({
			ok: false,
			code: 'unsupported_avatar_provider',
		});
	});

	it('requires a configured provider before issuing runtime sessions', () => {
		withCatalog({
			version: 1,
			defaultProviderId: 'heygen_liveavatar',
			providers: [
				{
					id: 'heygen_liveavatar',
					label: 'HeyGen LiveAvatar',
					kind: 'heygen_liveavatar',
					presets: [{ id: 'avatar-a', name: 'Avatar A' }],
				},
			],
		});

		const runtime = resolveAvatarRuntimeSelection({
			providerId: 'heygen_liveavatar',
			presetId: 'avatar-a',
		});
		expect(runtime).toMatchObject({
			ok: false,
			code: 'avatar_provider_not_configured',
		});
	});

	it('resolves empty HeyGen preset id to default (token-only flow)', () => {
		vi.stubEnv('HEYGEN_LIVEAVATAR_API_KEY', 'heygen-key');
		withCatalog({
			version: 1,
			defaultProviderId: 'heygen_liveavatar',
			providers: [
				{
					id: 'heygen_liveavatar',
					label: 'HeyGen LiveAvatar',
					kind: 'heygen_liveavatar',
					presets: [{ id: 'avatar-a', name: 'Avatar A' }],
				},
			],
		});

		const runtime = resolveAvatarRuntimeSelection({
			providerId: 'heygen_liveavatar',
			presetId: '',
		});
		expect(runtime).toMatchObject({
			ok: true,
			value: { providerId: 'heygen_liveavatar', presetId: 'default' },
		});
	});

	it('rejects HeyGen preset ids that are not in the catalog', () => {
		vi.stubEnv('HEYGEN_LIVEAVATAR_API_KEY', 'heygen-key');
		withCatalog({
			version: 1,
			defaultProviderId: 'heygen_liveavatar',
			providers: [
				{
					id: 'heygen_liveavatar',
					label: 'HeyGen LiveAvatar',
					kind: 'heygen_liveavatar',
					presets: [{ id: 'avatar-a', name: 'Avatar A' }],
				},
			],
		});

		const runtime = resolveAvatarRuntimeSelection({
			providerId: 'heygen_liveavatar',
			presetId: 'avatar-b',
		});
		expect(runtime).toMatchObject({
			ok: false,
			code: 'invalid_avatar_id',
		});
	});
});

describe('HeyGen server API helpers', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('loads HeyGen config from supported environment variable names', () => {
		vi.stubEnv('HEYGEN_API_KEY', 'heygen-key');
		vi.stubEnv('HEYGEN_API_BASE_URL', 'https://example.test/');

		expect(loadHeyGenServerConfigFromEnv()).toEqual({
			ok: true,
			value: { apiKey: 'heygen-key', apiBaseUrl: 'https://example.test' },
		});
	});

	it('mints a HeyGen session token with X-API-KEY auth and avatar_id body', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: { session_token: 'session-token-1' } }),
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			createHeyGenStreamingToken(
				{ apiKey: 'heygen-key', apiBaseUrl: 'https://example.test' },
				'Wayne_20240711',
			),
		).resolves.toBe('session-token-1');
		expect(fetchMock).toHaveBeenCalledWith(
			'https://example.test/v1/sessions/token',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ 'X-API-KEY': 'heygen-key' }),
				body: JSON.stringify({ mode: 'LITE', avatar_id: 'Wayne_20240711' }),
			}),
		);
	});

	it('resolves configured Anam presets for token minting', () => {
		vi.stubEnv('ANAM_API_KEY', 'anam-key');
		withCatalog({
			version: 1,
			defaultProviderId: 'anam',
			providers: [
				{
					id: 'anam',
					label: 'Anam',
					kind: 'anam',
					presets: [{ id: '30fa96d0-26c4-4e55-94a0-517025942e18', name: 'Cara' }],
				},
			],
		});

		const selection = resolveAvatarRuntimeSelection({
			providerId: 'anam',
			presetId: '30fa96d0-26c4-4e55-94a0-517025942e18',
		});
		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.value.provider.kind).toBe('anam');
		expect(selection.value.runtime.supportsWebSocketDriving).toBe(false);
		expect(selection.value.runtime.supportsClientSessionToken).toBe(true);
	});

	it('passes optional preset imageUrl through client config', () => {
		withCatalog({
			version: 1,
			defaultProviderId: 'heygen',
			providers: [
				{
					id: 'heygen',
					label: 'HeyGen',
					kind: 'heygen_liveavatar',
					presets: [
						{
							id: 'avatar-a',
							name: 'Wayne',
							imageUrl: 'https://example.com/wayne.webp',
						},
					],
				},
			],
		});

		const clientConfig = buildSpatialrealPublicClientConfig({
			appId: 'app-1',
			avatarId: 'avatar-a',
			region: 'us-west',
			env: 'intl',
		});
		const heygen = clientConfig.avatarProviders?.find((p) => p.id === 'heygen');
		expect(heygen?.presets[0]?.imageUrl).toBe('https://example.com/wayne.webp');
	});
});
