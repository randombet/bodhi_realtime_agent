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
	const progressInterview: ToolDefinition = {
		name: 'record_answer_and_get_next_question',
		description:
			'Advance the interview in one step. At the start, call without answerText to get the first question. After each candidate answer, pass answerText; the tool records it and returns the next question or closing.',
		parameters: z.object({
			answerText: z
				.string()
				.min(1)
				.optional()
				.describe('The candidate answer, summarized or transcribed. Omit only for the first call.'),
		}),
		execution: 'inline',
		execute: async (args, ctx: ToolContext) => {
			ensurePreparedWithFallback(
				state,
				documents,
				'record_answer_and_get_next_question used fallback plan',
			);

			const { answerText } = args as { answerText?: string };
			const answerRecord = state.activeQuestion
				? recordInterviewAnswer(state, answerText ?? '')
				: undefined;

			if (answerRecord?.status === 'error') {
				return {
					status: 'error',
					answerRecord,
					message:
						answerRecord.message === 'Answer text is empty.'
							? 'answerText is required after a question has been asked.'
							: answerRecord.message,
				};
			}

			if (answerRecord) {
				queueAnswerRecordedNotification(ctx, answerRecord, state.answers.length);
			}

			const next = getNextInterviewQuestion(state);
			const result = {
				...next,
				answerRecord,
				answersRecorded: state.answers.length,
			};
			ctx.sendJsonToClient?.({
				type: 'interview.question',
				payload: result,
			});
			return result;
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
1. At the start, call record_answer_and_get_next_question without answerText.
2. Ask only the question text returned by record_answer_and_get_next_question.
3. After the candidate answers, call record_answer_and_get_next_question with their answerText.
4. If record_answer_and_get_next_question returns status "question", ask only the returned question text.
5. Repeat until record_answer_and_get_next_question returns status "completed".
6. When record_answer_and_get_next_question returns status "completed", speak the returned closingMessage exactly.
7. After speaking the closingMessage, call end_session.

If a tool reports an error, recover politely and continue with the fallback interview plan when available.
Do not ask dynamic follow-ups in this V1 example.`,
		tools: [progressInterview, getStatus, endSession],
		onEnter: async () => {
			console.log('[Interviewer] Agent entered');
		},
		onExit: async () => {
			console.log('[Interviewer] Agent exited');
		},
	};
}

function queueAnswerRecordedNotification(
	ctx: ToolContext,
	result: ReturnType<typeof recordInterviewAnswer>,
	answersRecorded: number,
): void {
	queueMicrotask(() => {
		ctx.sendJsonToClient?.({
			type: 'interview.answer_recorded',
			payload: {
				...result,
				answersRecorded,
			},
		});
	});
}
