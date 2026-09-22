import { z } from 'zod';
import type { MainAgent } from '../../../src/types/agent.js';
import type { KnowledgeBaseConfig } from '../../../src/types/knowledge-base.js';
import type { ToolContext, ToolDefinition } from '../../../src/types/tool.js';
import type { InterviewDocuments } from './interview-documents.js';
import {
	buildOpeningGreetingPromptFromContext,
	extractInterviewDocumentContext,
} from './interview-state.js';

const INTERVIEWER_KNOWLEDGE_BASE_DOCUMENTS: KnowledgeBaseConfig['documents'] = [
	{
		source: 'file',
		content: 'examples/interviewer/docs/job_description.md',
		name: 'Job Description',
		mode: 'prompt',
	},
	{
		source: 'file',
		content: 'examples/interviewer/docs/candidate_resume.md',
		name: 'Candidate Resume',
		mode: 'prompt',
	},
	{
		source: 'file',
		content: 'examples/interviewer/docs/company_intro.md',
		name: 'Company Intro',
		mode: 'prompt',
	},
];

export function createInterviewerKnowledgeBase(): KnowledgeBaseConfig {
	return {
		documents: INTERVIEWER_KNOWLEDGE_BASE_DOCUMENTS,
	};
}

export function createInterviewerAgent(documents: InterviewDocuments): MainAgent {
	const documentContext = extractInterviewDocumentContext(documents);

	const progressInterview: ToolDefinition = {
		name: 'record_answer_and_get_next_question',
		description:
			'Forward interview progression to the persistent software interviewer. Use this only to start the interview or after the candidate answers the active interview question. The subagent may return a primary, clarification, follow-up, or deep-dive question. Do not use it for unrelated questions or casual conversation.',
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
			message: 'Routed to persistent software interviewer.',
		}),
	};

	const endSession: ToolDefinition = {
		name: 'end_session',
		description:
			'End the interview session after all three primary interview anchors have been completed and after you have spoken the closing goodbye message.',
		parameters: z.object({}),
		execution: 'inline',
		execute: async (_args, ctx: ToolContext) => {
			setTimeout(() => {
				ctx.sendJsonToClient?.({ type: 'session_end', reason: 'interview_completed' });
			}, 5000);
			return { status: 'ending' };
		},
	};

	return {
		name: 'interviewer',
		greeting: buildOpeningGreetingPromptFromContext(documentContext),
		knowledgeBase: createInterviewerKnowledgeBase(),
		instructions: `You are a structured software interviewer conducting a voice interview around three primary anchors.

Core behavior:
- Be professional, concise, and neutral.
- Ask exactly one interview question at a time.
- The goal is to get useful answers to the three primary anchors, not to limit the interview to exactly three spoken questions.
- The persistent software interviewer owns the prepared question order, follow-up decisions, and answer state.
- Never mention internal tools, JSON, scoring, or subagents to the candidate.
- Use the attached knowledge base for candidate, company, and role context when answering direct questions.

Routing rules:
1. At the start, call record_answer_and_get_next_question without answerText.
2. Ask only the question text returned by record_answer_and_get_next_question.
3. If the candidate is answering the active interview question, call record_answer_and_get_next_question with their answerText.
4. If the user asks an unrelated question or makes casual conversation, answer directly using the knowledge base when relevant, then briefly return them to the active interview question. Do not call record_answer_and_get_next_question for unrelated turns.
5. If record_answer_and_get_next_question returns status "question", ask only the returned question text, whether it is a primary, clarification, follow-up, or deep-dive question.
6. Do not improvise your own interview follow-ups. The software interviewer subagent decides when clarification or deeper probing is needed.
7. If record_answer_and_get_next_question returns status "completed", speak the returned closingMessage exactly.
8. After speaking the closingMessage, call end_session.`,
		tools: [progressInterview, endSession],
		onEnter: async () => {
			console.log('[Interviewer] Agent entered');
		},
		onExit: async () => {
			console.log('[Interviewer] Agent exited');
		},
	};
}
