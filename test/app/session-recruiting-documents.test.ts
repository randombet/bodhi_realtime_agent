import { describe, expect, it } from 'vitest';
import {
	sessionRecruitingDocumentsFromInterview,
	sessionRecruitingDocumentsFromScreening,
	structuredScreeningTextsFromSessionDocuments,
} from '../../app/agents/recruiting/session-recruiting-documents.js';

describe('session-recruiting-documents', () => {
	it('maps screening payload into canonical triple and back', () => {
		const screening = { companyMd: 'C', jobDescriptionMd: 'J', candidateResumeMd: 'R' };
		const docs = sessionRecruitingDocumentsFromScreening(screening);
		expect(docs).toEqual({ company: 'C', job: 'J', resume: 'R' });
		expect(structuredScreeningTextsFromSessionDocuments(docs)).toEqual(screening);
	});

	it('maps interview wire triple into canonical triple', () => {
		const docs = sessionRecruitingDocumentsFromInterview({
			companyIntroMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
		});
		expect(docs).toEqual({ company: 'Intro', job: 'JD', resume: 'CV' });
		expect(structuredScreeningTextsFromSessionDocuments(docs)).toEqual({
			companyMd: 'Intro',
			jobDescriptionMd: 'JD',
			candidateResumeMd: 'CV',
		});
	});
});
