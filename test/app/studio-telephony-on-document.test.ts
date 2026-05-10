// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import {
	getPersistedStudioTelephony,
	hasVerifiedCallerIdPhone,
	studioTelephonyWithAddedCallerId,
	studioTelephonyWithOutboundSelection,
} from '../../app/agents/studio-telephony-on-document.js';
import { parseUserAgentRecord } from '../../app/agents/user-agent-record.js';

const baseRecord = () =>
	parseUserAgentRecord({
		id: 'ua_aaaaaaaaaaaaaaaa',
		userId: 'u1',
		name: 'Test',
		greeting: 'Hi',
		systemPrompt: 'You are a test agent.',
		enabledToolIds: ['get_current_time', 'end_session'],
		googleSearch: true,
		createdAt: 1,
		updatedAt: 1,
	});

describe('studio-telephony-on-document', () => {
	it('defaults empty telephony on agent without studioTelephony', () => {
		const doc = baseRecord();
		assert(doc, 'expected baseRecord');
		const t = getPersistedStudioTelephony(doc);
		expect(t.verifiedCallerIds).toEqual([]);
		expect(t.outboundCallerIdPhone).toBe('');
	});

	it('adds verified caller id and allows outbound selection', () => {
		const doc = baseRecord();
		assert(doc, 'expected baseRecord');
		const withId = studioTelephonyWithAddedCallerId(doc, {
			sid: 'PNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			phoneNumber: '+14155550100',
			friendlyName: 'bodhi:u1:ua_aaaaaaaaaaaaaaaa',
			verifiedAt: 99,
		});
		assert(withId, 'expected studioTelephonyWithAddedCallerId');
		expect(hasVerifiedCallerIdPhone(withId, '+14155550100')).toBe(true);
		const selected = studioTelephonyWithOutboundSelection(withId, '+14155550100');
		assert(selected, 'expected selection');
		expect(getPersistedStudioTelephony(selected).outboundCallerIdPhone).toBe('+14155550100');
	});

	it('rejects outbound selection for a number not on the agent', () => {
		const doc = baseRecord();
		assert(doc, 'expected baseRecord');
		const withId = studioTelephonyWithAddedCallerId(doc, {
			sid: 'PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			phoneNumber: '+14155550100',
			verifiedAt: 1,
		});
		assert(withId, 'expected studioTelephonyWithAddedCallerId');
		expect(studioTelephonyWithOutboundSelection(withId, '+19999999999')).toBeNull();
	});
});
