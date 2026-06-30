import { describe, expect, it } from 'vitest';
import type { InterviewDocuments } from '../../examples/interviewer/lib/interview-documents.js';
import {
	buildOpeningGreetingPromptFromContext,
	createInterviewState,
	ensurePreparedWithFallback,
	extractInterviewDocumentContext,
} from '../../examples/interviewer/lib/interview-state.js';
import {
	createInterviewerAgent,
	createInterviewerKnowledgeBase,
} from '../../examples/interviewer/lib/interviewer-agent.js';
import {
	type InterviewProgressResult,
	SoftwareInterviewerSubagent,
	createSoftwareInterviewerSubagentConfig,
} from '../../examples/interviewer/lib/interviewer-subagent.js';
import type { ToolContext } from '../../src/types/tool.js';

const documents: InterviewDocuments = {
	jobDescription: '# Senior Software Engineer, Realtime Systems\n\nBuild realtime systems.',
	candidateResume: '# Maya Chen\n\nBuilt TypeScript and WebSocket systems.',
	companyIntro: '# Northstar Robotics\n\nRemote-operation software for robotics.',
};

function parseProgress(text: string): InterviewProgressResult {
	return JSON.parse(text) as InterviewProgressResult;
}

function toolContext(): ToolContext {
	return {
		toolCallId: 'tool-1',
		agentName: 'interviewer',
		sessionId: 'session-1',
		abortSignal: new AbortController().signal,
	};
}

describe('interviewer persistent subagent redesign', () => {
	it('extracts deterministic document context for greeting before the session starts', () => {
		expect(extractInterviewDocumentContext(documents)).toEqual({
			candidateName: 'Maya Chen',
			companyName: 'Northstar Robotics',
			roleTitle: 'Senior Software Engineer, Realtime Systems',
		});
	});

	it('uses safe deterministic greeting context fallbacks when headings are missing', () => {
		expect(
			extractInterviewDocumentContext({
				jobDescription: 'Build realtime systems.',
				candidateResume: 'Built TypeScript and WebSocket systems.',
				companyIntro: 'Remote-operation software for robotics.',
			}),
		).toEqual({
			candidateName: 'the candidate',
			companyName: 'the company',
			roleTitle: 'the software engineering role',
		});
	});

	it('builds an exact one-shot greeting prompt without drafting instructions', () => {
		const greeting = buildOpeningGreetingPromptFromContext({
			candidateName: 'Maya Chen',
			companyName: 'Northstar Robotics',
			roleTitle: 'Senior Software Engineer, Realtime Systems',
		});

		expect(greeting).toContain(
			'Say exactly this greeting once: "Hello Maya Chen, I\'m your software interviewer',
		);
		expect(greeting).toContain('call record_answer_and_get_next_question without answerText');
		expect(greeting).toContain('Do not repeat or summarize the greeting');
		expect(greeting).not.toContain('Greet Maya Chen by name');
		expect(greeting).not.toContain('Keep the greeting');
		expect(greeting).not.toMatch(/\bshorter\b/i);
	});

	it('configures the MainAgent with prompt-mode document knowledge and background progression', async () => {
		const agent = createInterviewerAgent(documents);

		expect(agent.greeting).toContain('Maya Chen');
		expect(agent.greeting).toContain('Northstar Robotics');
		expect(agent.greeting).toContain('Senior Software Engineer, Realtime Systems');
		expect(agent.knowledgeBase?.documents.map((doc) => doc.name)).toEqual([
			'Job Description',
			'Candidate Resume',
			'Company Intro',
		]);
		expect(agent.knowledgeBase?.documents.every((doc) => doc.mode === 'prompt')).toBe(true);

		const progressTool = agent.tools.find(
			(tool) => tool.name === 'record_answer_and_get_next_question',
		);
		expect(progressTool?.execution).toBe('background');
		expect(progressTool?.pendingMessage).toBeUndefined();

		const placeholder = await progressTool?.execute({}, toolContext());
		expect(placeholder).toEqual({
			status: 'routed',
			message: 'Routed to persistent software interviewer.',
		});
		expect(agent.tools.some((tool) => tool.name === 'get_interview_status')).toBe(false);
	});

	it('builds the interviewer knowledge base from the three mock documents', () => {
		const knowledgeBase = createInterviewerKnowledgeBase();

		expect(knowledgeBase.documents).toEqual([
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
		]);
	});

	it('creates a persistent subagent config around the same initialized interviewer instance', async () => {
		const state = createInterviewState();
		ensurePreparedWithFallback(state, documents, 'test fallback');
		const subagent = new SoftwareInterviewerSubagent(
			'record_answer_and_get_next_question',
			state,
			documents,
			{} as never,
		);

		const config = createSoftwareInterviewerSubagentConfig(subagent);
		expect(config.lifetime).toBe('persistent_session');
		expect(config.persistentFactory).toBeDefined();

		const instance = await config.persistentFactory?.(
			'record_answer_and_get_next_question',
			config,
		);
		expect(instance).toBeDefined();
		if (!instance) throw new Error('Expected persistent interviewer instance');
		expect(instance).toBe(subagent);
		const first = parseProgress(await instance.invoke('start interview', {}));

		expect(first.status).toBe('question');
		if (first.status === 'question') {
			expect(first.question.id).toBe('walk_resume');
			expect(first.questionKind).toBe('primary');
		}
		expect(state.activeQuestion?.id).toBe('walk_resume');
	});

	it('records answers and advances through the prepared interview state', async () => {
		const state = createInterviewState();
		ensurePreparedWithFallback(state, documents, 'test fallback');
		const subagent = new SoftwareInterviewerSubagent(
			'record_answer_and_get_next_question',
			state,
			documents,
			{} as never,
		);

		const first = parseProgress(await subagent.invoke('start interview', {}));
		expect(first.status).toBe('question');
		if (first.status === 'question') {
			expect(first.question.id).toBe('walk_resume');
			expect(first.questionKind).toBe('primary');
			expect(first.answersRecorded).toBe(0);
		}

		const second = parseProgress(
			await subagent.invoke('record answer', {
				answerText:
					'I led backend platform projects across developer tools, observability, and customer workflows.',
			}),
		);
		expect(second.status).toBe('question');
		if (second.status === 'question') {
			expect(second.answerRecord?.questionId).toBe('walk_resume');
			expect(second.question.id).toBe('company_interest');
			expect(second.questionKind).toBe('primary');
			expect(second.answersRecorded).toBe(1);
		}

		const third = parseProgress(
			await subagent.invoke('record answer', {
				answerText:
					'I am interested because remote robotics combines product impact with reliability-focused engineering.',
			}),
		);
		expect(third.status).toBe('question');
		if (third.status === 'question') {
			expect(third.answerRecord?.questionId).toBe('company_interest');
			expect(third.question.id).toBe('technical_challenge');
			expect(third.questionKind).toBe('primary');
			expect(third.answersRecorded).toBe(2);
		}

		const completed = parseProgress(
			await subagent.invoke('record answer', {
				answerText:
					'I diagnosed a production failure, narrowed the root cause, shipped a fix, and measured the recovery.',
			}),
		);
		expect(completed.status).toBe('completed');
		if (completed.status === 'completed') {
			expect(completed.answersRecorded).toBe(3);
			expect(completed.closingMessage).toContain('Goodbye');
			expect(completed.closingMessage).toContain('best of luck');
		}
		expect(state.phase).toBe('completed');
	});

	it('serializes concurrent invocations against the same InterviewState', async () => {
		const state = createInterviewState();
		ensurePreparedWithFallback(state, documents, 'test fallback');
		const subagent = new SoftwareInterviewerSubagent(
			'record_answer_and_get_next_question',
			state,
			documents,
			{} as never,
		);

		const [firstText, secondText] = await Promise.all([
			subagent.invoke('start interview', {}),
			subagent.invoke('record answer', {
				answerText:
					'I have seven years of experience leading backend teams and shipping production systems.',
			}),
		]);
		const first = parseProgress(firstText);
		const second = parseProgress(secondText);

		expect(first.status).toBe('question');
		if (first.status === 'question') {
			expect(first.question.id).toBe('walk_resume');
			expect(first.questionKind).toBe('primary');
		}
		expect(second.status).toBe('question');
		if (second.status === 'question') {
			expect(second.answerRecord?.questionId).toBe('walk_resume');
			expect(second.question.id).toBe('company_interest');
			expect(second.questionKind).toBe('primary');
		}
		expect(state.answers).toHaveLength(1);
	});

	it('asks a clarification question when an answer is too vague', async () => {
		const state = createInterviewState();
		ensurePreparedWithFallback(state, documents, 'test fallback');
		const subagent = new SoftwareInterviewerSubagent(
			'record_answer_and_get_next_question',
			state,
			documents,
			{} as never,
		);

		await subagent.invoke('start interview', {});
		const result = parseProgress(await subagent.invoke('record answer', { answerText: 'Yes.' }));

		expect(result.status).toBe('question');
		if (result.status === 'question') {
			expect(result.answerRecord?.questionId).toBe('walk_resume');
			expect(result.primaryQuestionId).toBe('walk_resume');
			expect(result.question.id).toBe('walk_resume');
			expect(result.questionKind).toBe('clarification');
			expect(result.question.text).toContain('specific example');
		}
		expect(state.answers).toHaveLength(1);
		expect(state.activeQuestion?.id).toBe('walk_resume');
		expect(state.activeQuestionKind).toBe('clarification');
		expect(state.dynamicQuestions).toHaveLength(1);
	});

	it('can ask a deep-dive question and then advance after the follow-up answer', async () => {
		const state = createInterviewState();
		ensurePreparedWithFallback(state, documents, 'test fallback');
		const subagent = new SoftwareInterviewerSubagent(
			'record_answer_and_get_next_question',
			state,
			documents,
			{} as never,
		);

		await subagent.invoke('start interview', {});
		const deepDive = parseProgress(
			await subagent.invoke('record answer', {
				answerText:
					'I improved WebSocket latency by redesigning backpressure handling and measuring customer disconnects.',
			}),
		);

		expect(deepDive.status).toBe('question');
		if (deepDive.status === 'question') {
			expect(deepDive.questionKind).toBe('deep_dive');
			expect(deepDive.primaryQuestionId).toBe('walk_resume');
		}

		const nextPrimary = parseProgress(
			await subagent.invoke('record answer', {
				answerText:
					'The tradeoff was buffering versus fast failure, and we validated it with staged production metrics.',
			}),
		);

		expect(nextPrimary.status).toBe('question');
		if (nextPrimary.status === 'question') {
			expect(nextPrimary.questionKind).toBe('primary');
			expect(nextPrimary.question.id).toBe('company_interest');
		}
		expect(state.answers).toHaveLength(2);
		expect(state.dynamicQuestions).toHaveLength(1);
	});

	it('can ask a targeted follow-up when motivation is too generic', async () => {
		const state = createInterviewState();
		ensurePreparedWithFallback(state, documents, 'test fallback');
		const subagent = new SoftwareInterviewerSubagent(
			'record_answer_and_get_next_question',
			state,
			documents,
			{} as never,
		);

		await subagent.invoke('start interview', {});
		await subagent.invoke('record answer', {
			answerText:
				'I led backend platform projects across developer tools, observability, and customer workflows.',
		});
		const followUp = parseProgress(
			await subagent.invoke('record answer', {
				answerText: 'It seems interesting and like a good fit for my career goals.',
			}),
		);

		expect(followUp.status).toBe('question');
		if (followUp.status === 'question') {
			expect(followUp.answerRecord?.questionId).toBe('company_interest');
			expect(followUp.primaryQuestionId).toBe('company_interest');
			expect(followUp.questionKind).toBe('follow_up');
			expect(followUp.question.text).toContain('company or role');
		}
		expect(state.activeQuestionKind).toBe('follow_up');
		expect(state.dynamicQuestions).toHaveLength(1);
	});

	it('returns a clear error when invoked with an unprepared InterviewState', async () => {
		const state = createInterviewState();
		const subagent = new SoftwareInterviewerSubagent(
			'record_answer_and_get_next_question',
			state,
			documents,
			{} as never,
		);

		const result = parseProgress(await subagent.invoke('start interview', {}));

		expect(result.status).toBe('error');
		if (result.status === 'error') {
			expect(result.recoverable).toBe(false);
			expect(result.message).toContain('InterviewState is not prepared');
		}
	});
});
