// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type {
	BlueprintSection,
	InterviewBlueprint,
} from '../../app/agents/interview/interview-blueprint.js';
import {
	type InterviewState,
	applyBlueprint,
	createInterviewState,
	getClosingMessage,
	getNextSectionPrimary,
	getOpeningGreeting,
	getStatus,
	recordAnswer,
} from '../../app/agents/interview/interview-state.js';

function section(id: string, text: string): BlueprintSection {
	return {
		id,
		title: id,
		probeGoal: `probe ${id}`,
		primaryQuestion: { text, rationale: `r-${id}`, sourceRefs: ['candidate_resume'] },
		maxFollowUps: 2,
		followUpBias: 'balanced',
	};
}

function blueprint(sections: BlueprintSection[]): InterviewBlueprint {
	return {
		schemaVersion: 1,
		digest: {
			candidateName: 'Priya',
			companyName: 'Vector',
			roleTitle: 'Staff Engineer',
			roleFamily: 'software engineering / realtime systems',
			interviewStyle: 'screening',
			focusSummary: 'a focus',
			highlights: ['h'],
			scopeLock: false,
		},
		sections,
		openingGreeting: 'Hi Priya, welcome.',
		closingMessage: 'Thanks Priya, goodbye.',
	};
}

function prepared(): InterviewState {
	const state = createInterviewState();
	applyBlueprint(state, blueprint([section('a', 'Q-A'), section('b', 'Q-B'), section('c', 'Q-C')]));
	return state;
}

describe('interview-state', () => {
	it('createInterviewState starts not_prepared and empty', () => {
		const s = createInterviewState();
		expect(s.phase).toBe('not_prepared');
		expect(s.sections).toEqual([]);
		expect(s.answers).toEqual([]);
		expect(s.usedFallback).toBe(false);
	});

	it('applyBlueprint copies the blueprint and resets the cursor (preserving usedFallback/briefSanitization)', () => {
		const s = createInterviewState();
		s.usedFallback = true;
		s.briefSanitization = { sanitized: true, truncated: false, sentinelRemoved: false };
		applyBlueprint(s, blueprint([section('a', 'Q-A'), section('b', 'Q-B')]));
		expect(s.phase).toBe('prepared');
		expect(s.sections.map((x) => x.id)).toEqual(['a', 'b']);
		expect(s.digest?.candidateName).toBe('Priya');
		expect(s.openingGreeting).toBe('Hi Priya, welcome.');
		expect(s.nextSectionIndex).toBe(0);
		expect(s.usedFallback).toBe(true); // not reset by applyBlueprint
		expect(s.briefSanitization?.sanitized).toBe(true);
	});

	it('getNextSectionPrimary walks the sections then flips to completed', () => {
		const s = prepared();
		const q1 = getNextSectionPrimary(s);
		expect(q1.status).toBe('question');
		expect(q1.question?.sectionId).toBe('a');
		expect(q1.question?.kind).toBe('primary');
		expect(q1.sectionNumber).toBe(1);
		expect(q1.totalSections).toBe(3);
		expect(q1.followUpIndexInSection).toBe(0);
		expect(s.phase).toBe('questioning');

		// (simulate the active question being answered before advancing)
		s.activeQuestion = undefined;
		const q2 = getNextSectionPrimary(s);
		expect(q2.question?.sectionId).toBe('b');
		expect(q2.sectionNumber).toBe(2);
		s.activeQuestion = undefined;
		const q3 = getNextSectionPrimary(s);
		expect(q3.question?.sectionId).toBe('c');
		expect(q3.sectionNumber).toBe(3);
		s.activeQuestion = undefined;
		const done = getNextSectionPrimary(s);
		expect(done.status).toBe('completed');
		expect(done.closingMessage).toBe('Thanks Priya, goodbye.');
		expect(s.phase).toBe('completed');
	});

	it('recordAnswer rejects when no active question or empty text, records otherwise', () => {
		const s = prepared();
		expect(recordAnswer(s, 'hi').status).toBe('error'); // no active question yet
		getNextSectionPrimary(s); // sets activeQuestion to section a's primary
		expect(recordAnswer(s, '   ').status).toBe('error'); // empty
		expect(s.activeQuestion).toBeDefined(); // not cleared on error
		const ok = recordAnswer(s, 'my answer');
		expect(ok.status).toBe('recorded');
		expect(ok.sectionId).toBe('a');
		expect(s.activeQuestion).toBeUndefined();
		expect(s.answers).toHaveLength(1);
		expect(s.answers[0]).toMatchObject({
			sectionId: 'a',
			questionText: 'Q-A',
			answerText: 'my answer',
		});
	});

	it('followUpCounts is a plain object keyed by section id (no fixed keys)', () => {
		const s = prepared();
		s.followUpCounts.a = (s.followUpCounts.a ?? 0) + 1;
		s.followUpCounts.b = (s.followUpCounts.b ?? 0) + 2;
		expect(getStatus(s).followUpCounts).toEqual({ a: 1, b: 2 });
	});

	it('getOpeningGreeting / getClosingMessage fall back to a safe template when missing', () => {
		const s = createInterviewState();
		s.digest = {
			candidateName: 'X',
			companyName: 'Y',
			roleTitle: 'Z',
			roleFamily: 'Z role',
			interviewStyle: 's',
			focusSummary: 'f',
			highlights: [],
			scopeLock: false,
		};
		expect(getOpeningGreeting(s)).toContain('X');
		expect(getClosingMessage(s)).toContain('X');
	});

	it('getStatus reports phase, counts, fallback flags', () => {
		const s = prepared();
		getNextSectionPrimary(s);
		const st = getStatus(s);
		expect(st.phase).toBe('questioning');
		expect(st.sectionsPrepared).toBe(3);
		expect(st.remainingSections).toBe(2);
		expect(st.activeSectionId).toBe('a');
		expect(st.usedFallback).toBe(false);
		expect(st.scopeLock).toBe(false);
	});
});
