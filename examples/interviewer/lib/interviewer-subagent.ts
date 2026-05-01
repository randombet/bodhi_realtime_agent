// SPDX-License-Identifier: MIT

import { tool } from 'ai';
import type { LanguageModelV1 } from 'ai';
import { generateText } from 'ai';
import { z } from 'zod';
import type { SubagentConfig } from '../../../src/types/agent.js';
import type { InterviewDocuments } from './interview-documents.js';
import {
	type InterviewPlan,
	type InterviewState,
	QUESTION_IDS,
	applyInterviewPlan,
	normalizeInterviewPlanWithDocuments,
} from './interview-state.js';

const questionIdSchema = z.enum(QUESTION_IDS);

const interviewPlanSchema = z.object({
	digest: z.object({
		candidateName: z.string().min(1),
		companyName: z.string().min(1),
		roleTitle: z.string().min(1),
		resumeHighlights: z.array(z.string().min(1)).min(1),
		companyHighlights: z.array(z.string().min(1)).min(1),
		mustHaveTechnologies: z.array(z.string().min(1)).min(1),
		alignmentNotes: z.array(z.string().min(1)).min(1),
	}),
	questions: z
		.array(
			z.object({
				id: questionIdSchema,
				text: z.string().min(1),
				rationale: z.string().min(1),
				sourceRefs: z.array(z.string().min(1)).min(1),
			}),
		)
		.length(3),
});

export function createSoftwareInterviewerSubagentConfig(
	state: InterviewState,
	documents: InterviewDocuments,
): SubagentConfig {
	return {
		name: 'software_interviewer',
		instructions: buildSoftwareInterviewerInstructions(documents),
		tools: {
			save_interview_plan: tool({
				description:
					'Save the generated interview digest and exactly three planned interview questions.',
				parameters: interviewPlanSchema,
				execute: async (plan) => {
					const normalized = normalizeInterviewPlanWithDocuments(plan as InterviewPlan, documents);
					applyInterviewPlan(state, normalized);
					return {
						status: 'saved',
						companyName: normalized.digest.companyName,
						roleTitle: normalized.digest.roleTitle,
						questionCount: normalized.questions.length,
					};
				},
			}),
		},
		maxSteps: 3,
		timeout: 45_000,
	};
}

export async function prepareInterviewPlanWithSubagent(
	config: SubagentConfig,
	model: LanguageModelV1,
): Promise<void> {
	await generateText({
		model,
		system: config.instructions,
		prompt:
			'Prepare the interview now. Call save_interview_plan exactly once with the document digest and three-question plan.',
		tools: config.tools as Parameters<typeof generateText>[0]['tools'],
		maxSteps: config.maxSteps ?? 3,
	});
}

function buildSoftwareInterviewerInstructions(documents: InterviewDocuments): string {
	return `You are the software_interviewer planning subagent for a voice interview.

Your job is to process the provided documents and save an interview plan by calling save_interview_plan exactly once.

Hard requirements:
- Generate exactly three questions.
- Use these question IDs in this exact order:
  1. walk_resume
  2. company_interest
  3. technical_challenge
- Question 1 must ask the candidate to tell me about themselves or walk through their resume.
- Question 2 must ask why they want to work for the company named in the company intro.
- Question 3 must ask about a challenging technical problem they solved.
- Use exact document values: candidate name "Maya Chen", company name "Northstar Robotics", role title "Senior Software Engineer, Realtime Systems" when those are present in the documents.
- Never use placeholders such as "the company", "[Company]", or "the role" in saved digest or questions.
- Keep digest arrays compact: at most 6 resume highlights, 6 company highlights, 8 technologies, 6 alignment notes, and 3 source refs per question.
- Keep each question concise and natural for voice, ideally under 28 words.
- Do not create follow-up questions in V1.
- After save_interview_plan succeeds, return only a short confirmation telling the main agent to call record_answer_and_get_next_question.

# Job Description
${documents.jobDescription}

# Candidate Resume
${documents.candidateResume}

# Company Intro
${documents.companyIntro}`;
}
