// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
	decryptUserLlmSecret,
	encryptUserLlmSecret,
} from '../../app/server/crypto/user-llm-key-crypto.js';

describe('user-llm-key-crypto', () => {
	const secret = 'test-secret-at-least-16-chars';

	it('round-trips UTF-8 secrets', () => {
		const plain = 'AIza_test_key_material';
		const enc = encryptUserLlmSecret(plain, secret);
		expect(enc).not.toContain(plain);
		expect(decryptUserLlmSecret(enc, secret)).toBe(plain);
	});

	it('produces different ciphertext for same plain (random IV)', () => {
		const plain = 'sk-same';
		const a = encryptUserLlmSecret(plain, secret);
		const b = encryptUserLlmSecret(plain, secret);
		expect(a).not.toBe(b);
		expect(decryptUserLlmSecret(a, secret)).toBe(plain);
		expect(decryptUserLlmSecret(b, secret)).toBe(plain);
	});
});
