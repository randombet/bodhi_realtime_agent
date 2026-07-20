import type { IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { AuthMiddleware } from '../../app/server/auth/auth-middleware.js';

// JWT fail-closed contract (issues-client-protocol-audit.md §1): any
// verification failure — bad signature, forged/unsigned token, malformed
// input — must yield isAuthenticated: false. The historical bug: verify()
// errors fell back to an UNVERIFIED payload decode and returned
// isAuthenticated: true for any token carrying a sub/userId.

const SECRET = 'test-secret';

function req(authHeader?: string): IncomingMessage {
	return {
		headers: {
			host: 'localhost:9900',
			...(authHeader ? { authorization: authHeader } : {}),
		},
		url: '/ws',
	} as unknown as IncomingMessage;
}

function jwtMiddleware(): AuthMiddleware {
	return new AuthMiddleware({ enabled: true, method: 'jwt', jwtSecret: SECRET });
}

describe('AuthMiddleware — JWT fail-closed', () => {
	it('authenticates a correctly signed token (happy path)', async () => {
		const token = jwt.sign({ sub: 'user-1' }, SECRET);
		const result = await jwtMiddleware().authenticate(req(`Bearer ${token}`));
		expect(result.isAuthenticated).toBe(true);
		expect(result.userId).toBe('user-1');
		expect(result.authMethod).toBe('jwt');
	});

	it('REJECTS a token signed with the wrong secret', async () => {
		const forged = jwt.sign({ sub: 'attacker' }, 'wrong-secret');
		const result = await jwtMiddleware().authenticate(req(`Bearer ${forged}`));
		expect(result.isAuthenticated).toBe(false);
		expect(result.userId).not.toBe('attacker');
	});

	it('REJECTS an unsigned/garbage-signature token carrying a sub claim', async () => {
		const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
		const payload = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
		const forged = `${header}.${payload}.not-a-real-signature`;
		const result = await jwtMiddleware().authenticate(req(`Bearer ${forged}`));
		expect(result.isAuthenticated).toBe(false);
		expect(result.userId).not.toBe('attacker');
	});

	it('rejects a structurally malformed token', async () => {
		const result = await jwtMiddleware().authenticate(req('Bearer not-a-jwt'));
		expect(result.isAuthenticated).toBe(false);
	});

	it('rejects a missing Bearer header', async () => {
		const result = await jwtMiddleware().authenticate(req());
		expect(result.isAuthenticated).toBe(false);
	});

	it('rejects a valid-format token whose payload lacks sub/userId', async () => {
		const token = jwt.sign({ role: 'nobody' }, SECRET);
		const result = await jwtMiddleware().authenticate(req(`Bearer ${token}`));
		expect(result.isAuthenticated).toBe(false);
	});
});

describe('AuthMiddleware — other modes unchanged', () => {
	it('anonymous mode (disabled) returns an unauthenticated anonymous user', async () => {
		const mw = new AuthMiddleware({ enabled: false, method: 'anonymous' });
		const result = await mw.authenticate(req());
		expect(result.isAuthenticated).toBe(false);
		expect(result.userId).toBeTruthy();
	});

	it('api_key mode still authenticates the configured key and rejects others', async () => {
		const mw = new AuthMiddleware({ enabled: true, method: 'api_key', apiKey: 'k1' });
		const ok = await mw.authenticate(req('Bearer k1'));
		expect(ok.isAuthenticated).toBe(true);
		const bad = await mw.authenticate(req('Bearer nope'));
		expect(bad.isAuthenticated).toBe(false);
	});
});
