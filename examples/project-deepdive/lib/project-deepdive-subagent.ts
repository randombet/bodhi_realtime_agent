import type { LanguageModelV1 } from 'ai';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { PersistentSubagentInstance } from '../../../src/agent/persistent-subagent-types.js';
import type { SubagentConfig } from '../../../src/types/agent.js';
import {
	ANCHOR_IDS,
	type AnchorAnswer,
	type AnchorId,
	type AnchorQuestion,
	type AnchorQuestionKind,
	type DynamicQuestion,
	type ProjectDeepdivePlan,
	type ProjectDeepdiveState,
	applyDeepdivePlan,
	extractProjectContext,
	getNextAnchorQuestion,
	normalizeDeepdivePlanWithDocuments,
	recordAnchorAnswer,
} from './project-deepdive-state.js';
import type { ProjectDocuments } from './project-documents.js';

const anchorIdSchema = z.enum(ANCHOR_IDS);

const projectDeepdivePlanSchema = z.object({
	digest: z.object({
		candidateName: z.string().min(1),
		projectName: z.string().min(1),
		projectSummary: z.string().min(1),
		candidateRole: z.string().min(1),
		technologies: z.array(z.string().min(1)).min(1),
		selectionRationale: z.string().min(1),
	}),
	questions: z
		.array(
			z.object({
				id: anchorIdSchema,
				text: z.string().min(1),
				rationale: z.string().min(1),
				sourceRefs: z.array(z.string().min(1)).min(1),
			}),
		)
		.length(4),
});

const deepdiveDecisionSchema = z.object({
	action: z.enum(['advance', 'clarification', 'follow_up', 'deep_dive']),
	questionText: z.string().min(1).optional(),
	rationale: z.string().min(1),
});

type DeepdiveDecision = z.infer<typeof deepdiveDecisionSchema>;
type DynamicQuestionKind = Exclude<AnchorQuestionKind, 'primary'>;

/**
 * Deep-dive anchors deserve more probing than the generic interviewer's
 * anchors — bumped from 2 → 3 dynamic questions per primary anchor.
 */
const MAX_DYNAMIC_QUESTIONS_PER_PRIMARY = 3;

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
	console.log(`${t} [DeepdiveSubagent] ${message}`);
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
	const thinkingConfig = (googleOptions as Record<string, unknown>).thinkingConfig;
	if (!thinkingConfig || typeof thinkingConfig !== 'object') return 'default';
	const thinkingBudget = (thinkingConfig as Record<string, unknown>).thinkingBudget;
	return typeof thinkingBudget === 'number' ? String(thinkingBudget) : 'default';
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export type DeepdiveProgressResult =
	| {
			status: 'question';
			question: AnchorQuestion;
			questionKind: AnchorQuestionKind;
			primaryAnchorId: AnchorId;
			questionNumber: number;
			totalQuestions: number;
			answersRecorded: number;
			rationale?: string;
			answerRecord?: {
				status: 'recorded';
				anchorId: AnchorId;
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

export function createProjectDeepdiveSubagentConfig(
	subagent: ProjectDeepdiveSubagent,
): SubagentConfig {
	return {
		name: 'project_deepdive',
		instructions: 'Runtime-managed persistent project deep-dive interviewer.',
		tools: {},
		lifetime: 'persistent_session',
		reasoningModel: subagent.reasoningModel,
		persistentFactory: async () => subagent,
	};
}

/**
 * Persistent subagent that picks ONE project from the candidate's resume
 * up-front and runs a STAR-aligned deep-dive across four anchors:
 * project_context → contribution_and_decisions → problems_and_failures →
 * outcomes_and_metrics. Mirrors `SoftwareInterviewerSubagent` from the
 * interviewer demo; differences are scoped to:
 *
 * - Plan schema (single chosen project, not a 3-anchor whole-resume sweep).
 * - System instructions (probe depth bias toward `deep_dive` over
 *   `clarification` for technical anchors).
 * - Higher dynamic-question budget per anchor (3 vs 2).
 */
export class ProjectDeepdiveSubagent implements PersistentSubagentInstance {
	private disposed = false;
	private queue: Promise<void> = Promise.resolve();
	private prepareSequence = 0;
	private invokeSequence = 0;

	constructor(
		readonly key: string,
		private readonly state: ProjectDeepdiveState,
		private readonly documents: ProjectDocuments,
		readonly reasoningModel: LanguageModelV1,
		private readonly providerOptions: SubagentProviderOptions = {},
	) {}

	async prepare(): Promise<void> {
		if (this.disposed) {
			throw new Error(`Project deepdive subagent "${this.key}" is disposed.`);
		}

		const startedAt = Date.now();
		const traceId = `prepare#${++this.prepareSequence}`;
		logSubagentDebug(
			`${traceId} start key=${this.key} model=${modelLabel(this.reasoningModel)} thinkingBudget=${thinkingBudgetLabel(this.providerOptions)}`,
		);
		const buildPromptStartedAt = Date.now();
		const system = buildDeepdivePlannerInstructions(this.documents);
		const prompt =
			'Pick ONE project from the resume that has the highest signal opportunity, then return the project digest and four STAR-aligned anchor questions specific to that project.';
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
			schema: projectDeepdivePlanSchema,
			schemaName: 'project_deepdive_plan',
			schemaDescription:
				'Project digest (one chosen project) and exactly four STAR-aligned anchor questions for the deep-dive.',
			mode: 'json',
		});
		logSubagentStep(
			traceId,
			'prepare_generate_object.end',
			generateStartedAt,
			`objectKeys=${objectKeys(object)}`,
		);
		const normalizeStartedAt = Date.now();
		const normalized = normalizeDeepdivePlanWithDocuments(
			object as ProjectDeepdivePlan,
			this.documents,
		);
		logSubagentStep(
			traceId,
			'normalize_plan',
			normalizeStartedAt,
			`questions=${normalized.questions.length} project="${normalized.digest.projectName}"`,
		);
		const applyStartedAt = Date.now();
		const context = extractProjectContext(this.documents);
		applyDeepdivePlan(this.state, normalized, context);
		logSubagentStep(
			traceId,
			'apply_plan',
			applyStartedAt,
			`phase=${this.state.phase} project="${normalized.digest.projectName}"`,
		);
		logSubagentStep(traceId, 'prepare_total', startedAt);
	}

	async invoke(
		_taskDescription: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		if (this.disposed) {
			throw new Error(`Persistent project deepdive subagent "${this.key}" is disposed.`);
		}

		const queuedAt = Date.now();
		const traceId = `invoke#${++this.invokeSequence}`;
		const hasAnswer = typeof args.answerText === 'string' && args.answerText.trim().length > 0;
		logSubagentDebug(
			`${traceId} queued key=${this.key} hasAnswer=${hasAnswer} phase=${this.state.phase} active=${this.state.activeQuestion?.id ?? 'none'}`,
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
			throw new Error('Persistent project deepdive subagent invocation was aborted.');
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
			const closing = getNextAnchorQuestion(this.state);
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
					message: 'No active anchor question is waiting for an answer.',
					recoverable: true,
				},
				traceId,
				startedAt,
			);
		}

		let answerRecord:
			| {
					status: 'recorded';
					anchorId: AnchorId;
					message: string;
			  }
			| undefined;
		let answeredQuestion: AnchorQuestion | undefined;

		if (this.state.activeQuestion) {
			answeredQuestion = this.state.activeQuestion;
			const recordStartedAt = Date.now();
			const record = recordAnchorAnswer(this.state, answerText ?? '');
			logSubagentStep(
				traceId,
				'record_answer',
				recordStartedAt,
				`anchor=${answeredQuestion.id} status=${record.status} answerChars=${answerText?.trim().length ?? 0} answers=${this.state.answers.length}`,
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
				anchorId: record.anchorId as AnchorId,
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
						primaryAnchorId: answeredQuestion.id,
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
		const next = getNextAnchorQuestion(this.state);
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
				question: next.question as AnchorQuestion,
				questionKind: 'primary',
				primaryAnchorId: (next.question as AnchorQuestion).id,
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
		if (this.state.questions.length !== ANCHOR_IDS.length) {
			return [
				'ProjectDeepdiveState is not prepared.',
				`Expected ${ANCHOR_IDS.length} anchor questions but found ${this.state.questions.length}.`,
				'Prepare the deep-dive plan before starting the voice session.',
			].join(' ');
		}
		if (!this.state.projectDigest || !this.state.companyName || !this.state.roleTitle) {
			return 'ProjectDeepdiveState is missing project / role metadata. Prepare the plan before starting the voice session.';
		}
		return undefined;
	}

	private async decideAfterAnswer(
		traceId: string,
		answeredQuestion: AnchorQuestion,
		answerText: string,
	): Promise<DeepdiveDecision> {
		const startedAt = Date.now();
		const dynamicCount = this.state.dynamicQuestionCounts[answeredQuestion.id] ?? 0;
		logSubagentStep(
			traceId,
			'decision_budget_lookup',
			startedAt,
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
				rationale: 'Maximum dynamic questions for this STAR anchor reached.',
			};
		}

		try {
			const promptStartedAt = Date.now();
			const system = buildDeepdiveLeaderInstructions(this.documents, this.state);
			const prompt = this.buildDecisionPrompt(answeredQuestion, answerText, dynamicCount);
			logSubagentStep(
				traceId,
				'build_decision_prompt',
				promptStartedAt,
				`systemChars=${system.length} promptChars=${prompt.length}`,
			);
			const generateStartedAt = Date.now();
			const { object } = await generateObject({
				model: this.reasoningModel,
				system,
				prompt,
				providerOptions: this.providerOptions,
				schema: deepdiveDecisionSchema,
				schemaName: 'project_deepdive_decision',
				schemaDescription:
					'Decision to advance or ask one clarification, follow-up, or deep-dive question for the active STAR anchor.',
				mode: 'json',
			});
			logSubagentStep(
				traceId,
				'decision_generate_object.end',
				generateStartedAt,
				`objectKeys=${objectKeys(object)}`,
			);
			const decision = normalizeDecision(object as DeepdiveDecision, answeredQuestion);
			logSubagentStep(traceId, 'decision_total', startedAt, `action=${decision.action}`);
			return decision;
		} catch (err) {
			logSubagentStep(
				traceId,
				'decision_generate_object.failed',
				startedAt,
				`anchor=${answeredQuestion.id} fallback=true error="${errorMessage(err)}"`,
			);
		}

		const decision = fallbackDecision(answeredQuestion, answerText, dynamicCount);
		logSubagentStep(traceId, 'fallback_decision', startedAt, `action=${decision.action}`);
		return decision;
	}

	private buildDecisionPrompt(
		answeredQuestion: AnchorQuestion,
		answerText: string,
		dynamicCount: number,
	): string {
		const projectName = this.state.projectName ?? 'the project';
		const answersForAnchor = this.state.answers
			.filter((answer: AnchorAnswer) => answer.anchorId === answeredQuestion.id)
			.map((answer, index) => `${index + 1}. Q: ${answer.questionText}\nA: ${answer.answerText}`)
			.join('\n\n');
		const dynamicForAnchor = this.state.dynamicQuestions
			.filter((q: DynamicQuestion) => q.primaryAnchorId === answeredQuestion.id)
			.map((q, i) => `${i + 1}. (${q.kind}) ${q.text}`)
			.join('\n');
		const remainingAnchors = this.state.questions
			.slice(this.state.nextQuestionIndex)
			.map((question) => `- ${question.id}: ${question.text}`)
			.join('\n');

		return `Evaluate the candidate's latest answer about the project "${projectName}" and choose the next interviewer move.

Current STAR anchor:
- id: ${answeredQuestion.id}
- question: ${answeredQuestion.text}
- rationale: ${answeredQuestion.rationale}

Latest answer:
${answerText}

Answers already collected for this anchor:
${answersForAnchor || 'None'}

Dynamic questions already asked for this anchor:
${dynamicForAnchor || 'None'}

Dynamic-question budget: ${dynamicCount}/${MAX_DYNAMIC_QUESTIONS_PER_PRIMARY}

Remaining STAR anchors:
${remainingAnchors || 'None'}

Decision rules:
- action "advance": use only when the candidate gave enough STAR signal for this anchor.
- action "clarification": use when the answer is too short, vague, or off-topic.
- action "follow_up": use when one targeted question would meaningfully improve the answer.
- action "deep_dive": use when the answer mentions a technical topic worth probing further (architecture decision, latency / scaling tradeoff, failure mode, metric).
- Prefer "deep_dive" over "clarification" when the candidate gave technical material — this is a project deep-dive.
- Every dynamic question must serve the CURRENT anchor; do not introduce new categories.
- If action is not "advance", provide questionText as a concise spoken interviewer question under 28 words; reference "${projectName}" or specific details from the candidate's answer.
- Return exactly one decision object.`;
	}

	private createDynamicQuestion(
		answeredQuestion: AnchorQuestion,
		decision: DeepdiveDecision,
	): {
		question: AnchorQuestion;
		kind: DynamicQuestionKind;
		auditRecord: DynamicQuestion;
	} {
		const kind = decision.action as DynamicQuestionKind;
		const text = decision.questionText?.trim() || fallbackDynamicQuestionText(answeredQuestion);
		const question: AnchorQuestion = {
			...answeredQuestion,
			text,
			rationale: decision.rationale,
		};
		return {
			question,
			kind,
			auditRecord: {
				primaryAnchorId: answeredQuestion.id,
				kind,
				text,
				rationale: decision.rationale,
				timestamp: Date.now(),
			},
		};
	}

	private serialize(
		result: DeepdiveProgressResult,
		traceId: string,
		invokeStartedAt: number,
	): string {
		const text = JSON.stringify(result);
		logSubagentStep(
			traceId,
			'invoke_total',
			invokeStartedAt,
			`status=${result.status} phase=${this.state.phase} active=${this.state.activeQuestion?.id ?? 'none'} answers=${this.state.answers.length} chars=${text.length}`,
		);
		return text;
	}
}

function buildDeepdivePlannerInstructions(documents: ProjectDocuments): string {
	return `You are the project_deepdive subagent for a voice interview that focuses on ONE specific project from the candidate's past work.

Your first job is to read the documents, pick the single project from the candidate's resume that offers the highest signal opportunity, and return a structured plan.

Project selection criteria (in priority order):
- Recency: prefer recent / current projects over older work.
- Candidate ownership: prefer projects the candidate clearly led or owned end-to-end.
- Technical depth: prefer projects with non-trivial system design, scaling, or migration concerns.
- Role-fit: prefer projects whose technical themes align with the target job description.

Hard requirements:
- Pick exactly ONE project. Name it explicitly in digest.projectName (do NOT use placeholders like "the project" or "[Project]").
- Generate exactly four STAR-aligned anchor questions in this exact order:
  1. project_context — what was the project, scope, timeframe, team size, success criteria.
  2. contribution_and_decisions — candidate's personal role + the most consequential design decision they owned, with alternatives.
  3. problems_and_failures — hardest problem / what went wrong / how they recovered / what they'd do differently.
  4. outcomes_and_metrics — quantified outcomes, how they measured success, what numbers they'd point to.
- Use the project name (and specific details from the resume) in every question — anchor questions must NOT be generic.
- Keep digest arrays compact: at most 8 technologies; project summary 1-2 sentences.
- selectionRationale should be one sentence explaining why this project was chosen over the candidate's other projects.
- Keep each question concise and natural for voice, ideally under 28 words.

# Job Description
${documents.jobDescription}

# Candidate Resume
${documents.candidateResume}

# Company Intro
${documents.companyIntro}`;
}

function buildDeepdiveLeaderInstructions(
	documents: ProjectDocuments,
	state: ProjectDeepdiveState,
): string {
	const projectName = state.projectName ?? 'the project';
	const projectDigest = state.projectDigest;
	const digestText = projectDigest
		? `\n# Chosen Project\nName: ${projectDigest.projectName}\nSummary: ${projectDigest.projectSummary}\nCandidate role on project: ${projectDigest.candidateRole}\nTechnologies: ${projectDigest.technologies.join(', ')}\nWhy this project: ${projectDigest.selectionRationale}\n`
		: '';

	return `You are the persistent project_deepdive subagent leading a voice interview that focuses on the candidate's project "${projectName}".

Your goal is to extract STAR signal across four anchors:
1. project_context
2. contribution_and_decisions
3. problems_and_failures
4. outcomes_and_metrics

You do not speak directly to the candidate. You decide what the MainAgent should ask next.

Behavior:
- Advance when the current anchor has enough STAR signal.
- Clarification: answer is short, vague, off-topic, or unclear.
- Follow-up: one targeted question would meaningfully improve the answer.
- Deep-dive: candidate mentioned a technical topic — architecture, scaling decision, failure, metric — that deserves probing for engineering depth.
- This is a deep-dive interview: PREFER deep-dive over clarification when the candidate gives technical material.
- Dynamic questions must serve the current anchor — do not switch categories.
- Reference "${projectName}" or concrete details from the candidate's answer in dynamic questions; never use generic placeholders.
- Keep questions concise and voice-natural, ideally under 28 words.
${digestText}
# Job Description
${documents.jobDescription}

# Candidate Resume
${documents.candidateResume}

# Company Intro
${documents.companyIntro}`;
}

function normalizeDecision(
	decision: DeepdiveDecision,
	answeredQuestion: AnchorQuestion,
): DeepdiveDecision {
	if (decision.action === 'advance') {
		return { action: 'advance', rationale: decision.rationale };
	}
	return {
		...decision,
		questionText: decision.questionText?.trim() || fallbackDynamicQuestionText(answeredQuestion),
	};
}

function fallbackDecision(
	answeredQuestion: AnchorQuestion,
	answerText: string,
	dynamicCount: number,
): DeepdiveDecision {
	const normalized = answerText.trim().toLowerCase();
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;

	// Short / non-committal answer on first pass: clarify.
	if (
		dynamicCount === 0 &&
		(wordCount < 8 ||
			/\b(i don't know|not sure|nothing much|no idea|maybe|yes|no|ok|okay)\b/.test(normalized))
	) {
		return {
			action: 'clarification',
			questionText: fallbackDynamicQuestionText(answeredQuestion),
			rationale: 'The answer was too short or unclear to satisfy the current STAR anchor.',
		};
	}

	// Technical signal on a non-outcomes anchor: deep-dive.
	if (
		dynamicCount === 0 &&
		answeredQuestion.id !== 'outcomes_and_metrics' &&
		/\b(architecture|latency|scaling|incident|outage|tradeoff|websocket|webrtc|distributed|migration|backpressure|cutover|shadow|dual-write|consistency|throughput|sharding)\b/.test(
			normalized,
		)
	) {
		return {
			action: 'deep_dive',
			questionText:
				'Can you go one level deeper on the key technical tradeoff and how you validated the result?',
			rationale: 'Answer mentioned a technical area worth probing for engineering depth.',
		};
	}

	// Outcomes anchor without numbers: follow up for quantification.
	if (
		dynamicCount <= 1 &&
		answeredQuestion.id === 'outcomes_and_metrics' &&
		!/\b\d+(\.\d+)?\s*(%|ms|s|sec|seconds|minutes|hour|hours|x|users|million|billion|k\b|requests|qps|rps)\b/.test(
			normalized,
		)
	) {
		return {
			action: 'follow_up',
			questionText: fallbackDynamicQuestionText(answeredQuestion),
			rationale: 'Outcomes answer lacked quantified numbers — probing for metrics.',
		};
	}

	return {
		action: 'advance',
		rationale: 'The answer provides enough STAR signal to continue to the next anchor.',
	};
}

function fallbackDynamicQuestionText(answeredQuestion: AnchorQuestion): string {
	switch (answeredQuestion.id) {
		case 'project_context':
			return 'Could you give one concrete example of the system constraint that made this project nontrivial?';
		case 'contribution_and_decisions':
			return 'Could you walk me through one alternative you considered and why you ruled it out?';
		case 'problems_and_failures':
			return 'Could you describe the hardest moment on that project and how you diagnosed it?';
		case 'outcomes_and_metrics':
			return 'Could you give one specific number you would point to today as the success metric?';
	}
}
