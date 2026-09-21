import { describe, expect, it } from 'vitest';
import {
	type SutandoGetUser,
	type SutandoSupabaseUser,
	createSutandoOwnerAuthenticator,
} from '../../app/server/sutando/sutando-owner-auth.js';

const OWNER = 'owner@example.com';

function getUserReturning(user: SutandoSupabaseUser | null, errorMessage?: string): SutandoGetUser {
	return async () => ({
		user,
		error: errorMessage ? { message: errorMessage } : null,
	});
}

function ownerUser(overrides: Partial<SutandoSupabaseUser> = {}): SutandoSupabaseUser {
	return {
		id: 'user-owner-1',
		email: OWNER,
		email_confirmed_at: '2026-01-01T00:00:00Z',
		is_anonymous: false,
		...overrides,
	};
}

function auth(getUser: SutandoGetUser) {
	return createSutandoOwnerAuthenticator({ ownerEmail: OWNER, getUser });
}

describe('createSutandoOwnerAuthenticator', () => {
	it('accepts the confirmed owner — independent of any global auth method', async () => {
		// No AuthMiddleware, no AUTH_METHOD anywhere in sight: the verifier is
		// self-contained by construction, which is the design requirement that
		// the owner still authenticates under a global AUTH_METHOD=anonymous.
		const result = await auth(getUserReturning(ownerUser()))('valid-token');
		expect(result).toEqual({ ok: true, ownerUserId: 'user-owner-1', email: OWNER });
	});

	it('matches the owner email case-insensitively with whitespace trimmed', async () => {
		const result = await auth(getUserReturning(ownerUser({ email: '  Owner@Example.COM ' })))(
			'valid-token',
		);
		expect(result.ok).toBe(true);
	});

	it('rejects a missing token without calling the verifier', async () => {
		let called = false;
		const getUser: SutandoGetUser = async () => {
			called = true;
			return { user: ownerUser(), error: null };
		};
		expect(await auth(getUser)(undefined)).toEqual({ ok: false, reason: 'no_token' });
		expect(await auth(getUser)('   ')).toEqual({ ok: false, reason: 'no_token' });
		expect(called).toBe(false);
	});

	it('rejects a forged/invalid JWT (verifier error)', async () => {
		const result = await auth(getUserReturning(null, 'invalid JWT'))('forged-token');
		expect(result).toEqual({ ok: false, reason: 'invalid_token' });
	});

	it('rejects an expired token (verifier error with no user)', async () => {
		const result = await auth(getUserReturning(null, 'token is expired'))('expired-token');
		expect(result).toEqual({ ok: false, reason: 'invalid_token' });
	});

	it('rejects when the verifier itself throws (fail closed)', async () => {
		const getUser: SutandoGetUser = async () => {
			throw new Error('network down');
		};
		const result = await auth(getUser)('any-token');
		expect(result).toEqual({ ok: false, reason: 'invalid_token' });
	});

	it('rejects an anonymous Supabase user', async () => {
		const result = await auth(getUserReturning(ownerUser({ is_anonymous: true })))('token');
		expect(result).toEqual({ ok: false, reason: 'anonymous_user' });
	});

	it('rejects a user with no email', async () => {
		const result = await auth(getUserReturning(ownerUser({ email: null })))('token');
		expect(result).toEqual({ ok: false, reason: 'no_email' });
	});

	it('rejects an unconfirmed email', async () => {
		const result = await auth(getUserReturning(ownerUser({ email_confirmed_at: null })))('token');
		expect(result).toEqual({ ok: false, reason: 'unconfirmed_email' });
	});

	it('rejects a valid, confirmed non-owner account', async () => {
		const result = await auth(
			getUserReturning(ownerUser({ id: 'user-2', email: 'someone-else@example.com' })),
		)('token');
		expect(result).toEqual({ ok: false, reason: 'not_owner' });
	});
});
