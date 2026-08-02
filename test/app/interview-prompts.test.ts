import { describe, expect, it } from 'vitest';
import type { BlueprintSection } from '../../app/agents/interview/interview-blueprint.js';
import type { InterviewDocuments } from '../../app/agents/interview/interview-documents.js';
import {
	type InterviewEngineOptions,
	resolveInterviewEngineOptions,
} from '../../app/agents/interview/interview-options.js';
import {
	buildDecisionPrompt,
	buildLeaderInstructions,
	buildPlannerInstructions,
	renderAuthoredSectionsBlock,
} from '../../app/agents/interview/interview-prompts.js';
import { createInterviewState } from '../../app/agents/interview/interview-state.js';

function opts(partial?: Partial<InterviewEngineOptions>) {
	return resolveInterviewEngineOptions(partial, { durationMinutes: 30 }).options;
}

const docs: InterviewDocuments = {
	jobDescription: '# Staff Engineer\n\nBuild stuff.',
	candidateResume: '# Priya Raman\n\nDid stuff.',
	companyIntro: '# Vector Foundry\n\nWe do stuff.',
};

const section: BlueprintSection = {
	id: 's1',
	title: 'Background',
	probeGoal: 'their story',
	primaryQuestion: {
		text: 'Walk me through it.',
		rationale: 'r',
		sourceRefs: ['candidate_resume'],
	},
	maxFollowUps: 1,
	followUpBias: 'balanced',
};

describe('question phrasing contract (spoken-verbatim channel)', () => {
	// questionText / primaryQuestion.text is spoken to the candidate word-for-word by the MainAgent
	// (which is explicitly forbidden from paraphrasing), so every prompt that produces it must state
	// the contract: second person, never an instruction to the interviewer like "Ask …".

	it('planner instructions state that question text is spoken word-for-word, never interviewer-directed', () => {
		const p = buildPlannerInstructions(docs, opts());
		expect(p).toContain('word-for-word');
		expect(p).toContain('Never write it as an instruction to the interviewer');
	});

	it('refine-mode authored-sections block requires converting interviewer guidance into candidate-facing text', () => {
		const block = renderAuthoredSectionsBlock(
			[{ title: 'Why us', probeGoal: 'Ask what draws them to the company.' }],
			'refine',
		);
		expect(block).toContain('spoken directly to the candidate');
	});

	it('leader instructions state that questionText is spoken word-for-word', () => {
		const state = createInterviewState();
		state.sections = [section];
		const p = buildLeaderInstructions(docs, state, section, opts());
		expect(p).toContain('word-for-word');
	});

	it('decision prompt forbids interviewer-directed questionText', () => {
		const state = createInterviewState();
		state.sections = [section];
		const p = buildDecisionPrompt(state, section, 'my answer', 0);
		expect(p).toContain('never an instruction to the interviewer');
	});
});
