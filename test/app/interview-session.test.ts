// SPDX-License-Identifier: MIT

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV1 } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('ai', () => ({ generateObject: vi.fn() }));

import { generateObject } from 'ai';
import {
	INTERVIEW_MAIN_AGENT_NAME,
	createInterviewMainAgent,
} from '../../app/agents/interview/interview-agent.js';
import type { InterviewDocuments } from '../../app/agents/interview/interview-documents.js';
import {
	prepareInterviewSessionParts,
	previewInterviewBlueprint,
} from '../../app/agents/interview/interview-session.js';
import type { InterviewProgressResult } from '../../app/agents/interview/interview-subagent.js';
import { endSessionInterview } from '../../app/agents/interview/interview-tools.js';
import {
	buildStructuredInterviewConfig,
	prepareStructuredInterviewSessionParts,
	structuredInterviewSessionOptionsFromExtras,
} from '../../app/agents/interview/structured-interview-session.js';
import type { MainAgent } from '../../src/types/agent.js';

const gen = generateObject as unknown as ReturnType<typeof vi.fn>;
const fakeModel = {} as unknown as LanguageModelV1;
const reasoningCtx = {
	googleApiKey: 'fake-key-for-tests',
	defaultReasoningModel: createGoogleGenerativeAI({ apiKey: 'fake-key-for-tests' })(
		'gemini-2.5-flash',
	),
};
const docs: InterviewDocuments = {
	jobDescription: '# Staff Engineer',
	candidateResume: '# Priya Raman',
	companyIntro: '# Vector Foundry',
};

function blueprintResult() {
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
			sections: [
				{
					id: 's1',
					title: 'A',
					probeGoal: 'p',
					primaryQuestion: { text: 'Q1', rationale: 'r', sourceRefs: ['candidate_resume'] },
					maxFollowUps: 0,
					followUpBias: 'balanced',
				},
				{
					id: 's2',
					title: 'B',
					probeGoal: 'p',
					primaryQuestion: { text: 'Q2', rationale: 'r', sourceRefs: ['candidate_resume'] },
					maxFollowUps: 0,
					followUpBias: 'balanced',
				},
			],
			openingGreeting: 'Hi Priya, welcome to the interview.',
			closingMessage: 'Thanks Priya, goodbye.',
		},
	};
}

function plannerThenAdvance() {
	return (o: { schemaName?: string }) =>
		o.schemaName === 'interview_blueprint'
			? blueprintResult()
			: { object: { action: 'advance', rationale: 'enough' } };
}

function parse(json: string): InterviewProgressResult {
	return JSON.parse(json) as InterviewProgressResult;
}

beforeEach(() => {
	gen.mockReset();
});

describe('prepareInterviewSessionParts (integration)', () => {
	it('builds the parts, patches the interviewer agent, and drives the question loop to completion', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const parts = await prepareInterviewSessionParts({
			documents: docs,
			durationMinutes: 20,
			reminderFractions: [0.5, 0.95],
			reasoning: { model: fakeModel },
		});

		// greeting baked from the blueprint
		expect(parts.state.openingGreeting).toBe('Hi Priya, welcome to the interview.');

		// patchMainAgents targets the 'interviewer' (or compiled 'main') agent: injects greeting +
		// state-aware instructions, and *replaces* any pre-existing progress/end tools with the
		// engine's own (so a compiled 'main' carrying the generic end_session ends up with
		// endSessionInterview — reason 'interview_completed', not 'user_goodbye').
		const genericEndSession: MainAgent['tools'][number] = {
			name: 'end_session',
			description: 'generic',
			parameters: z.object({}),
			execution: 'inline',
			execute: async () => ({}),
		};
		const compiledMain: MainAgent = {
			name: 'main',
			instructions:
				'You are a structured software interviewer conducting a voice interview around three primary anchors.',
			tools: [genericEndSession],
		};
		const [patchedMain] = parts.patchMainAgents([compiledMain]);
		expect(patchedMain.tools.filter((t) => t.name === 'end_session')).toHaveLength(1);
		expect(patchedMain.tools.find((t) => t.name === 'end_session')).toBe(endSessionInterview);
		expect(patchedMain.tools.some((t) => t.name === 'record_answer_and_get_next_question')).toBe(
			true,
		);
		expect(patchedMain.instructions).not.toContain('three primary anchors'); // stale guidance gone
		expect(patchedMain.greeting).toContain('Hi Priya, welcome to the interview.');

		// patching the demo-built 'interviewer' agent is idempotent (it already has greeting + tools)
		const baseAgent: MainAgent = createInterviewMainAgent({ documents: docs, state: parts.state });
		const [patched] = parts.patchMainAgents([baseAgent]);
		expect(patched.name).toBe(INTERVIEW_MAIN_AGENT_NAME);
		expect(patched.greeting).toContain('Hi Priya, welcome to the interview.');
		expect(
			patched.tools.filter((t) => t.name === 'record_answer_and_get_next_question'),
		).toHaveLength(1);
		expect(patched.tools.filter((t) => t.name === 'end_session')).toHaveLength(1);
		// an unrelated agent is left alone
		const other: MainAgent = { name: 'mathExpert', instructions: 'x', tools: [] };
		expect(parts.patchMainAgents([other])[0]).toBe(other);

		// timing-reminder background agent built from durationMinutes × reminderFractions = [10, 19]
		expect(parts.backgroundAgents).toHaveLength(1);

		// drive the loop via the persistent subagent
		const subCfg = parts.subagentConfigs.record_answer_and_get_next_question;
		expect(subCfg.lifetime).toBe('persistent_session');
		const factory = subCfg.persistentFactory;
		expect(factory).toBeDefined();
		if (!factory) throw new Error('persistentFactory missing');
		const sub = await factory('record_answer_and_get_next_question', subCfg);

		const open = parse(await sub.invoke('', {}));
		expect(open.status).toBe('question');
		if (open.status === 'question') expect(open.question.text).toBe('Q1');
		const after1 = parse(
			await sub.invoke('', { answerText: 'a thorough answer for the first topic' }),
		);
		expect(after1.status).toBe('question');
		if (after1.status === 'question') expect(after1.question.text).toBe('Q2');
		const done = parse(
			await sub.invoke('', { answerText: 'a thorough answer for the second topic' }),
		);
		expect(done.status).toBe('completed');
		if (done.status === 'completed') expect(done.closingMessage).toBe('Thanks Priya, goodbye.');
	});

	it('reminderFractions: [] ⇒ no timing-reminder background agent; an explicit reminderSchedule wins over duration', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const none = await prepareInterviewSessionParts({
			documents: docs,
			durationMinutes: 30,
			reminderFractions: [],
			reasoning: { model: fakeModel },
		});
		expect(none.backgroundAgents).toHaveLength(0);

		const explicit = await prepareInterviewSessionParts({
			documents: docs,
			durationMinutes: 999,
			reminderFractions: [0.5],
			reminderSchedule: [7, 14],
			reasoning: { model: fakeModel },
		});
		expect(explicit.backgroundAgents).toHaveLength(1); // present (and uses [7,14], not 999×0.5)
	});

	it('passes extraBackgroundAgentFactories through', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const parts = await prepareInterviewSessionParts(
			{
				documents: docs,
				durationMinutes: 20,
				reminderFractions: [],
				reasoning: { model: fakeModel },
			},
			{ extraBackgroundAgentFactories: [() => ({ name: 'extra', onStart() {} })] },
		);
		expect(parts.backgroundAgents.map((a) => a.name)).toEqual(['extra']);
	});

	it('prepareStructuredInterviewSessionParts builds an InterviewConfig from the screening texts and keeps the fixed reminder schedule', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const parts = await prepareStructuredInterviewSessionParts({
			texts: { companyMd: '# Co', jobDescriptionMd: '# JD', candidateResumeMd: '# Cand' },
			subagentLanguageModel: fakeModel,
		});
		expect(parts.subagentConfigs.record_answer_and_get_next_question).toBeDefined();
		// STRUCTURED_SCREENING_REMINDER_MINUTES = [5,10,15,20,25] ⇒ one timing-reminder agent
		expect(parts.backgroundAgents).toHaveLength(1);
		expect(typeof parts.patchMainAgents).toBe('function');
	});

	it('prepareStructuredInterviewSessionParts invokes the deprecated onPrepareFallback when the planner falls back', async () => {
		gen.mockRejectedValueOnce(new Error('planner down'));
		const onPrepareFallback = vi.fn();
		const parts = await prepareStructuredInterviewSessionParts({
			texts: { companyMd: '# Co', jobDescriptionMd: '# JD', candidateResumeMd: '# Cand' },
			subagentLanguageModel: fakeModel,
			onPrepareFallback,
		});
		expect(parts.state.usedFallback).toBe(true);
		expect(onPrepareFallback).toHaveBeenCalledOnce();
	});

	it('prepareStructuredInterviewSessionParts: a per-session durationMinutes makes reminders scale; structure overrides merge over the preset', async () => {
		// custom duration ⇒ default reminder fractions × duration ⇒ a timing-reminder agent is present
		gen.mockImplementation(plannerThenAdvance());
		const custom = await prepareStructuredInterviewSessionParts({
			texts: { companyMd: '# Co', jobDescriptionMd: '# JD', candidateResumeMd: '# Cand' },
			subagentLanguageModel: fakeModel,
			durationMinutes: 12,
			structure: { interviewerBrief: 'push for metrics' },
		});
		expect(custom.backgroundAgents).toHaveLength(1);
		expect(custom.state.briefSanitization?.sanitized).toBe(false);
	});
});

describe('previewInterviewBlueprint', () => {
	it('runs the planner once and returns the blueprint view (no VoiceSession)', async () => {
		gen.mockImplementation(plannerThenAdvance());
		const preview = await previewInterviewBlueprint({
			documents: docs,
			durationMinutes: 20,
			reasoning: { model: fakeModel },
		});
		expect(preview.usedFallback).toBe(false);
		expect(preview.digest.candidateName).toBe('Priya Raman');
		expect(preview.sections.map((s) => s.primaryQuestion.text)).toEqual(['Q1', 'Q2']);
		expect(preview.openingGreeting).toBe('Hi Priya, welcome to the interview.');
		expect(preview.closingMessage).toBe('Thanks Priya, goodbye.');
		expect(preview.reminderSchedule).toEqual([10, 16, 19]); // 20 × [0.5, 0.8, 0.95]
	});

	it('reports usedFallback + prepareError when the planner fails', async () => {
		gen.mockRejectedValueOnce(new Error('planner exploded'));
		const preview = await previewInterviewBlueprint({
			documents: docs,
			durationMinutes: 15,
			reasoning: { model: fakeModel },
		});
		expect(preview.usedFallback).toBe(true);
		expect(preview.prepareError).toContain('planner exploded');
		expect(preview.sections.length).toBeGreaterThanOrEqual(2); // fallback blueprint
	});

	it('surfaces InterviewConfigError for bad config (no LLM call)', async () => {
		await expect(
			previewInterviewBlueprint({
				documents: docs,
				durationMinutes: 0,
				reasoning: { model: fakeModel },
			}),
		).rejects.toThrow(/durationMinutes/);
		expect(gen).not.toHaveBeenCalled();
	});
});

describe('structured-interview config helpers', () => {
	const texts = { companyMd: '# Co', jobDescriptionMd: '# JD', candidateResumeMd: '# Cand' };

	it('structuredInterviewSessionOptionsFromExtras: forwards brief/sections/mode/duration', () => {
		const opts = structuredInterviewSessionOptionsFromExtras(texts, reasoningCtx, {
			interviewerBrief: 'push for metrics',
			sections: [{ question: 'Walk me through X.' }],
			sectionsMode: 'verbatim',
			durationMinutes: 18,
		});
		expect(opts.texts).toBe(texts);
		expect(opts.durationMinutes).toBe(18);
		expect(opts.structure?.interviewerBrief).toBe('push for metrics');
		expect(opts.structure?.sections).toEqual([{ question: 'Walk me through X.' }]);
		expect(opts.structure?.sectionsMode).toBe('verbatim');
		expect(opts.subagentLanguageModel).toBeDefined();
	});

	it('structuredInterviewSessionOptionsFromExtras: undefined extras ⇒ empty structure, no duration override', () => {
		const opts = structuredInterviewSessionOptionsFromExtras(texts, reasoningCtx, undefined);
		expect(opts.durationMinutes).toBeUndefined();
		expect(opts.structure).toEqual({
			interviewerBrief: undefined,
			sections: undefined,
			sectionsMode: undefined,
		});
	});

	it('buildStructuredInterviewConfig: no custom duration ⇒ fixed screening duration + fixed reminder minutes', () => {
		const cfg = buildStructuredInterviewConfig({ texts, subagentLanguageModel: fakeModel });
		expect(cfg.durationMinutes).toBe(30);
		expect(cfg.reminderSchedule).toEqual([5, 10, 15, 20, 25]);
		expect(cfg.reasoning.model).toBe(fakeModel);
		// merged over STRUCTURED_SCREENING_PRESET (maxSections 3)
		expect(cfg.structure.maxSections).toBe(3);
	});

	it('buildStructuredInterviewConfig: custom duration ⇒ reminders scale by fractions, preset overrides merge', () => {
		const cfg = buildStructuredInterviewConfig({
			texts,
			subagentLanguageModel: fakeModel,
			durationMinutes: 12,
			structure: { interviewerBrief: 'hi' },
		});
		expect(cfg.durationMinutes).toBe(12);
		expect(cfg.reminderSchedule).toBeUndefined(); // uses default reminderFractions, not a fixed schedule
		expect(cfg.structure.interviewerBrief).toBe('hi');
	});

	it('structuredInterviewSessionOptionsFromExtras: subagentReasoning overrides default Google model id', () => {
		const opts = structuredInterviewSessionOptionsFromExtras(texts, reasoningCtx, {
			subagentReasoning: { reasoningProvider: 'google', reasoningModel: 'gemini-from-extras' },
		});
		expect(opts.subagentLanguageModel.modelId).toBe('gemini-from-extras');
	});

	it('structuredInterviewSessionOptionsFromExtras: forwards thinkingBudget for Google', () => {
		const opts = structuredInterviewSessionOptionsFromExtras(texts, reasoningCtx, {
			subagentReasoning: {
				reasoningProvider: 'google',
				reasoningModel: 'gemini-2.5-flash',
				thinkingBudget: 64,
			},
		});
		expect(opts.subagentThinkingBudget).toBe(64);
	});
});
