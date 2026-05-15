// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { StructuredInterviewKnowledgeTexts } from '../../app/agents/interview/structured-interview-default-content.js';
import {
	applyStructuredInterviewPillarKnowledgeToMainAgents,
	retainNonSessionPillarKnowledgeDocuments,
} from '../../app/agents/runtime/apply-structured-interview-session.js';
import type { MainAgent } from '../../src/types/agent.js';

const texts: StructuredInterviewKnowledgeTexts = {
	companyIntroMd: 'C',
	jobDescriptionMd: 'J',
	candidateResumeMd: 'R',
};

function findMain(agents: MainAgent[]): MainAgent | undefined {
	return agents.find((a) => a.name === 'main');
}

describe('retainNonSessionPillarKnowledgeDocuments', () => {
	it('drops known screening and interview pillar doc names', () => {
		const kept = retainNonSessionPillarKnowledgeDocuments([
			{ source: 'text', content: 'x', name: 'Company Profile', mode: 'prompt' },
			{ source: 'text', content: 'y', name: 'Employee handbook', mode: 'prompt' },
			{ source: 'text', content: 'z', name: 'Job Description', mode: 'prompt' },
		]);
		expect(kept).toHaveLength(1);
		expect(kept[0]?.name).toBe('Employee handbook');
	});
});

describe('applyStructuredInterviewPillarKnowledgeToMainAgents', () => {
	it('session pillars first, then any non-pillar doc (e.g. Studio attachment)', () => {
		const mainAgents: MainAgent[] = [
			{
				name: 'main',
				instructions: 'x',
				greeting: 'hi',
				tools: [],
				googleSearch: false,
				knowledgeBase: {
					documents: [{ source: 'text', content: 'old', name: 'Old', mode: 'prompt' }],
				},
			},
		];
		const out = applyStructuredInterviewPillarKnowledgeToMainAgents(mainAgents, texts);
		const main = findMain(out);
		expect(main?.knowledgeBase?.documents).toHaveLength(4);
		expect(main?.knowledgeBase?.documents?.slice(0, 3).map((d) => d.content)).toEqual([
			'C',
			'J',
			'R',
		]);
		expect(main?.knowledgeBase?.documents?.[3]?.content).toBe('old');
	});

	it('matches built-in when main had no KB (catalog compile model)', () => {
		const mainAgents: MainAgent[] = [
			{
				name: 'main',
				instructions: 'x',
				greeting: 'hi',
				tools: [],
				googleSearch: false,
			},
		];
		const out = applyStructuredInterviewPillarKnowledgeToMainAgents(mainAgents, texts);
		const main = findMain(out);
		expect(main?.knowledgeBase?.documents).toHaveLength(3);
		expect(main?.knowledgeBase?.documents?.map((d) => d.content)).toEqual(['C', 'J', 'R']);
	});

	it('supersedes screening-shaped pillars then keeps Studio-only attachments', () => {
		const mainAgents: MainAgent[] = [
			{
				name: 'main',
				instructions: 'x',
				greeting: 'hi',
				tools: [],
				googleSearch: false,
				knowledgeBase: {
					documents: [
						{ source: 'text', content: 'old-co', name: 'Company Profile', mode: 'prompt' },
						{ source: 'text', content: 'old-jd', name: 'Job Description', mode: 'prompt' },
						{ source: 'text', content: 'policy', name: 'Internal policy', mode: 'prompt' },
					],
				},
			},
		];
		const out = applyStructuredInterviewPillarKnowledgeToMainAgents(mainAgents, texts);
		const main = findMain(out);
		expect(main?.knowledgeBase?.documents).toHaveLength(4);
		expect(main?.knowledgeBase?.documents?.[0]?.content).toBe('C');
		expect(main?.knowledgeBase?.documents?.[1]?.content).toBe('J');
		expect(main?.knowledgeBase?.documents?.[2]?.content).toBe('R');
		expect(main?.knowledgeBase?.documents?.[3]?.name).toBe('Internal policy');
		expect(main?.knowledgeBase?.documents?.[3]?.content).toBe('policy');
	});

	it('preserves knowledgeBase fields other than documents and toolDescription (e.g. chunkSize)', () => {
		const mainAgents: MainAgent[] = [
			{
				name: 'main',
				instructions: 'x',
				greeting: 'hi',
				tools: [],
				googleSearch: false,
				knowledgeBase: {
					documents: [{ source: 'text', content: 'keep', name: 'Playbook', mode: 'prompt' }],
					chunkSize: 99,
					maxResults: 7,
				},
			},
		];
		const out = applyStructuredInterviewPillarKnowledgeToMainAgents(mainAgents, texts);
		const main = findMain(out);
		expect(main?.knowledgeBase?.chunkSize).toBe(99);
		expect(main?.knowledgeBase?.maxResults).toBe(7);
	});
});
