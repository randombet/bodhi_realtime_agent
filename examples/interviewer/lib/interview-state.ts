import type { InterviewDocuments } from './interview-documents.js';

export const QUESTION_IDS = ['walk_resume', 'company_interest', 'technical_challenge'] as const;
const MAX_RESUME_HIGHLIGHTS = 6;
const MAX_COMPANY_HIGHLIGHTS = 6;
const MAX_MUST_HAVE_TECHNOLOGIES = 8;
const MAX_ALIGNMENT_NOTES = 6;
const MAX_SOURCE_REFS = 3;

export type InterviewQuestionId = (typeof QUESTION_IDS)[number];

export interface InterviewDocumentDigest {
	candidateName: string;
	companyName: string;
	roleTitle: string;
	resumeHighlights: string[];
	companyHighlights: string[];
	mustHaveTechnologies: string[];
	alignmentNotes: string[];
}

export interface InterviewQuestion {
	id: InterviewQuestionId;
	text: string;
	rationale: string;
	sourceRefs: string[];
}

export interface InterviewAnswer {
	questionId: InterviewQuestionId;
	questionText: string;
	answerText: string;
	timestamp: number;
}

export type InterviewQuestionKind = 'primary' | 'clarification' | 'follow_up' | 'deep_dive';

export interface InterviewDynamicQuestion {
	primaryQuestionId: InterviewQuestionId;
	kind: Exclude<InterviewQuestionKind, 'primary'>;
	text: string;
	rationale: string;
	timestamp: number;
}

export interface InterviewPlan {
	digest: InterviewDocumentDigest;
	questions: InterviewQuestion[];
}

export interface InterviewDocumentContext {
	candidateName: string;
	companyName: string;
	roleTitle: string;
}

export interface InterviewState {
	phase: 'not_prepared' | 'prepared' | 'questioning' | 'completed';
	companyName?: string;
	roleTitle?: string;
	documentDigest?: InterviewDocumentDigest;
	questions: InterviewQuestion[];
	nextQuestionIndex: number;
	activeQuestion?: InterviewQuestion;
	activeQuestionKind?: InterviewQuestionKind;
	answers: InterviewAnswer[];
	dynamicQuestions: InterviewDynamicQuestion[];
	dynamicQuestionCounts: Partial<Record<InterviewQuestionId, number>>;
	usedFallback: boolean;
	prepareError?: string;
}

export function createInterviewState(): InterviewState {
	return {
		phase: 'not_prepared',
		questions: [],
		nextQuestionIndex: 0,
		answers: [],
		dynamicQuestions: [],
		dynamicQuestionCounts: {},
		usedFallback: false,
	};
}

export function extractInterviewDocumentContext(
	documents: InterviewDocuments,
): InterviewDocumentContext {
	return {
		candidateName: firstMarkdownHeading(documents.candidateResume) ?? 'the candidate',
		companyName: firstMarkdownHeading(documents.companyIntro) ?? 'the company',
		roleTitle: firstMarkdownHeading(documents.jobDescription) ?? 'the software engineering role',
	};
}

export function applyInterviewPlan(state: InterviewState, plan: InterviewPlan): InterviewState {
	validatePlan(plan);
	state.phase = 'prepared';
	state.companyName = plan.digest.companyName;
	state.roleTitle = plan.digest.roleTitle;
	state.documentDigest = plan.digest;
	state.questions = plan.questions;
	state.nextQuestionIndex = 0;
	state.activeQuestion = undefined;
	state.activeQuestionKind = undefined;
	state.answers = [];
	state.dynamicQuestions = [];
	state.dynamicQuestionCounts = {};
	state.usedFallback = false;
	state.prepareError = undefined;
	return state;
}

export function normalizeInterviewPlanWithDocuments(
	plan: InterviewPlan,
	documents: InterviewDocuments,
): InterviewPlan {
	const candidateName =
		firstMarkdownHeading(documents.candidateResume) ?? plan.digest.candidateName;
	const companyName = firstMarkdownHeading(documents.companyIntro) ?? plan.digest.companyName;
	const roleTitle = firstMarkdownHeading(documents.jobDescription) ?? plan.digest.roleTitle;

	return {
		digest: {
			...plan.digest,
			candidateName,
			companyName,
			roleTitle,
			resumeHighlights: compactList(plan.digest.resumeHighlights, MAX_RESUME_HIGHLIGHTS),
			companyHighlights: compactList(plan.digest.companyHighlights, MAX_COMPANY_HIGHLIGHTS),
			mustHaveTechnologies: compactList(
				plan.digest.mustHaveTechnologies,
				MAX_MUST_HAVE_TECHNOLOGIES,
			),
			alignmentNotes: compactList(plan.digest.alignmentNotes, MAX_ALIGNMENT_NOTES),
		},
		questions: plan.questions.map((q) => ({
			...q,
			sourceRefs: compactList(q.sourceRefs, MAX_SOURCE_REFS),
			text: normalizeQuestionText(q.text, {
				candidateName,
				companyName,
				roleTitle,
			}),
		})),
	};
}

export function ensurePreparedWithFallback(
	state: InterviewState,
	documents: InterviewDocuments,
	reason?: string,
): InterviewState {
	if (state.questions.length === QUESTION_IDS.length) return state;
	const plan = buildFallbackInterviewPlan(documents);
	state.phase = 'prepared';
	state.companyName = plan.digest.companyName;
	state.roleTitle = plan.digest.roleTitle;
	state.documentDigest = plan.digest;
	state.questions = plan.questions;
	state.nextQuestionIndex = 0;
	state.activeQuestion = undefined;
	state.activeQuestionKind = undefined;
	state.answers = [];
	state.dynamicQuestions = [];
	state.dynamicQuestionCounts = {};
	state.usedFallback = true;
	state.prepareError = reason;
	return state;
}

export function getNextInterviewQuestion(state: InterviewState): {
	status: 'question' | 'completed';
	question?: InterviewQuestion;
	questionNumber?: number;
	totalQuestions: number;
	message: string;
	closingMessage?: string;
} {
	if (state.nextQuestionIndex >= state.questions.length) {
		state.phase = 'completed';
		state.activeQuestion = undefined;
		state.activeQuestionKind = undefined;
		const closingMessage = buildClosingMessage(state);
		return {
			status: 'completed',
			totalQuestions: state.questions.length,
			message: 'All three primary interview anchors have been completed.',
			closingMessage,
		};
	}

	const question = state.questions[state.nextQuestionIndex];
	state.activeQuestion = question;
	state.activeQuestionKind = 'primary';
	state.nextQuestionIndex += 1;
	state.phase = 'questioning';

	return {
		status: 'question',
		question,
		questionNumber: state.nextQuestionIndex,
		totalQuestions: state.questions.length,
		message: question.text,
	};
}

export function buildOpeningGreetingPrompt(state: InterviewState): string {
	const candidateName = state.documentDigest?.candidateName ?? 'the candidate';
	const companyName = state.companyName ?? 'the company';
	const roleTitle = state.roleTitle ?? 'the software engineering role';

	return buildOpeningGreetingPromptFromContext({ candidateName, companyName, roleTitle });
}

export function buildOpeningGreetingPromptFromContext(context: InterviewDocumentContext): string {
	const spokenGreeting = `Hello ${context.candidateName}, I'm your software interviewer for the ${context.roleTitle} role at ${context.companyName}. Today we'll discuss your background, your interest in ${context.companyName}, and a technical challenge.`;

	return [
		`Say exactly this greeting once: "${spokenGreeting}"`,
		'Do not include labels, alternate drafts, revisions, or meta commentary.',
		'After saying the greeting once, call record_answer_and_get_next_question without answerText.',
		'When the tool returns, ask only the returned question text. Do not repeat or summarize the greeting.',
	].join(' ');
}

export function buildClosingMessage(state: InterviewState): string {
	const candidateName = state.documentDigest?.candidateName ?? 'there';
	const companyName = state.companyName ?? 'the company';
	const roleTitle = state.roleTitle ?? 'the role';

	return `That covers the main interview questions. Thank you, ${candidateName}, for taking the time to speak with us about the ${roleTitle} role at ${companyName}. We appreciate your thoughtful answers, and we wish you the best of luck with the rest of the process. Goodbye.`;
}

export function recordInterviewAnswer(
	state: InterviewState,
	answerText: string,
): {
	status: 'recorded' | 'error';
	questionId?: InterviewQuestionId;
	message: string;
} {
	const active = state.activeQuestion;
	if (!active) {
		return {
			status: 'error',
			message: 'No active interview question is waiting for an answer.',
		};
	}

	const trimmed = answerText.trim();
	if (!trimmed) {
		return {
			status: 'error',
			questionId: active.id,
			message: 'Answer text is empty.',
		};
	}

	state.answers.push({
		questionId: active.id,
		questionText: active.text,
		answerText: trimmed,
		timestamp: Date.now(),
	});
	state.activeQuestion = undefined;
	state.activeQuestionKind = undefined;

	return {
		status: 'recorded',
		questionId: active.id,
		message: `Recorded answer for ${active.id}.`,
	};
}

export function getInterviewStatus(state: InterviewState): Record<string, unknown> {
	return {
		phase: state.phase,
		companyName: state.companyName,
		roleTitle: state.roleTitle,
		questionsPrepared: state.questions.length,
		nextQuestionIndex: state.nextQuestionIndex,
		activeQuestionId: state.activeQuestion?.id,
		activeQuestionKind: state.activeQuestionKind,
		answersRecorded: state.answers.length,
		dynamicQuestionsAsked: state.dynamicQuestions.length,
		remainingQuestions: Math.max(0, state.questions.length - state.nextQuestionIndex),
		usedFallback: state.usedFallback,
		prepareError: state.prepareError,
	};
}

function validatePlan(plan: InterviewPlan): void {
	if (plan.questions.length !== QUESTION_IDS.length) {
		throw new Error(`Interview plan must contain exactly ${QUESTION_IDS.length} questions.`);
	}
	for (let i = 0; i < QUESTION_IDS.length; i++) {
		if (plan.questions[i].id !== QUESTION_IDS[i]) {
			throw new Error(
				`Interview question ${i + 1} must have id "${QUESTION_IDS[i]}", got "${plan.questions[i].id}".`,
			);
		}
	}
}

function buildFallbackInterviewPlan(documents: InterviewDocuments): InterviewPlan {
	const candidateName = firstMarkdownHeading(documents.candidateResume) ?? 'the candidate';
	const companyName = firstMarkdownHeading(documents.companyIntro) ?? 'the company';
	const roleTitle =
		firstMarkdownHeading(documents.jobDescription) ?? 'the software engineering role';

	return {
		digest: {
			candidateName,
			companyName,
			roleTitle,
			resumeHighlights: [
				'Realtime collaboration and media systems',
				'TypeScript and Node.js backend work',
				'Production observability and incident response',
			],
			companyHighlights: [
				'Remote robotics operations',
				'Reliable realtime control loops',
				'Cross-functional ownership from design through production',
			],
			mustHaveTechnologies: ['TypeScript', 'Node.js', 'WebRTC', 'WebSockets'],
			alignmentNotes: [
				'Candidate resume includes realtime systems experience aligned with the role.',
			],
		},
		questions: [
			{
				id: 'walk_resume',
				text: `${candidateName}, to start, can you walk me through your resume and the systems work you are most proud of?`,
				rationale: 'Open with resume narrative and ownership signal.',
				sourceRefs: ['candidate_resume'],
			},
			{
				id: 'company_interest',
				text: `What specifically interests you about ${companyName} and this role?`,
				rationale: 'Probe company-specific motivation.',
				sourceRefs: ['company_intro', 'job_description'],
			},
			{
				id: 'technical_challenge',
				text: 'Tell me about a challenging technical problem you solved in a production system.',
				rationale: 'Assess technical depth and problem-solving clarity.',
				sourceRefs: ['candidate_resume', 'job_description'],
			},
		],
	};
}

function firstMarkdownHeading(markdown: string): string | undefined {
	const match = markdown.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim();
}

function compactList(items: string[], maxItems: number): string[] {
	return items
		.map((item) => item.trim())
		.filter(Boolean)
		.slice(0, maxItems);
}

function normalizeQuestionText(
	text: string,
	values: {
		candidateName: string;
		companyName: string;
		roleTitle: string;
	},
): string {
	return text
		.replace(/\[Company\]/g, values.companyName)
		.replace(/\bthe company\b/gi, values.companyName)
		.replace(/\bthe software engineering role\b/gi, values.roleTitle)
		.replace(/\bthe candidate\b/gi, values.candidateName);
}
