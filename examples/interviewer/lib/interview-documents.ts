import { readFileSync } from 'node:fs';

export interface InterviewDocuments {
	jobDescription: string;
	candidateResume: string;
	companyIntro: string;
}

function readRequiredMarkdown(url: URL, label: string): string {
	const text = readFileSync(url, 'utf8').trim();
	if (!text) {
		throw new Error(`Interview document is empty: ${label}`);
	}
	return text;
}

export function loadInterviewDocuments(): InterviewDocuments {
	return {
		jobDescription: readRequiredMarkdown(
			new URL('../docs/job_description.md', import.meta.url),
			'job_description.md',
		),
		candidateResume: readRequiredMarkdown(
			new URL('../docs/candidate_resume.md', import.meta.url),
			'candidate_resume.md',
		),
		companyIntro: readRequiredMarkdown(
			new URL('../docs/company_intro.md', import.meta.url),
			'company_intro.md',
		),
	};
}
