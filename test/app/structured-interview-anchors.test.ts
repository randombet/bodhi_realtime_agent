import { describe, expect, it } from 'vitest';
import {
	DEFAULT_STRUCTURED_INTERVIEW_ANCHORS,
	normalizeInterviewAnchors,
	validateInterviewAnchorsField,
} from '../../app/agents/interview/structured-interview-default-content.js';
import { authoringFromAnchors } from '../../app/agents/interview/structured-interview-session.js';

describe('structured interview anchors', () => {
	it('validateInterviewAnchorsField accepts the default trio shape', () => {
		const v = validateInterviewAnchorsField([...DEFAULT_STRUCTURED_INTERVIEW_ANCHORS]);
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.anchors).toHaveLength(3);
	});

	it('validateInterviewAnchorsField rejects duplicate ids', () => {
		const v = validateInterviewAnchorsField([
			{ id: 'a', focus: 'x' },
			{ id: 'a', focus: 'y' },
		]);
		expect(v.ok).toBe(false);
	});

	it('normalizeInterviewAnchors falls back to defaults when anchors missing', () => {
		const list = normalizeInterviewAnchors({
			companyIntroMd: '',
			jobDescriptionMd: '',
			candidateResumeMd: '',
		});
		expect(list.map((a) => a.id)).toEqual([
			'walk_resume',
			'company_interest',
			'role_relevant_challenge',
		]);
	});

	it('authoringFromAnchors keeps spec/focus as planner guidance only — never as a speakable question', () => {
		const { sections, sectionsMode } = authoringFromAnchors(DEFAULT_STRUCTURED_INTERVIEW_ANCHORS);
		expect(sectionsMode).toBe('refine');
		expect(sections).toHaveLength(3);
		for (const [i, s] of (sections ?? []).entries()) {
			const a = DEFAULT_STRUCTURED_INTERVIEW_ANCHORS[i];
			expect(s.id).toBe(a.id);
			expect(s.title).toBe(a.focus);
			expect(s.probeGoal).toBe(a.spec);
			// The spec is interviewer guidance ("Ask what draws them…"), not candidate-facing text —
			// it must never seed the `question` field, which downstream is spoken verbatim.
			expect(s.question).toBeUndefined();
		}
	});

	it('normalizeInterviewAnchors uses custom anchors when valid', () => {
		const list = normalizeInterviewAnchors({
			companyIntroMd: '',
			jobDescriptionMd: '',
			candidateResumeMd: '',
			anchors: [
				{ id: 'culture_fit', focus: 'Team collaboration' },
				{ id: 'system_design', focus: 'Large-scale design' },
			],
		});
		expect(list.map((a) => a.id)).toEqual(['culture_fit', 'system_design']);
	});
});
