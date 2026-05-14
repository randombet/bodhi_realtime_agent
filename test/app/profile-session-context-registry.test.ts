// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { RECRUITING_DRAFT_SESSION_INPUT_KEY } from '../../app/agents/runtime/profile-session-inputs.js';
import {
	PROFILE_CONTEXT_TOKEN_PARAM,
	collectProfileContextTokensFromBody,
	createProfileSessionContextHandlers,
	getDefaultsForKind,
	putDraftForKind,
	putDraftForPath,
	resolveProfileSessionInputsFromTokens,
} from '../../app/server/profile-session-context-registry.js';

describe('profile-session-context-registry', () => {
	const handlers = createProfileSessionContextHandlers();

	// ── Unified API (putDraftForKind + profileContextToken) ────────────────────

	it('putDraftForKind stores screening draft and resolves via profileContextToken', () => {
		const put = putDraftForKind(handlers, 'structured_screening', {
			companyMd: 'C',
			jobDescriptionMd: 'J',
			candidateResumeMd: 'R',
		});
		expect(put.ok).toBe(true);
		if (!put.ok) return;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'structured_screening', {
			profileContextToken: put.token,
		});
		expect(inputs?.structured_screening).toEqual({
			companyMd: 'C',
			jobDescriptionMd: 'J',
			candidateResumeMd: 'R',
		});
	});

	it('putDraftForKind stores interview draft and resolves via profileContextToken', () => {
		const put = putDraftForKind(handlers, 'structured_interview', {
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
		});
		expect(put.ok).toBe(true);
		if (!put.ok) return;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'structured_interview', {
			profileContextToken: put.token,
		});
		expect(inputs?.structured_interview).toEqual({
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
		});
	});

	it('putDraftForKind stores interview draft with custom anchors', () => {
		const put = putDraftForKind(handlers, 'structured_interview', {
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
			anchors: [
				{ id: 'opening', focus: 'Warm-up' },
				{ id: 'deep_dive', focus: 'Architecture depth' },
			],
		});
		expect(put.ok).toBe(true);
		if (!put.ok) return;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'structured_interview', {
			profileContextToken: put.token,
		});
		expect(inputs?.structured_interview).toMatchObject({
			companyIntroMd: 'Intro',
			anchors: [
				{ id: 'opening', focus: 'Warm-up' },
				{ id: 'deep_dive', focus: 'Architecture depth' },
			],
		});
	});

	it('putDraftForKind stores interview draft with duration, brief, and sectionsMode', () => {
		const put = putDraftForKind(handlers, 'structured_interview', {
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
			durationMinutes: 45,
			interviewerBrief: 'Focus on distributed systems.',
			sectionsMode: 'verbatim',
		});
		expect(put.ok).toBe(true);
		if (!put.ok) return;
		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'structured_interview', {
			profileContextToken: put.token,
		});
		expect(inputs?.structured_interview).toMatchObject({
			companyIntroMd: 'Intro',
			durationMinutes: 45,
			interviewerBrief: 'Focus on distributed systems.',
			sectionsMode: 'verbatim',
		});
	});

	it('putDraftForKind rejects interview draft with invalid anchors', () => {
		const put = putDraftForKind(handlers, 'structured_interview', {
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
			anchors: [{ id: 'BadId' }],
		});
		expect(put.ok).toBe(false);
	});

	it('putDraftForKind rejects unknown kind', () => {
		const put = putDraftForKind(handlers, 'nonexistent_profile', {});
		expect(put.ok).toBe(false);
	});

	it('getDefaultsForKind returns defaults for known kinds', () => {
		const screening = getDefaultsForKind(handlers, 'structured_screening');
		expect(screening.ok).toBe(true);
		if (!screening.ok) return;
		expect(screening.payload).toHaveProperty('companyMd');

		const interview = getDefaultsForKind(handlers, 'structured_interview');
		expect(interview.ok).toBe(true);
		if (!interview.ok) return;
		expect(interview.payload).toHaveProperty('companyIntroMd');
	});

	it('getDefaultsForKind rejects unknown kind', () => {
		const r = getDefaultsForKind(handlers, 'nonexistent');
		expect(r.ok).toBe(false);
	});

	it('unified profileContextToken resolves for ua_* recruiting draft', () => {
		const put = putDraftForKind(handlers, 'structured_screening', {
			companyMd: 'A',
			jobDescriptionMd: 'B',
			candidateResumeMd: 'C',
		});
		expect(put.ok).toBe(true);
		if (!put.ok) return;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'ua_0123456789abcdef', {
			profileContextToken: put.token,
		});
		expect(inputs?.[RECRUITING_DRAFT_SESSION_INPUT_KEY]).toEqual({
			companyMd: 'A',
			jobDescriptionMd: 'B',
			candidateResumeMd: 'C',
		});
	});

	it('collectProfileContextTokensFromBody reads unified profileContextToken', () => {
		const tokens = collectProfileContextTokensFromBody(handlers, {
			profileContextToken: 'unified_tok',
		});
		expect(tokens[PROFILE_CONTEXT_TOKEN_PARAM]).toBe('unified_tok');
	});

	// ── Legacy backward compat (old paths + old token param names) ─────────────

	it('legacy: putDraftForPath still works for /api/structured-screening-draft', () => {
		const put = putDraftForPath(handlers, '/api/structured-screening-draft', {
			companyMd: 'C',
			jobDescriptionMd: 'J',
			candidateResumeMd: 'R',
		});
		expect(put.matched).toBe(true);
		if (!put.matched) return;
		expect(put.result.ok).toBe(true);
		if (!put.result.ok) return;

		const inputs = resolveProfileSessionInputsFromTokens(handlers, 'structured_screening', {
			recruitingContextToken: put.result.token,
		});
		expect(inputs?.structured_screening).toEqual({
			companyMd: 'C',
			jobDescriptionMd: 'J',
			candidateResumeMd: 'R',
		});
	});

	it('legacy: putDraftForPath still works for /api/structured-interview-draft', () => {
		const put = putDraftForPath(handlers, '/api/structured-interview-draft', {
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
		});
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

	it('legacy: collectProfileContextTokensFromBody reads old per-handler token names', () => {
		const tokens = collectProfileContextTokensFromBody(handlers, {
			recruitingContextToken: ' r1 ',
			interviewContextToken: 'i1',
		});
		expect(tokens.recruitingContextToken).toBe('r1');
		expect(tokens.interviewContextToken).toBe('i1');
	});
});
