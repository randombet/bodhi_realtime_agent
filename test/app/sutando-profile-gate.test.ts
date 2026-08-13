import { describe, expect, it } from 'vitest';
import {
	SutandoProfileGateError,
	assertSutandoProfileAllowed,
	isRegisteredSutandoAuthorization,
	validateNoSutandoTwilioPins,
} from '../../app/server/sutando/sutando-profile-gate.js';

describe('assertSutandoProfileAllowed', () => {
	it('authorizes the web WS surface with a ticket grant', () => {
		const authz = assertSutandoProfileAllowed('web_ws', { ownerUserId: 'owner-1' });
		expect(authz).toMatchObject({ ownerUserId: 'owner-1', profile: 'sutando', surface: 'web_ws' });
		expect(isRegisteredSutandoAuthorization(authz)).toBe(true);
	});

	it.each(['mobile_api', 'embed', 'twilio_outbound', 'twilio_inbound'] as const)(
		'rejects the %s surface outright, even with a grant',
		(surface) => {
			expect(() => assertSutandoProfileAllowed(surface, { ownerUserId: 'owner-1' })).toThrow(
				SutandoProfileGateError,
			);
			try {
				assertSutandoProfileAllowed(surface, { ownerUserId: 'owner-1' });
			} catch (e) {
				expect((e as SutandoProfileGateError).code).toBe('surface_not_allowed');
			}
		},
	);

	it('rejects web_ws without a grant (and with an empty owner id)', () => {
		expect(() => assertSutandoProfileAllowed('web_ws', null)).toThrow(SutandoProfileGateError);
		expect(() => assertSutandoProfileAllowed('web_ws', { ownerUserId: '  ' })).toThrow(
			SutandoProfileGateError,
		);
	});

	it('a structurally identical object is NOT a registered authorization', () => {
		const real = assertSutandoProfileAllowed('web_ws', { ownerUserId: 'owner-1' });
		const forged = { ...real }; // structural clone / `as any` cast equivalent
		expect(isRegisteredSutandoAuthorization(forged)).toBe(false);
		const handRolled = { ownerUserId: 'owner-1', profile: 'sutando', surface: 'web_ws' };
		expect(isRegisteredSutandoAuthorization(handRolled)).toBe(false);
		expect(isRegisteredSutandoAuthorization(null)).toBe(false);
		expect(isRegisteredSutandoAuthorization('sutando')).toBe(false);
	});

	it('issued authorizations are frozen (cannot be repointed at another owner)', () => {
		const authz = assertSutandoProfileAllowed('web_ws', { ownerUserId: 'owner-1' });
		expect(() => {
			(authz as { ownerUserId: string }).ownerUserId = 'attacker';
		}).toThrow();
		expect(authz.ownerUserId).toBe('owner-1');
	});
});

describe('validateNoSutandoTwilioPins', () => {
	it('accepts configs without sutando pins (and disabled inbound)', () => {
		expect(() => validateNoSutandoTwilioPins(undefined)).not.toThrow();
		expect(() => validateNoSutandoTwilioPins({ inboundEnabled: false })).not.toThrow();
		expect(() =>
			validateNoSutandoTwilioPins({
				inboundEnabled: true,
				defaultAgentProfile: 'standard',
				numberAgentProfiles: { '+16505550111': 'structured_screening' },
			}),
		).not.toThrow();
	});

	it('refuses to boot with sutando as the default inbound profile', () => {
		expect(() =>
			validateNoSutandoTwilioPins({ inboundEnabled: true, defaultAgentProfile: 'sutando' }),
		).toThrow(/no phone surface/);
	});

	it('refuses to boot with a sutando number pin', () => {
		expect(() =>
			validateNoSutandoTwilioPins({
				inboundEnabled: true,
				defaultAgentProfile: 'standard',
				numberAgentProfiles: { '+16505550222': 'sutando' },
			}),
		).toThrow(/\+16505550222.*no phone surface/s);
	});
});
