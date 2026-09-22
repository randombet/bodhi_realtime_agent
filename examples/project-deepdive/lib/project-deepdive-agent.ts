import { z } from 'zod';
import type { MainAgent } from '../../../src/types/agent.js';
import type { KnowledgeBaseConfig } from '../../../src/types/knowledge-base.js';
import type { ToolContext, ToolDefinition } from '../../../src/types/tool.js';
import {
	buildOpeningGreetingPromptFromContext,
	extractProjectContext,
} from './project-deepdive-state.js';
import type { ProjectDocuments } from './project-documents.js';

const KNOWLEDGE_BASE_DOCUMENTS: KnowledgeBaseConfig['documents'] = [
	{
		source: 'file',
		content: 'examples/project-deepdive/docs/job_description.md',
		name: 'Job Description',
		mode: 'prompt',
	},
	{
		source: 'file',
		content: 'examples/project-deepdive/docs/candidate_resume.md',
		name: 'Candidate Resume',
		mode: 'prompt',
	},
	{
		source: 'file',
		content: 'examples/project-deepdive/docs/company_intro.md',
		name: 'Company Intro',
		mode: 'prompt',
	},
];

export function createProjectDeepdiveKnowledgeBase(): KnowledgeBaseConfig {
	return {
		documents: KNOWLEDGE_BASE_DOCUMENTS,
	};
}

export function createProjectDeepdiveAgent(
	documents: ProjectDocuments,
	chosenProjectName: string,
): MainAgent {
	const context = extractProjectContext(documents);

	const progressInterview: ToolDefinition = {
		name: 'record_answer_and_get_next_question',
		description:
			'Forward interview progression to the persistent project deep-dive subagent. Use this only to start the interview or after the candidate answers the active anchor question. The subagent may return a primary, clarification, follow-up, or deep-dive question. Do not use it for unrelated questions or casual conversation.',
		parameters: z.object({
			answerText: z
				.string()
				.min(1)
				.optional()
				.describe('The candidate answer, summarized or transcribed. Omit only for the first call.'),
		}),
		execution: 'background',
		execute: async () => ({
			status: 'routed',
			message: 'Routed to persistent project deepdive subagent.',
		}),
	};

	const endSession: ToolDefinition = {
		name: 'end_session',
		description:
			'End the interview session after all four STAR anchors have been covered AND after you have spoken the closing message exactly.',
		parameters: z.object({}),
		execution: 'inline',
		execute: async (_args, ctx: ToolContext) => {
			setTimeout(() => {
				ctx.sendJsonToClient?.({ type: 'session_end', reason: 'deepdive_completed' });
			}, 5000);
			return { status: 'ending' };
		},
	};

	return {
		name: 'project_deepdive',
		greeting: buildOpeningGreetingPromptFromContext(context, chosenProjectName),
		knowledgeBase: createProjectDeepdiveKnowledgeBase(),
		instructions: `You are a structured technical interviewer running a deep-dive into ONE specific project from the candidate's resume: "${chosenProjectName}".

The persistent project_deepdive subagent has already chosen this project up-front and prepared four STAR-aligned anchor questions:
1. project_context
2. contribution_and_decisions
3. problems_and_failures
4. outcomes_and_metrics

Core behavior:
- Be professional, concise, and neutral.
- Ask exactly one question at a time.
- The deep-dive is scoped to "${chosenProjectName}" — do NOT pivot to a different project even if the candidate brings one up unprompted (acknowledge briefly and steer back).
- The persistent subagent owns the prepared anchor order, follow-up depth decisions, and answer state.
- Never mention internal tools, JSON, scoring, or subagents to the candidate.
- Use the attached knowledge base for resume / role / company context when answering direct questions.

Routing rules:
1. At the start, call record_answer_and_get_next_question without answerText.
2. Ask only the question text returned by the tool.
3. If the candidate is answering the active question, call record_answer_and_get_next_question with their answerText.
4. If the user asks an unrelated question or makes casual conversation, answer directly using the knowledge base when relevant, then briefly return them to the active anchor question. Do NOT call record_answer_and_get_next_question for unrelated turns.
5. If record_answer_and_get_next_question returns status "question", ask only the returned question text — whether it is a primary, clarification, follow-up, or deep-dive question.
6. Do not improvise your own follow-ups. The subagent decides when clarification or deeper probing is needed.
7. If record_answer_and_get_next_question returns status "completed", speak the returned closingMessage exactly.
8. After speaking the closingMessage, call end_session.`,
		tools: [progressInterview, endSession],
		onEnter: async () => {
			console.log('[Deepdive] Agent entered');
		},
		onExit: async () => {
			console.log('[Deepdive] Agent exited');
		},
	};
}
