// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { PersistentSubagentInstance } from '../../../src/agent/persistent-subagent-types.js';
import type { SubagentConfig } from '../../../src/types/agent.js';
import type { InterviewDocuments } from './interview-documents.js';
import {
	type InterviewDynamicQuestion,
	type InterviewPlan,
	type InterviewQuestion,
	type InterviewQuestionId,
	type InterviewQuestionKind,
	type InterviewState,
	QUESTION_IDS,
	applyInterviewPlan,
	getNextInterviewQuestion,
	normalizeInterviewPlanWithDocuments,
	recordInterviewAnswer,
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

const interviewDecisionSchema = z.object({
	action: z.enum(['advance', 'clarification', 'follow_up', 'deep_dive']),
	questionText: z.string().min(1).optional(),
	rationale: z.string().min(1),
});

type InterviewDecision = z.infer<typeof interviewDecisionSchema>;
type DynamicQuestionKind = Exclude<InterviewQuestionKind, 'primary'>;
const MAX_DYNAMIC_QUESTIONS_PER_PRIMARY = 2;
type SubagentProviderOptions = NonNullable<Parameters<typeof generateObject>[0]['providerOptions']>;

export function createLowReasoningSubagentProviderOptions(
	thinkingBudget: number,
): SubagentProviderOptions {
	return {
		google: {
			thinkingConfig: {
				thinkingBudget,
				includeThoughts: false,
			},
		},
	};
}

function logSubagentDebug(message: string): void {
	const t = new Date().toISOString().slice(11, 23);
	console.log(`${t} [InterviewerSubagent] ${message}`);
}

function logSubagentStep(traceId: string, step: string, startedAt: number, details?: string): void {
	const suffix = details ? ` ${details}` : '';
	logSubagentDebug(`${traceId} step=${step} duration=${Date.now() - startedAt}ms${suffix}`);
}

function objectKeys(value: unknown): string {
	if (!value || typeof value !== 'object') return 'none';
	return Object.keys(value).join(',') || 'none';
}

function modelLabel(model: LanguageModelV1): string {
	return (
		(model as { modelId?: string; model?: string }).modelId ??
		(model as { modelId?: string; model?: string }).model ??
		'unknown'
	);
}

function thinkingBudgetLabel(providerOptions: SubagentProviderOptions): string {
	const googleOptions = providerOptions.google;
	if (!googleOptions || typeof googleOptions !== 'object') return 'default';
	const thinkingConfig = googleOptions.thinkingConfig;
	if (!thinkingConfig || typeof thinkingConfig !== 'object' || Array.isArray(thinkingConfig))
		return 'default';
	const thinkingBudget = thinkingConfig.thinkingBudget;
	return typeof thinkingBudget === 'number' ? String(thinkingBudget) : 'default';
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export type InterviewProgressResult =
	| {
			status: 'question';
			question: InterviewQuestion;
			questionKind: InterviewQuestionKind;
			primaryQuestionId: InterviewQuestionId;
			questionNumber: number;
			totalQuestions: number;
			answersRecorded: number;
			rationale?: string;
			answerRecord?: {
				status: 'recorded';
				questionId: InterviewQuestionId;
				message: string;
			};
	  }
	| {
			status: 'completed';
			totalQuestions: number;
			answersRecorded: number;
			closingMessage: string;
	  }
	| {
			status: 'error';
			message: string;
			recoverable: boolean;
	  };

export function createSoftwareInterviewerSubagentConfig(
	subagent: SoftwareInterviewerSubagent,
): SubagentConfig {
	return {
		name: 'software_interviewer',
		instructions: 'Runtime-managed persistent software interviewer.',
		tools: {},
		lifetime: 'persistent_session',
		reasoningModel: subagent.reasoningModel,
		persistentFactory: async () => subagent,
	};
}

export class SoftwareInterviewerSubagent implements PersistentSubagentInstance {
	private disposed = false;
	private queue: Promise<void> = Promise.resolve();
	private prepareSequence = 0;
	private invokeSequence = 0;

	constructor(
		readonly key: string,
		private readonly state: InterviewState,
		private readonly documents: InterviewDocuments,
		readonly reasoningModel: LanguageModelV1,
		private readonly providerOptions: SubagentProviderOptions = {},
	) {}

	async prepare(): Promise<void> {
		if (this.disposed) {
			throw new Error(`Software interviewer "${this.key}" is disposed.`);
		}

		const startedAt = Date.now();
		const traceId = `prepare#${++this.prepareSequence}`;
		logSubagentDebug(
			`${traceId} start key=${this.key} model=${modelLabel(this.reasoningModel)} thinkingBudget=${thinkingBudgetLabel(this.providerOptions)}`,
		);
		const buildPromptStartedAt = Date.now();
		const system = buildSoftwareInterviewerInstructions(this.documents);
		const prompt =
			'Prepare the interview now. Return the document digest and three-primary-anchor interview plan.';
		logSubagentStep(
			traceId,
			'build_prepare_prompt',
			buildPromptStartedAt,
			`systemChars=${system.length} promptChars=${prompt.length}`,
		);
		const generateStartedAt = Date.now();
		logSubagentDebug(`${traceId} step=prepare_generate_object.start mode=json`);
		const { object } = await generateObject({
			model: this.reasoningModel,
			system,
			prompt,
			providerOptions: this.providerOptions,
			schema: interviewPlanSchema,
			schemaName: 'interview_plan',
			schemaDescription:
				'Document digest and exactly three primary interview anchors for a software interview.',
			mode: 'json',
		});
		logSubagentStep(
			traceId,
			'prepare_generate_object.end',
			generateStartedAt,
			`objectKeys=${objectKeys(object)}`,
		);
		const normalizeStartedAt = Date.now();
		const normalized = normalizeInterviewPlanWithDocuments(object as InterviewPlan, this.documents);
		logSubagentStep(
			traceId,
			'normalize_plan',
			normalizeStartedAt,
			`questions=${normalized.questions.length}`,
		);
		const applyStartedAt = Date.now();
		applyInterviewPlan(this.state, normalized);
		logSubagentStep(
			traceId,
			'apply_plan',
			applyStartedAt,
			`phase=${this.state.phase} company="${normalized.digest.companyName}"`,
		);
		logSubagentStep(traceId, 'prepare_total', startedAt);
	}

	async invoke(
		_taskDescription: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		if (this.disposed) {
			throw new Error(`Persistent software interviewer "${this.key}" is disposed.`);
		}

		const queuedAt = Date.now();
		const traceId = `invoke#${++this.invokeSequence}`;
		const hasAnswer = typeof args.answerText === 'string' && args.answerText.trim().length > 0;
		logSubagentDebug(
			`${traceId} queued key=${this.key} hasAnswer=${hasAnswer} phase=${this.state.phase} active=${this.state.activeQuestion?.id ?? 'none'} argsKeys=${Object.keys(args).join(',') || 'none'}`,
		);
		const run = this.queue.then(() => {
			logSubagentDebug(
				`${traceId} lock acquired key=${this.key} queueWait=${Date.now() - queuedAt}ms`,
			);
			return this.invokeLocked(traceId, args, signal, queuedAt);
		});
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}

	private async invokeLocked(
		traceId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		queuedAt?: number,
	): Promise<string> {
		const startedAt = Date.now();
		logSubagentDebug(
			`${traceId} start key=${this.key} queueWait=${queuedAt ? startedAt - queuedAt : 0}ms phase=${this.state.phase} active=${this.state.activeQuestion?.id ?? 'none'} nextIndex=${this.state.nextQuestionIndex}`,
		);
		if (signal?.aborted) {
			throw new Error('Persistent software interviewer invocation was aborted.');
		}

		const validationStartedAt = Date.now();
		const preparedError = this.getPreparedStateError();
		logSubagentStep(
			traceId,
			'validate_prepared_state',
			validationStartedAt,
			preparedError ? 'status=error' : 'status=ok',
		);
		if (preparedError) {
			return this.serialize(
				{
					status: 'error',
					message: preparedError,
					recoverable: false,
				},
				traceId,
				startedAt,
			);
		}

		const parseArgsStartedAt = Date.now();
		const answerText = typeof args.answerText === 'string' ? args.answerText : undefined;
		logSubagentStep(
			traceId,
			'parse_args',
			parseArgsStartedAt,
			`answerChars=${answerText?.trim().length ?? 0}`,
		);

		if (this.state.phase === 'completed') {
			const nextStartedAt = Date.now();
			const closing = getNextInterviewQuestion(this.state);
			logSubagentStep(traceId, 'get_completed_state', nextStartedAt);
			return this.serialize(
				{
					status: 'completed',
					totalQuestions: closing.totalQuestions,
					answersRecorded: this.state.answers.length,
					closingMessage: closing.closingMessage ?? closing.message,
				},
				traceId,
				startedAt,
			);
		}

		if (!this.state.activeQuestion && answerText?.trim()) {
			return this.serialize(
				{
					status: 'error',
					message: 'No active interview question is waiting for an answer.',
					recoverable: true,
				},
				traceId,
				startedAt,
			);
		}

		let answerRecord:
			| {
					status: 'recorded';
					questionId: InterviewQuestionId;
					message: string;
			  }
			| undefined;
		let answeredQuestion: InterviewQuestion | undefined;

		if (this.state.activeQuestion) {
			answeredQuestion = this.state.activeQuestion;
			const recordStartedAt = Date.now();
			const record = recordInterviewAnswer(this.state, answerText ?? '');
			logSubagentStep(
				traceId,
				'record_answer',
				recordStartedAt,
				`question=${answeredQuestion.id} status=${record.status} answerChars=${answerText?.trim().length ?? 0} answers=${this.state.answers.length}`,
			);
			if (record.status === 'error') {
				return this.serialize(
					{
						status: 'error',
						message:
							record.message === 'Answer text is empty.'
								? 'answerText is required after a question has been asked.'
								: record.message,
						recoverable: true,
					},
					traceId,
					startedAt,
				);
			}
			answerRecord = {
				status: 'recorded',
				questionId: record.questionId as InterviewQuestionId,
				message: record.message,
			};
		}

		if (answeredQuestion && answerText) {
			const decision = await this.decideAfterAnswer(traceId, answeredQuestion, answerText);
			if (decision.action !== 'advance') {
				const dynamicStartedAt = Date.now();
				const dynamicQuestion = this.createDynamicQuestion(answeredQuestion, decision);
				this.state.activeQuestion = dynamicQuestion.question;
				this.state.activeQuestionKind = dynamicQuestion.kind;
				this.state.phase = 'questioning';
				this.state.dynamicQuestions.push(dynamicQuestion.auditRecord);
				this.state.dynamicQuestionCounts[answeredQuestion.id] =
					(this.state.dynamicQuestionCounts[answeredQuestion.id] ?? 0) + 1;
				logSubagentStep(
					traceId,
					'create_dynamic_question',
					dynamicStartedAt,
					`kind=${dynamicQuestion.kind} anchor=${answeredQuestion.id} dynamicCount=${this.state.dynamicQuestionCounts[answeredQuestion.id]}`,
				);

				return this.serialize(
					{
						status: 'question',
						question: dynamicQuestion.question,
						questionKind: dynamicQuestion.kind,
						primaryQuestionId: answeredQuestion.id,
						questionNumber: this.state.nextQuestionIndex,
						totalQuestions: this.state.questions.length,
						answersRecorded: this.state.answers.length,
						rationale: decision.rationale,
						...(answerRecord ? { answerRecord } : {}),
					},
					traceId,
					startedAt,
				);
			}
		}

		const nextStartedAt = Date.now();
		const next = getNextInterviewQuestion(this.state);
		logSubagentStep(
			traceId,
			'get_next_primary_question',
			nextStartedAt,
			`status=${next.status} nextIndex=${this.state.nextQuestionIndex} active=${this.state.activeQuestion?.id ?? 'none'}`,
		);
		if (next.status === 'completed') {
			return this.serialize(
				{
					status: 'completed',
					totalQuestions: next.totalQuestions,
					answersRecorded: this.state.answers.length,
					closingMessage: next.closingMessage ?? next.message,
				},
				traceId,
				startedAt,
			);
		}

		return this.serialize(
			{
				status: 'question',
				question: next.question as InterviewQuestion,
				questionKind: 'primary',
				primaryQuestionId: (next.question as InterviewQuestion).id,
				questionNumber: next.questionNumber as number,
				totalQuestions: next.totalQuestions,
				answersRecorded: this.state.answers.length,
				...(answerRecord ? { answerRecord } : {}),
			},
			traceId,
			startedAt,
		);
	}

	private getPreparedStateError(): string | undefined {
		if (this.state.questions.length !== QUESTION_IDS.length) {
			return [
				'InterviewState is not prepared.',
				`Expected ${QUESTION_IDS.length} questions but found ${this.state.questions.length}.`,
				'Prepare the interview plan before starting the voice session.',
			].join(' ');
		}
		if (!this.state.documentDigest || !this.state.companyName || !this.state.roleTitle) {
			return 'InterviewState is missing document metadata. Prepare the interview plan before starting the voice session.';
		}
		return undefined;
	}

	private async decideAfterAnswer(
		traceId: string,
		answeredQuestion: InterviewQuestion,
		answerText: string,
	): Promise<InterviewDecision> {
		const startedAt = Date.now();
		const lookupStartedAt = Date.now();
		const dynamicCount = this.state.dynamicQuestionCounts[answeredQuestion.id] ?? 0;
		logSubagentStep(
			traceId,
			'decision_budget_lookup',
			lookupStartedAt,
			`anchor=${answeredQuestion.id} dynamicCount=${dynamicCount}`,
		);
		if (dynamicCount >= MAX_DYNAMIC_QUESTIONS_PER_PRIMARY) {
			logSubagentStep(
				traceId,
				'decision_skip_max_dynamic',
				startedAt,
				`anchor=${answeredQuestion.id} dynamicCount=${dynamicCount}`,
			);
			return {
				action: 'advance',
				rationale: 'Maximum dynamic questions for this interview anchor reached.',
			};
		}

		try {
			const promptStartedAt = Date.now();
			const system = buildInterviewLeaderInstructions(this.documents);
			const prompt = this.buildDecisionPrompt(answeredQuestion, answerText, dynamicCount);
			logSubagentStep(
				traceId,
				'build_decision_prompt',
				promptStartedAt,
				`systemChars=${system.length} promptChars=${prompt.length}`,
			);
			const generateStartedAt = Date.now();
			logSubagentDebug(
				`${traceId} step=decision_generate_object.start anchor=${answeredQuestion.id} dynamicCount=${dynamicCount} answerChars=${answerText.trim().length} mode=json thinkingBudget=${thinkingBudgetLabel(this.providerOptions)}`,
			);
			const { object } = await generateObject({
				model: this.reasoningModel,
				system,
				prompt,
				providerOptions: this.providerOptions,
				schema: interviewDecisionSchema,
				schemaName: 'interview_decision',
				schemaDescription:
					'Decision to advance or ask one clarification, follow-up, or deep-dive question.',
				mode: 'json',
			});
			logSubagentStep(
				traceId,
				'decision_generate_object.end',
				generateStartedAt,
				`objectKeys=${objectKeys(object)}`,
			);
			const normalizeStartedAt = Date.now();
			const decision = normalizeDecision(object as InterviewDecision, answeredQuestion);
			logSubagentStep(
				traceId,
				'normalize_decision',
				normalizeStartedAt,
				`action=${decision.action}`,
			);
			logSubagentStep(traceId, 'decision_total', startedAt, `action=${decision.action}`);
			return decision;
		} catch (err) {
			// Keep local tests and demos deterministic when no reasoning model is available.
			logSubagentStep(
				traceId,
				'decision_generate_object.failed',
				startedAt,
				`anchor=${answeredQuestion.id} fallback=true error="${errorMessage(err)}"`,
			);
		}

		const fallbackStartedAt = Date.now();
		const decision = fallbackDecision(answeredQuestion, answerText, dynamicCount);
		logSubagentStep(
			traceId,
			'fallback_decision',
			fallbackStartedAt,
			`anchor=${answeredQuestion.id} action=${decision.action}`,
		);
		logSubagentStep(traceId, 'decision_total', startedAt, `action=${decision.action}`);
		return decision;
	}

	private buildDecisionPrompt(
		answeredQuestion: InterviewQuestion,
		answerText: string,
		dynamicCount: number,
	): string {
		const answersForAnchor = this.state.answers
			.filter((answer) => answer.questionId === answeredQuestion.id)
			.map((answer, index) => `${index + 1}. Q: ${answer.questionText}\nA: ${answer.answerText}`)
			.join('\n\n');
		const remainingAnchors = this.state.questions
			.slice(this.state.nextQuestionIndex)
			.map((question) => `- ${question.id}: ${question.text}`)
			.join('\n');

		return `Evaluate the latest answer and choose the next interviewer move.

Current primary interview anchor:
- id: ${answeredQuestion.id}
- question: ${answeredQuestion.text}
- rationale: ${answeredQuestion.rationale}

Latest answer:
${answerText}

Answers already collected for this anchor:
${answersForAnchor || 'None'}

Dynamic questions already asked for this anchor: ${dynamicCount}/${MAX_DYNAMIC_QUESTIONS_PER_PRIMARY}

Remaining primary anchors:
${remainingAnchors || 'None'}

Decision rules:
- action "advance": use only when the candidate gave enough signal for this primary anchor.
- action "clarification": use when the answer is ambiguous, too short, off-topic, or unclear.
- action "follow_up": use when one additional targeted question would materially improve the answer.
- action "deep_dive": use when the answer mentions a technical topic worth probing for depth.
- If action is not "advance", provide questionText as a concise spoken interviewer question under 28 words.
- Do not introduce a new interview category; every dynamic question must help answer the current primary anchor.
- Return exactly one decision object.`;
	}

	private createDynamicQuestion(
		answeredQuestion: InterviewQuestion,
		decision: InterviewDecision,
	): {
		question: InterviewQuestion;
		kind: DynamicQuestionKind;
		auditRecord: InterviewDynamicQuestion;
	} {
		const kind = decision.action as DynamicQuestionKind;
		const text = decision.questionText?.trim() || fallbackDynamicQuestionText(answeredQuestion);
		const question = {
			...answeredQuestion,
			text,
			rationale: decision.rationale,
		};
		return {
			question,
			kind,
			auditRecord: {
				primaryQuestionId: answeredQuestion.id,
				kind,
				text,
				rationale: decision.rationale,
				timestamp: Date.now(),
			},
		};
	}

	private serialize(
		result: InterviewProgressResult,
		traceId: string,
		invokeStartedAt: number,
	): string {
		const serializeStartedAt = Date.now();
		const text = JSON.stringify(result);
		logSubagentStep(
			traceId,
			'serialize_result',
			serializeStartedAt,
			`status=${result.status} chars=${text.length}`,
		);
		logSubagentStep(
			traceId,
			'invoke_total',
			invokeStartedAt,
			`status=${result.status} phase=${this.state.phase} active=${this.state.activeQuestion?.id ?? 'none'} answers=${this.state.answers.length}`,
		);
		return text;
	}
}

function buildSoftwareInterviewerInstructions(documents: InterviewDocuments): string {
	return `You are the software_interviewer subagent for a voice interview.

Your first job is to process the provided documents and return a structured interview plan containing the document digest and three primary interview anchors.

Hard requirements:
- Generate exactly three primary interview anchors.
- Use these question IDs in this exact order:
  1. walk_resume
  2. company_interest
  3. technical_challenge
- Question 1 must ask the candidate to tell me about themselves or walk through their resume.
- Question 2 must ask why they want to work for the company named in the company intro.
- Question 3 must ask about a challenging technical problem they solved.
- Extract the candidate name from the candidate resume, the company name from the company intro, and the role title from the job description.
- Use those extracted document values exactly in the saved digest and questions.
- Never use placeholders such as "the company", "[Company]", or "the role" in saved digest or questions.
- Keep digest arrays compact: at most 6 resume highlights, 6 company highlights, 8 technologies, 6 alignment notes, and 3 source refs per question.
- Keep each question concise and natural for voice, ideally under 28 words.
- These three primary anchors are required, but they are not the whole interview. During the live interview, you may ask concise clarification, follow-up, and deep-dive questions to get useful answers to these anchors.

# Job Description
${documents.jobDescription}

# Candidate Resume
${documents.candidateResume}

# Company Intro
${documents.companyIntro}`;
}

function buildInterviewLeaderInstructions(documents: InterviewDocuments): string {
	return `You are the persistent software_interviewer subagent leading a voice interview.

Your goal is to get useful answers to the three prepared interview anchors:
1. walk_resume
2. company_interest
3. technical_challenge

You do not speak directly to the candidate. You decide what the MainAgent should ask next.

Behavior:
- Advance when the current answer gives enough signal for the current anchor.
- Ask a clarification when the answer is too short, vague, off-topic, or ambiguous.
- Ask a follow-up when one targeted question would make the answer more useful.
- Ask a deep-dive when the candidate mentions a technical system, tradeoff, failure, metric, or architecture that deserves depth.
- Keep dynamic questions concise and voice-natural, ideally under 28 words.
- Do not ask unrelated behavioral categories. Dynamic questions must serve the current anchor.
- Do not exceed the dynamic-question budget given in the task prompt.

# Job Description
${documents.jobDescription}

# Candidate Resume
${documents.candidateResume}

# Company Intro
${documents.companyIntro}`;
}

function normalizeDecision(
	decision: InterviewDecision,
	answeredQuestion: InterviewQuestion,
): InterviewDecision {
	if (decision.action === 'advance') {
		return { action: 'advance', rationale: decision.rationale };
	}

	return {
		...decision,
		questionText: decision.questionText?.trim() || fallbackDynamicQuestionText(answeredQuestion),
	};
}

function fallbackDecision(
	answeredQuestion: InterviewQuestion,
	answerText: string,
	dynamicCount: number,
): InterviewDecision {
	const normalized = answerText.trim().toLowerCase();
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;
	if (
		dynamicCount === 0 &&
		(wordCount < 8 ||
			/\b(i don't know|not sure|nothing much|no idea|maybe|yes|no|ok|okay)\b/.test(normalized))
	) {
		return {
			action: 'clarification',
			questionText: fallbackDynamicQuestionText(answeredQuestion),
			rationale: 'The answer was too short or unclear to satisfy the current interview anchor.',
		};
	}

	if (
		dynamicCount === 0 &&
		answeredQuestion.id === 'company_interest' &&
		/\b(interesting|exciting|good fit|great fit|opportunity|career goals?|looks good)\b/.test(
			normalized,
		) &&
		!/\b(northstar|robotics|remote[- ]operation|realtime|real-time|control|safety|warehouse|field robotics)\b/.test(
			normalized,
		)
	) {
		return {
			action: 'follow_up',
			questionText: fallbackDynamicQuestionText(answeredQuestion),
			rationale:
				'The answer gave general motivation but did not connect it to the company or role.',
		};
	}

	if (
		dynamicCount === 0 &&
		/\b(architecture|latency|scaling|incident|outage|tradeoff|websocket|webrtc|distributed|migration|backpressure)\b/.test(
			normalized,
		)
	) {
		return {
			action: 'deep_dive',
			questionText:
				'Can you go one level deeper on the key technical tradeoff and how you validated the result?',
			rationale: 'The answer mentioned a technical area worth probing for engineering depth.',
		};
	}

	return {
		action: 'advance',
		rationale: 'The answer provides enough signal to continue to the next interview anchor.',
	};
}

function fallbackDynamicQuestionText(answeredQuestion: InterviewQuestion): string {
	switch (answeredQuestion.id) {
		case 'walk_resume':
			return 'Could you add one specific example from your recent work that best shows your impact?';
		case 'company_interest':
			return 'Could you connect that interest to something specific about this company or role?';
		case 'technical_challenge':
			return 'Could you describe the technical constraint that made the problem difficult?';
	}
}
