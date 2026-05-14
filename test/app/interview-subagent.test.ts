// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({ generateObject: vi.fn() }));

import { generateObject } from 'ai';
import type { InterviewConfig } from '../../app/agents/interview/interview-config.js';
import { resolveInterviewConfig } from '../../app/agents/interview/interview-config.js';
import type { InterviewDocuments } from '../../app/agents/interview/interview-documents.js';
import { createInterviewState } from '../../app/agents/interview/interview-state.js';
import {
	type InterviewProgressResult,
	InterviewSubagent,
	createInterviewSubagentConfig,
} from '../../app/agents/interview/interview-subagent.js';

const gen = generateObject as unknown as ReturnType<typeof vi.fn>;
const fakeModel = {} as unknown as LanguageModelV1;
const docs: InterviewDocuments = {
	jobDescription: '# Staff Engineer',
	candidateResume: '# Priya Raman',
	companyIntro: '# Vector Foundry',
};

function rawSection(id: string, text: string, maxFollowUps = 1) {
	return {
		id,
		title: id,
		probeGoal: `probe ${id}`,
		primaryQuestion: { text, rationale: `r-${id}`, sourceRefs: ['candidate_resume'] },
		maxFollowUps,
		followUpBias: 'balanced',
	};
}

function rawBlueprintResult(sections = [rawSection('s1', 'Q1'), rawSection('s2', 'Q2')]) {
	return {
		object: {
			schemaVersion: 1,
			digest: {
				candidateName: 'Priya Raman',
				companyName: 'Vector Foundry',
				roleTitle: 'Staff Engineer',
				interviewStyle: 'screening',
				focusSummary: 'a focus',
				highlights: ['h1'],
				scopeLock: false,
			},
			sections,
			openingGreeting: 'Hi Priya, welcome.',
			closingMessage: 'Thanks Priya, goodbye.',
		},
	};
}

/** Default mock: planner returns a 2-section blueprint; any decision call returns `advance`. */
function plannerThenAdvance(sections?: ReturnType<typeof rawSection>[]) {
	return (opts: { schemaName?: string }) =>
		opts.schemaName === 'interview_blueprint'
			? rawBlueprintResult(sections)
			: { object: { action: 'advance', rationale: 'enough' } };
}

function makeSubagent(config?: Partial<InterviewConfig>) {
	const rc = resolveInterviewConfig({
		documents: docs,
		durationMinutes: 30,
		reasoning: { model: fakeModel },
		...config,
	} as InterviewConfig);
	return new InterviewSubagent('record_answer_and_get_next_question', createInterviewState(), rc);
}

function parse(json: string): InterviewProgressResult {
	return JSON.parse(json) as InterviewProgressResult;
}

beforeEach(() => {
	gen.mockReset();
});

describe('InterviewSubagent', () => {
	it('prepare() applies the planner blueprint; first invoke() returns section-1 primary', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const sub = makeSubagent();
		await sub.prepare();
		const r = parse(await sub.invoke('', {}));
		expect(r.status).toBe('question');
		if (r.status === 'question') {
			expect(r.question.sectionId).toBe('s1');
			expect(r.question.text).toBe('Q1');
			expect(r.question.kind).toBe('primary');
			expect(r.sectionNumber).toBe(1);
			expect(r.totalSections).toBe(2);
			expect(r.followUpIndexInSection).toBe(0);
			expect(r.questionNumber).toBe(1); // deprecated alias
		}
	});

	it('prepare() failure falls back to a generic blueprint (never throws); invoke() still works', async () => {
		gen.mockRejectedValueOnce(new Error('boom'));
		const sub = makeSubagent();
		await expect(sub.prepare()).resolves.toBeUndefined();
		const r = parse(await sub.invoke('', {}));
		expect(r.status).toBe('question'); // fallback blueprint has ≥2 sections
	});

	it('prepare() re-throws AbortError', async () => {
		const abort = new Error('aborted');
		abort.name = 'AbortError';
		gen.mockRejectedValueOnce(abort);
		await expect(makeSubagent().prepare()).rejects.toThrow(/abort/i);
	});

	it('answer → advance decision → next section primary; then → completed', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const sub = makeSubagent();
		await sub.prepare();
		await sub.invoke('', {});
		const r2 = parse(
			await sub.invoke('', { answerText: 'a thorough answer about the first topic here' }),
		);
		expect(r2.status).toBe('question');
		if (r2.status === 'question') expect(r2.question.sectionId).toBe('s2');
		const r3 = parse(
			await sub.invoke('', { answerText: 'another thorough answer about the second topic' }),
		);
		expect(r3.status).toBe('completed');
		if (r3.status === 'completed') expect(r3.closingMessage).toBe('Thanks Priya, goodbye.');
	});

	it('answer → follow_up decision → dynamic question, followUpIndexInSection increments', async () => {
		gen.mockImplementation((o: { schemaName?: string }) =>
			o.schemaName === 'interview_blueprint'
				? rawBlueprintResult()
				: {
						object: {
							action: 'follow_up',
							questionText: 'Tell me more about X.',
							rationale: 'needs detail',
						},
					},
		);
		const sub = makeSubagent();
		await sub.prepare();
		await sub.invoke('', {});
		const r = parse(await sub.invoke('', { answerText: 'short' }));
		expect(r.status).toBe('question');
		if (r.status === 'question') {
			expect(r.question.kind).toBe('follow_up');
			expect(r.question.text).toBe('Tell me more about X.');
			expect(r.question.sectionId).toBe('s1');
			expect(r.followUpIndexInSection).toBe(1);
		}
	});

	it('budget exhausted ⇒ forced advance even if the decision LLM would say follow_up', async () => {
		gen.mockImplementation((o: { schemaName?: string }) =>
			o.schemaName === 'interview_blueprint'
				? rawBlueprintResult()
				: { object: { action: 'follow_up', questionText: 'more?', rationale: 'x' } },
		);
		const sub = makeSubagent({ structure: { maxFollowUpsPerSection: 0 } }); // clamps every section's maxFollowUps to 0
		await sub.prepare();
		await sub.invoke('', {});
		const r = parse(await sub.invoke('', { answerText: 'short' }));
		expect(r.status).toBe('question');
		if (r.status === 'question') expect(r.question.sectionId).toBe('s2');
	});

	it("invoke() before prepare() ⇒ {status:'error', recoverable:false}", async () => {
		const r = parse(await makeSubagent().invoke('', {}));
		expect(r.status).toBe('error');
		if (r.status === 'error') expect(r.recoverable).toBe(false);
	});

	it('answerText missing while a question is active ⇒ recoverable error', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const sub = makeSubagent();
		await sub.prepare();
		await sub.invoke('', {}); // active question set
		const r = parse(await sub.invoke('', {}));
		expect(r.status).toBe('error');
		if (r.status === 'error') expect(r.recoverable).toBe(true);
	});

	it('idempotent replay: same clientRequestId returns the prior result verbatim', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const sub = makeSubagent();
		await sub.prepare();
		const first = await sub.invoke('', { clientRequestId: 'open' });
		const replay = await sub.invoke('', {
			clientRequestId: 'open',
			answerText: 'this would be wrong to record',
		});
		expect(replay).toBe(first);
	});

	it('createInterviewSubagentConfig wires a persistent_session subagent', () => {
		const cfg = createInterviewSubagentConfig(makeSubagent());
		expect(cfg.lifetime).toBe('persistent_session');
		expect(cfg.reasoningModel).toBe(fakeModel);
		expect(typeof cfg.persistentFactory).toBe('function');
	});
});
