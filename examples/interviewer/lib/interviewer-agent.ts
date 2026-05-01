// SPDX-License-Identifier: MIT

import { z } from 'zod';
import type { MainAgent } from '../../../src/types/agent.js';
import type { ToolContext, ToolDefinition } from '../../../src/types/tool.js';
import type { InterviewDocuments } from './interview-documents.js';
import {
	type InterviewState,
	buildOpeningGreetingPrompt,
	ensurePreparedWithFallback,
	getInterviewStatus,
	getNextInterviewQuestion,
	recordInterviewAnswer,
} from './interview-state.js';

export function createInterviewerAgent(
	state: InterviewState,
	documents: InterviewDocuments,
): MainAgent {
	const nextInterviewQuestion: ToolDefinition = {
		name: 'next_interview_question',
		description:
			'Return the next planned interview question in sequence. Call this after preparation and after each recorded answer.',
		parameters: z.object({}),
		execution: 'inline',
		execute: async (_args, ctx: ToolContext) => {
			ensurePreparedWithFallback(state, documents, 'next_interview_question used fallback plan');
			const result = getNextInterviewQuestion(state);
			ctx.sendJsonToClient?.({
				type: 'interview.question',
				payload: result,
			});
			return result;
		},
	};

	const recordAnswer: ToolDefinition = {
		name: 'record_interview_answer',
		description:
			'Record the candidate answer to the active interview question in the background. Immediately call next_interview_question after this tool is accepted; do not wait or speak first.',
		parameters: z.object({
			answerText: z.string().min(1).describe('The candidate answer, summarized or transcribed.'),
		}),
		execution: 'background',
		execute: async (args, ctx: ToolContext) => {
			const { answerText } = args as { answerText: string };
			const result = recordInterviewAnswer(state, answerText);
			ctx.sendJsonToClient?.({
				type: 'interview.answer_recorded',
				payload: {
					...result,
					answersRecorded: state.answers.length,
				},
			});
			return {
				...result,
				answersRecorded: state.answers.length,
			};
		},
	};

	const getStatus: ToolDefinition = {
		name: 'get_interview_status',
		description: 'Get current interview progress and prepared document metadata.',
		parameters: z.object({}),
		execution: 'inline',
		execute: async () => getInterviewStatus(state),
	};

	const endSession: ToolDefinition = {
		name: 'end_session',
		description:
			'End the interview session after all three questions have been completed and after you have spoken the closing goodbye message.',
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
		greeting: buildOpeningGreetingPrompt(state),
		instructions: `You are a structured software interviewer conducting a three-question voice interview.

Core behavior:
- Be professional, concise, and neutral.
- Ask exactly one question at a time.
- Ask the three planned primary questions in order.
- V1 has no follow-up questions. Do not improvise extra questions.
- Never mention internal tools, JSON, scoring, or subagents to the candidate.
- Use the candidate, company, and role context from the prepared interview plan.

Required tool flow:
1. At the start, call next_interview_question.
2. Ask only the question text returned by next_interview_question.
3. After the candidate answers, call record_interview_answer with their answer text.
4. Immediately call next_interview_question again. Do not speak between record_interview_answer and next_interview_question.
5. Repeat until next_interview_question returns status "completed".
6. When next_interview_question returns status "completed", speak the returned closingMessage exactly.
7. After speaking the closingMessage, call end_session.

If a tool reports an error, recover politely and continue with the fallback interview plan when available.
Do not ask dynamic follow-ups in this V1 example.`,
		tools: [nextInterviewQuestion, recordAnswer, getStatus, endSession],
		onEnter: async () => {
			console.log('[Interviewer] Agent entered');
		},
		onExit: async () => {
			console.log('[Interviewer] Agent exited');
		},
	};
}
