import { describe, expect, it } from 'vitest';

describe('module smoke test', () => {
	it('imports without throwing', async () => {
		const mod = await import('./index.js');
		expect(mod).toBeDefined();
	});
});
