import { describe, expect, it } from 'vitest';
import {
	buildRecruitingOutboundPreflight,
	recruitingPreflightBlocksDialOut,
} from '../../app/web-client/src/recruiting/recruiting-studio-preflight.js';

describe('recruiting-studio-preflight', () => {
	it('blocks when telephony outbound is disabled', () => {
		const items = buildRecruitingOutboundPreflight({
			authConfigured: false,
			signedIn: false,
			perCallFlow: 'interview',
			hasHandoffContent: true,
			telephonyOutboundEnabled: false,
			selectedId: null,
			selectedCallerId: '',
			platformCallerId: '+15551234567',
			ivLoadingDefaults: false,
			ivDefaultsError: null,
		});
		expect(recruitingPreflightBlocksDialOut(items)).toBe(true);
	});

	it('blocks custom caller ID without saved agent', () => {
		const items = buildRecruitingOutboundPreflight({
			authConfigured: true,
			signedIn: true,
			perCallFlow: 'screening',
			hasHandoffContent: true,
			telephonyOutboundEnabled: true,
			selectedId: null,
			selectedCallerId: '+15559876543',
			platformCallerId: '+15551234567',
			ivLoadingDefaults: false,
			ivDefaultsError: null,
		});
		const agentItem = items.find((i) => i.id === 'caller_id_agent');
		expect(agentItem?.ok).toBe(false);
		expect(agentItem?.blocking).toBe(true);
		expect(recruitingPreflightBlocksDialOut(items)).toBe(true);
	});

	it('allows dial-out when telephony enabled and no blocking items', () => {
		const items = buildRecruitingOutboundPreflight({
			authConfigured: false,
			signedIn: false,
			perCallFlow: 'screening',
			hasHandoffContent: false,
			telephonyOutboundEnabled: true,
			selectedId: null,
			selectedCallerId: '',
			platformCallerId: '',
			ivLoadingDefaults: false,
			ivDefaultsError: null,
		});
		expect(recruitingPreflightBlocksDialOut(items)).toBe(false);
	});
});
