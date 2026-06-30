import { describe, expect, it } from 'vitest';
import {
	buildFallbackBlueprint,
	interviewBlueprintSchema,
	normalizeBlueprint,
	sanitizeDisplayName,
} from '../../app/agents/interview/interview-blueprint.js';
import type { InterviewDocuments } from '../../app/agents/interview/interview-documents.js';
import {
	type InterviewEngineOptions,
	resolveInterviewEngineOptions,
} from '../../app/agents/interview/interview-options.js';

function opts(partial?: Partial<InterviewEngineOptions>, durationMinutes = 30) {
	return resolveInterviewEngineOptions(partial, { durationMinutes }).options;
}

const docs: InterviewDocuments = {
	jobDescription: '# Staff Engineer, Data Platform\n\nBuild stuff.',
	candidateResume: '# Priya Raman\n\nDid stuff.',
	companyIntro: '# Vector Foundry\n\nWe do stuff.',
};

const genericDocs: InterviewDocuments = {
	jobDescription: '# Job Description\n\nBuild stuff.',
	candidateResume: '# Resume\n\nDid stuff.',
	companyIntro: '# Company\n\nWe do stuff.',
};

function rawSection(text: string, over?: Record<string, unknown>) {
	return {
		id: text.toLowerCase().replace(/[^a-z]/g, '_'),
		title: text,
		probeGoal: `probe ${text}`,
		primaryQuestion: { text, rationale: `because ${text}`, sourceRefs: ['candidate_resume'] },
		maxFollowUps: 1,
		followUpBias: 'balanced',
		...over,
	};
}

function rawBlueprint(sections: ReturnType<typeof rawSection>[], over?: Record<string, unknown>) {
	return {
		schemaVersion: 1,
		digest: {
			candidateName: 'LLM Cand',
			companyName: 'LLM Co',
			roleTitle: 'LLM Role',
			roleFamily: 'software engineering / data platform',
			interviewStyle: 'screening',
			focusSummary: 'a focus',
			highlights: ['h1', 'h2'],
			scopeLock: false,
		},
		sections,
		openingGreeting: 'Hi [Candidate], welcome to [Company] for the [Role] role.',
		closingMessage: 'Thanks [Candidate], goodbye.',
		...over,
	};
}

describe('interviewBlueprintSchema (mode-aware section count)', () => {
	it('no authored outline: accepts 2..effectiveMaxSections, rejects <2 and >max', () => {
		const schema = interviewBlueprintSchema(opts({ maxSections: 3 }));
		expect(schema.safeParse(rawBlueprint([rawSection('A')])).success).toBe(false);
		expect(schema.safeParse(rawBlueprint([rawSection('A'), rawSection('B')])).success).toBe(true);
		expect(
			schema.safeParse(rawBlueprint([rawSection('A'), rawSection('B'), rawSection('C')])).success,
		).toBe(true);
		expect(
			schema.safeParse(
				rawBlueprint([rawSection('A'), rawSection('B'), rawSection('C'), rawSection('D')]),
			).success,
		).toBe(false);
	});

	it('refine: requires exactly the authored count', () => {
		const schema = interviewBlueprintSchema(
			opts({ sections: [{ question: 'Q1' }, { question: 'Q2' }], sectionsMode: 'refine' }),
		);
		expect(schema.safeParse(rawBlueprint([rawSection('A')])).success).toBe(false);
		expect(schema.safeParse(rawBlueprint([rawSection('A'), rawSection('B')])).success).toBe(true);
		expect(
			schema.safeParse(rawBlueprint([rawSection('A'), rawSection('B'), rawSection('C')])).success,
		).toBe(false);
	});

	it('augment: authored..effectiveMaxSections', () => {
		const schema = interviewBlueprintSchema(
			opts({
				maxSections: 5,
				sections: [{ question: 'Q1' }, { question: 'Q2' }],
				sectionsMode: 'augment',
			}),
		);
		expect(schema.safeParse(rawBlueprint([rawSection('A')])).success).toBe(false);
		expect(
			schema.safeParse(rawBlueprint(Array.from({ length: 4 }, (_, i) => rawSection(`S${i}`))))
				.success,
		).toBe(true);
		expect(
			schema.safeParse(rawBlueprint(Array.from({ length: 6 }, (_, i) => rawSection(`S${i}`))))
				.success,
		).toBe(false);
	});

	it('verbatim: does not strictly validate sections (loose / optional)', () => {
		const schema = interviewBlueprintSchema(
			opts({ sections: [{ question: 'Q1' }, { question: 'Q2' }], sectionsMode: 'verbatim' }),
		);
		expect(schema.safeParse(rawBlueprint([], { sections: undefined })).success).toBe(true);
		expect(schema.safeParse(rawBlueprint([rawSection('whatever')])).success).toBe(true);
	});

	it('always requires digest, openingGreeting, closingMessage', () => {
		const schema = interviewBlueprintSchema(opts());
		const ok = rawBlueprint([rawSection('A'), rawSection('B')]);
		expect(schema.safeParse({ ...ok, openingGreeting: undefined }).success).toBe(false);
		expect(schema.safeParse({ ...ok, closingMessage: '' }).success).toBe(false);
		expect(schema.safeParse({ ...ok, digest: undefined }).success).toBe(false);
	});
});

describe('normalizeBlueprint', () => {
	it('resolves names: meaningful heading wins over LLM value; substitutes [Tokens]', () => {
		const bp = normalizeBlueprint(rawBlueprint([rawSection('A'), rawSection('B')]), docs, opts());
		expect(bp.digest.candidateName).toBe('Priya Raman');
		expect(bp.digest.companyName).toBe('Vector Foundry');
		expect(bp.digest.roleTitle).toBe('Staff Engineer, Data Platform');
		expect(bp.digest.roleFamily).toBe('software engineering / data platform');
		expect(bp.openingGreeting).toContain('Priya Raman');
		expect(bp.openingGreeting).toContain('Vector Foundry');
		expect(bp.openingGreeting).not.toContain('[Candidate]');
		expect(bp.closingMessage).toContain('Priya Raman');
	});

	it('falls back to the LLM digest value when the heading is a generic stop-list label', () => {
		const bp = normalizeBlueprint(
			rawBlueprint([rawSection('A'), rawSection('B')]),
			genericDocs,
			opts(),
		);
		expect(bp.digest.candidateName).toBe('LLM Cand');
		expect(bp.digest.companyName).toBe('LLM Co');
	});

	it('metadataOverride wins over both', () => {
		const bp = normalizeBlueprint(
			rawBlueprint([rawSection('A'), rawSection('B')]),
			docs,
			opts({ metadataOverride: { candidateName: 'Override Name' } }),
		);
		expect(bp.digest.candidateName).toBe('Override Name');
	});

	it('clamps maxFollowUps, coerces followUpBias and sourceRefs, slug-uniquifies ids, clamps highlights', () => {
		const sections = [
			rawSection('Topic', {
				id: 'dup',
				maxFollowUps: 99,
				followUpBias: 'nonsense',
				primaryQuestion: { text: 'q1', sourceRefs: ['resume', 'company_intro', 'company_intro'] },
			}),
			rawSection('Topic', { id: 'dup', maxFollowUps: -5 }),
		];
		const bp = normalizeBlueprint(
			rawBlueprint(sections, {
				digest: { highlights: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
			}),
			docs,
			opts({ maxFollowUpsPerSection: 3, defaultFollowUpBias: 'prefer_deep_dive' }),
		);
		expect(bp.sections[0].maxFollowUps).toBe(3);
		expect(bp.sections[1].maxFollowUps).toBe(0);
		expect(bp.sections[0].followUpBias).toBe('prefer_deep_dive');
		expect(bp.sections[0].primaryQuestion.sourceRefs).toEqual(['company_intro']);
		expect(bp.sections[0].id).not.toBe(bp.sections[1].id);
		expect(bp.digest.highlights.length).toBe(8);
		expect(bp.digest.roleFamily).toBe('software engineering / data platform');
		expect(bp.sections.some((s) => 'mergedFromAuthoredIds' in s)).toBe(false);
	});

	it('applies the scopeLock option override', () => {
		const bp = normalizeBlueprint(
			rawBlueprint([rawSection('A'), rawSection('B')], { digest: { scopeLock: false } }),
			docs,
			opts({ scopeLock: true }),
		);
		expect(bp.digest.scopeLock).toBe(true);
	});

	it('verbatim: rebuilds sections from options.sections (word-for-word), honoring authored maxFollowUps/followUpBias', () => {
		const o = opts({
			sections: [
				{ question: 'Tell me about [Project].' },
				{
					question: 'What was hard?',
					title: 'Hard parts',
					maxFollowUps: 2,
					followUpBias: 'prefer_deep_dive',
				},
			],
			sectionsMode: 'verbatim',
		});
		const bp = normalizeBlueprint(
			rawBlueprint([rawSection('LLM rewrote this'), rawSection('and this')]),
			docs,
			o,
		);
		expect(bp.sections.length).toBe(2);
		expect(bp.sections[0].primaryQuestion.text).toBe('Tell me about [Project].'); // [Project] isn't a substituted token
		expect(bp.sections[1].primaryQuestion.text).toBe('What was hard?');
		expect(bp.sections[1].title).toBe('Hard parts');
		expect(bp.sections[1].maxFollowUps).toBe(2);
		expect(bp.sections[1].followUpBias).toBe('prefer_deep_dive');
	});

	it('refine: keeps the authored count/order, takes the LLM reword for text, honors authored budgets — even if the LLM reorders', () => {
		const o = opts({
			sections: [
				{ id: 'one', title: 'First', question: 'seed one', maxFollowUps: 1 },
				{ id: 'two', title: 'Second', question: 'seed two', followUpBias: 'prefer_clarification' },
			],
			sectionsMode: 'refine',
		});
		// LLM returns the two sections REORDERED (second first) with reworded text.
		const bp = normalizeBlueprint(
			rawBlueprint([rawSection('reworded second'), rawSection('reworded first')]),
			docs,
			o,
		);
		expect(bp.sections.map((s) => s.id)).toEqual(['one', 'two']); // authored order preserved
		expect(bp.sections.map((s) => s.title)).toEqual(['First', 'Second']);
		// text is the LLM section at the same *position* (the prompt instructs same order); the engine
		// doesn't try to re-pair by content — it just guarantees the authored order/count.
		expect(bp.sections[0].primaryQuestion.text).toBe('reworded second');
		expect(bp.sections[1].primaryQuestion.text).toBe('reworded first');
		expect(bp.sections[0].maxFollowUps).toBe(1);
		expect(bp.sections[1].followUpBias).toBe('prefer_clarification');
	});

	it('refine: a section with only title/probeGoal (no question) gets a generated question from the LLM', () => {
		const o = opts({
			sections: [{ title: 'Background', probeGoal: 'their story' }],
			sectionsMode: 'refine',
		});
		const bp = normalizeBlueprint(
			rawBlueprint([rawSection('Walk me through your background.')]),
			docs,
			o,
		);
		expect(bp.sections).toHaveLength(1);
		expect(bp.sections[0].title).toBe('Background');
		expect(bp.sections[0].primaryQuestion.text).toBe('Walk me through your background.');
	});

	it('augment: authored maxFollowUps/followUpBias override the section the planner carried the aN id through', () => {
		const o = opts({
			maxSections: 5,
			sections: [{ id: 'q1', question: 'Q1', maxFollowUps: 3, followUpBias: 'prefer_deep_dive' }],
			sectionsMode: 'augment',
		});
		// planner output: 2 sections; the first carries the authored engine-id 'a1'; the second is new.
		const bp = normalizeBlueprint(
			rawBlueprint([
				rawSection('first', {
					id: 'a1',
					primaryQuestion: {
						text: 'reworded Q1',
						rationale: 'r',
						sourceRefs: ['candidate_resume'],
					},
					maxFollowUps: 0,
					followUpBias: 'balanced',
				}),
				rawSection('extra', { id: 'extra_topic', maxFollowUps: 1 }),
			]),
			docs,
			o,
		);
		const carried = bp.sections.find((s) => s.primaryQuestion.text === 'reworded Q1');
		expect(carried?.maxFollowUps).toBe(3);
		expect(carried?.followUpBias).toBe('prefer_deep_dive');
		// the new section keeps the planner's values
		const extra = bp.sections.find((s) => s.primaryQuestion.text === 'extra');
		expect(extra?.maxFollowUps).toBe(1);
	});

	it('pads to ≥2 sections if the LLM returned too few (free-form / augment only)', () => {
		const bp = normalizeBlueprint(rawBlueprint([rawSection('Only one')]), docs, opts());
		expect(bp.sections.length).toBeGreaterThanOrEqual(2);
	});

	it('does NOT pad a single-section verbatim/refine outline (count/order is preserved)', () => {
		const verbatim = normalizeBlueprint(
			rawBlueprint([rawSection('whatever the LLM wrote')]),
			docs,
			opts({ sections: [{ question: 'My only question.' }], sectionsMode: 'verbatim' }),
		);
		expect(verbatim.sections).toHaveLength(1);
		expect(verbatim.sections[0].primaryQuestion.text).toBe('My only question.');

		const refine = normalizeBlueprint(
			rawBlueprint([rawSection('reworded q')]),
			docs,
			opts({ sections: [{ question: 'Seed question.' }], sectionsMode: 'refine' }),
		);
		expect(refine.sections).toHaveLength(1);
	});

	it('buildFallbackBlueprint also preserves a single-section verbatim outline', () => {
		const bp = buildFallbackBlueprint(
			docs,
			opts({ sections: [{ question: 'Only one.' }], sectionsMode: 'verbatim' }),
		);
		expect(bp.sections).toHaveLength(1);
		expect(bp.sections[0].primaryQuestion.text).toBe('Only one.');
	});
});

describe('buildFallbackBlueprint', () => {
	it('yields min(3, effectiveMaxSections) role-neutral sections with concrete (no-token) strings', () => {
		const bp3 = buildFallbackBlueprint(docs, opts());
		expect(bp3.sections.length).toBe(3);
		expect(bp3.openingGreeting).toContain('Priya Raman');
		expect(bp3.openingGreeting).not.toContain('[');
		expect(bp3.sections.every((s) => !s.primaryQuestion.text.includes('['))).toBe(true);

		const bp2 = buildFallbackBlueprint(docs, opts({ maxSections: 2 }));
		expect(bp2.sections.length).toBe(2);
	});

	it('uses authored sections when supplied (verbatim/refine semantics)', () => {
		const bp = buildFallbackBlueprint(
			docs,
			opts({ sections: [{ question: 'Q-one' }, { question: 'Q-two' }], sectionsMode: 'verbatim' }),
		);
		expect(bp.sections.map((s) => s.primaryQuestion.text)).toEqual(['Q-one', 'Q-two']);
	});

	it("flavors the 'hard problem' section technical when styleHint says engineering", () => {
		const bp = buildFallbackBlueprint(docs, opts({ styleHint: 'software engineering screening' }));
		expect(bp.sections[2].primaryQuestion.text.toLowerCase()).toContain('technical');
	});

	it('infers fallback challenge wording from the role documents, not a hardcoded software role', () => {
		const accountExecDocs: InterviewDocuments = {
			jobDescription:
				'# Account Executive\n\nOwn pipeline creation, discovery, negotiation, and closing for mid-market customers.',
			candidateResume:
				'# Jordan Lee\n\nSales leader with experience building pipeline and closing consultative deals.',
			companyIntro: '# Acme Growth\n\nA commercial operations platform for growing teams.',
		};
		const bp = buildFallbackBlueprint(accountExecDocs, opts());
		expect(bp.digest.roleTitle).toBe('Account Executive');
		expect(bp.digest.roleFamily).toBe('sales / account executive');
		expect(bp.digest.interviewStyle).toContain('Account Executive');
		expect(bp.sections[2].id).toBe('role_relevant_challenge');
		expect(bp.sections[2].primaryQuestion.text.toLowerCase()).not.toContain('technical');
		expect(bp.sections[2].primaryQuestion.text).toContain('Account Executive');
	});

	it('infers non-software role families from role documents', () => {
		const cases: Array<[string, InterviewDocuments, string]> = [
			[
				'product',
				{
					jobDescription:
						'# Senior Product Manager\n\nOwn product strategy, discovery, roadmap, prioritization, and launch metrics.',
					candidateResume: '# Alex Rivera\n\nProduct manager for B2B workflow products.',
					companyIntro: '# Meridian\n\nWorkflow software for clinics.',
				},
				'product management',
			],
			[
				'design',
				{
					jobDescription:
						'# Senior Product Designer\n\nDesign dense operator workflows, UX research, prototypes, and Figma components.',
					candidateResume: '# Nina Patel\n\nProduct designer for operational tools.',
					companyIntro: '# LumaOps\n\nOperations console software.',
				},
				'design / user experience',
			],
			[
				'ai',
				{
					jobDescription:
						'# Applied AI Engineer\n\nBuild LLM voice agents, retrieval, tool-use, prompt evals, and conversation quality systems.',
					candidateResume: '# Omar Singh\n\nApplied AI engineer for production LLM workflows.',
					companyIntro: '# HelioAssist\n\nVoice agents for customer operations.',
				},
				'applied AI / voice agents',
			],
			[
				'data',
				{
					jobDescription:
						'# Analytics Engineer, Growth Data\n\nOwn dbt, SQL, metric layers, cohort analysis, funnel diagnostics, and BI.',
					candidateResume: '# Sofia Martinez\n\nAnalytics engineer for ecommerce growth data.',
					companyIntro: '# AtlasRetail\n\nRetail analytics platform.',
				},
				'data / analytics engineering',
			],
		];
		for (const [label, documents, roleFamily] of cases) {
			const bp = buildFallbackBlueprint(documents, opts());
			expect(bp.digest.roleFamily, label).toBe(roleFamily);
		}
	});
});

describe('sanitizeDisplayName', () => {
	it('strips control/format chars and markdown markup, collapses whitespace', () => {
		expect(sanitizeDisplayName('  **Priya**​ Raman \n', 'x')).toBe('Priya Raman');
		expect(sanitizeDisplayName('', 'fallback')).toBe('fallback');
		expect(sanitizeDisplayName('   ', 'fallback')).toBe('fallback');
		expect(sanitizeDisplayName('a'.repeat(200), 'x').length).toBeLessThanOrEqual(81);
	});
});
