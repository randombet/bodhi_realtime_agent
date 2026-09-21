import { describe, expect, it } from 'vitest';
import { parseIntegrationApiKeyToken } from '../../app/server/stores/integration-api-key-repository.js';

describe('integration-api-key-repository', () => {
	it('parseIntegrationApiKeyToken accepts valid bsk_<uuid>_<suffix>', () => {
		const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
		const suffix = 'x'.repeat(16);
		const token = `bsk_${id}_${suffix}`;
		expect(parseIntegrationApiKeyToken(token)).toEqual({ id, secretSuffix: suffix });
	});

	it('parseIntegrationApiKeyToken accepts uppercase hex uuid in token', () => {
		const idUpper = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
		const suffix = 'y'.repeat(20);
		const parsed = parseIntegrationApiKeyToken(`bsk_${idUpper}_${suffix}`);
		expect(parsed).not.toBeNull();
		expect(parsed?.secretSuffix).toBe(suffix);
		expect(parsed?.id?.toLowerCase()).toBe(idUpper.toLowerCase());
	});

	it('parseIntegrationApiKeyToken rejects short secret suffix', () => {
		const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
		expect(parseIntegrationApiKeyToken(`bsk_${id}_short`)).toBeNull();
	});

	it('parseIntegrationApiKeyToken rejects wrong prefix or malformed uuid', () => {
		expect(parseIntegrationApiKeyToken('sk_live_abc')).toBeNull();
		expect(parseIntegrationApiKeyToken('bsk_not-a-uuid_suffixsuffixsuffixsuffix')).toBeNull();
	});
});
