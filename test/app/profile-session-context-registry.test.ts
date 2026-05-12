// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { RECRUITING_DRAFT_SESSION_INPUT_KEY } from '../../app/agents/runtime/profile-session-inputs.js';
import {
	collectProfileContextTokensFromBody,
	createProfileSessionContextHandlers,
	putDraftForPath,
	resolveProfileSessionInputsFromTokens,
} from '../../app/server/profile-session-context-registry.js';

describe('profile-session-context-registry', () => {
	const handlers = createProfileSessionContextHandlers();

	it('maps screening draft token to structured_screening profile input', () => {
		const body = { companyMd: 'C', jobDescriptionMd: 'J', candidateResumeMd: 'R' };
		const put = putDraftForPath(handlers, '/api/structured-screening-draft', body);
		expect(put.matched).toBe(true);
		if (!put.matched) return;
		expect(put.result.ok).toBe(true);
		if (!put.result.ok) return;
		const token = put.result.token;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'structured_screening', {
			recruitingContextToken: token,
		});
		expect(inputs?.structured_screening).toEqual({
			companyMd: 'C',
			jobDescriptionMd: 'J',
			candidateResumeMd: 'R',
		});
	});

	it('maps recruiting draft token to ua_* profile under recruiting_draft key', () => {
		const body = { companyMd: 'A', jobDescriptionMd: 'B', candidateResumeMd: 'C' };
		const put = putDraftForPath(handlers, '/api/structured-screening-draft', body);
		expect(put.matched).toBe(true);
		if (!put.matched) return;
		expect(put.result.ok).toBe(true);
		if (!put.result.ok) return;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'ua_0123456789abcdef', {
			recruitingContextToken: put.result.token,
		});
		expect(inputs?.[RECRUITING_DRAFT_SESSION_INPUT_KEY]).toEqual({
			companyMd: 'A',
			jobDescriptionMd: 'B',
			candidateResumeMd: 'C',
		});
	});

	it('maps interview draft token to structured_interview profile input', () => {
		const body = {
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
		};
		const put = putDraftForPath(handlers, '/api/structured-interview-draft', body);
		expect(put.matched).toBe(true);
		if (!put.matched) return;
		expect(put.result.ok).toBe(true);
		if (!put.result.ok) return;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'structured_interview', {
			interviewContextToken: put.result.token,
		});
		expect(inputs?.structured_interview).toEqual({
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
		});
	});

	it('collectProfileContextTokensFromBody mirrors registry token param names', () => {
		const tokens = collectProfileContextTokensFromBody(handlers, {
			recruitingContextToken: ' r1 ',
			interviewContextToken: 'i1',
		});
		expect(tokens.recruitingContextToken).toBe('r1');
		expect(tokens.interviewContextToken).toBe('i1');
	});
});
