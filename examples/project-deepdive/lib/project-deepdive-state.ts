import type { ProjectDocuments } from './project-documents.js';

/**
 * Four STAR-aligned anchor IDs. Order is fixed: context → contribution →
 * problems → outcomes. The persistent subagent decides PER-anchor probe
 * depth (clarification / follow_up / deep_dive); it does NOT reorder the
 * sequence.
 */
export const ANCHOR_IDS = [
	'project_context',
	'contribution_and_decisions',
	'problems_and_failures',
	'outcomes_and_metrics',
] as const;

const MAX_TECHNOLOGIES = 8;
const MAX_SOURCE_REFS = 3;

export type AnchorId = (typeof ANCHOR_IDS)[number];

export interface ProjectDigest {
	candidateName: string;
	/** Subagent picks ONE project from the resume during prepare(). */
	projectName: string;
	/** 1-2 sentences describing what the project was. */
	projectSummary: string;
	/** "Tech Lead", "Senior Engineer", "Owner of …", etc. */
	candidateRole: string;
	technologies: string[];
	/** Why the subagent chose this project (highest signal opportunity). */
	selectionRationale: string;
}

export interface AnchorQuestion {
	id: AnchorId;
	text: string;
	rationale: string;
	sourceRefs: string[];
}

export interface AnchorAnswer {
	anchorId: AnchorId;
	questionText: string;
	answerText: string;
	timestamp: number;
}

export type AnchorQuestionKind = 'primary' | 'clarification' | 'follow_up' | 'deep_dive';

export interface DynamicQuestion {
	primaryAnchorId: AnchorId;
	kind: Exclude<AnchorQuestionKind, 'primary'>;
	text: string;
	rationale: string;
	timestamp: number;
}

export interface ProjectDeepdivePlan {
	digest: ProjectDigest;
	questions: AnchorQuestion[];
}

export interface ProjectContext {
	candidateName: string;
	companyName: string;
	roleTitle: string;
}

export interface ProjectDeepdiveState {
	phase: 'not_prepared' | 'prepared' | 'questioning' | 'completed';
	candidateName?: string;
	companyName?: string;
	roleTitle?: string;
	projectName?: string;
	projectDigest?: ProjectDigest;
	questions: AnchorQuestion[];
	nextQuestionIndex: number;
	activeQuestion?: AnchorQuestion;
	activeQuestionKind?: AnchorQuestionKind;
	answers: AnchorAnswer[];
	dynamicQuestions: DynamicQuestion[];
	dynamicQuestionCounts: Partial<Record<AnchorId, number>>;
	usedFallback: boolean;
	prepareError?: string;
}

export function createProjectDeepdiveState(): ProjectDeepdiveState {
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

export function extractProjectContext(documents: ProjectDocuments): ProjectContext {
	return {
		candidateName: firstMarkdownHeading(documents.candidateResume) ?? 'the candidate',
		companyName: firstMarkdownHeading(documents.companyIntro) ?? 'the company',
		roleTitle: firstMarkdownHeading(documents.jobDescription) ?? 'the engineering role',
	};
}

export function applyDeepdivePlan(
	state: ProjectDeepdiveState,
	plan: ProjectDeepdivePlan,
	context: ProjectContext,
): ProjectDeepdiveState {
	validatePlan(plan);
	state.phase = 'prepared';
	state.candidateName = plan.digest.candidateName;
	state.companyName = context.companyName;
	state.roleTitle = context.roleTitle;
	state.projectName = plan.digest.projectName;
	state.projectDigest = plan.digest;
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

/**
 * Replace generic placeholders ("[Project]", "the project", "[Candidate]")
 * with the concrete project / candidate names so the LLM cannot recite a
 * placeholder back to the user.
 */
export function normalizeDeepdivePlanWithDocuments(
	plan: ProjectDeepdivePlan,
	documents: ProjectDocuments,
): ProjectDeepdivePlan {
	const candidateName =
		firstMarkdownHeading(documents.candidateResume) ?? plan.digest.candidateName;
	const projectName = plan.digest.projectName.trim() || 'the project';

	return {
		digest: {
			...plan.digest,
			candidateName,
			projectName,
			technologies: compactList(plan.digest.technologies, MAX_TECHNOLOGIES),
		},
		questions: plan.questions.map((q) => ({
			...q,
			sourceRefs: compactList(q.sourceRefs, MAX_SOURCE_REFS),
			text: normalizeQuestionText(q.text, { candidateName, projectName }),
		})),
	};
}

export function ensurePreparedWithFallback(
	state: ProjectDeepdiveState,
	documents: ProjectDocuments,
	reason?: string,
): ProjectDeepdiveState {
	if (state.questions.length === ANCHOR_IDS.length) return state;
	const context = extractProjectContext(documents);
	const plan = buildFallbackDeepdivePlan(documents);
	state.phase = 'prepared';
	state.candidateName = plan.digest.candidateName;
	state.companyName = context.companyName;
	state.roleTitle = context.roleTitle;
	state.projectName = plan.digest.projectName;
	state.projectDigest = plan.digest;
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

export function getNextAnchorQuestion(state: ProjectDeepdiveState): {
	status: 'question' | 'completed';
	question?: AnchorQuestion;
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
			message: 'All STAR anchors for this project have been covered.',
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

export function buildOpeningGreetingPrompt(state: ProjectDeepdiveState): string {
	const candidateName = state.candidateName ?? 'the candidate';
	const companyName = state.companyName ?? 'the company';
	const roleTitle = state.roleTitle ?? 'the engineering role';
	const projectName = state.projectName ?? 'one of your projects';

	return buildOpeningGreetingPromptFromContext(
		{ candidateName, companyName, roleTitle },
		projectName,
	);
}

export function buildOpeningGreetingPromptFromContext(
	context: ProjectContext,
	projectName: string,
): string {
	const spokenGreeting = `Hi ${context.candidateName}, I'm your interviewer for the ${context.roleTitle} role at ${context.companyName}. Today we'll do a deep-dive into your work on ${projectName}. We'll cover what the project was, your contribution, the hardest problems you faced, and the outcomes.`;

	return [
		`Say exactly this greeting once: "${spokenGreeting}"`,
		'Do not include labels, alternate drafts, revisions, or meta commentary.',
		'After saying the greeting once, call record_answer_and_get_next_question without answerText.',
		'When the tool returns, ask only the returned question text. Do not repeat or summarize the greeting.',
	].join(' ');
}

export function buildClosingMessage(state: ProjectDeepdiveState): string {
	const candidateName = state.candidateName ?? 'there';
	const companyName = state.companyName ?? 'the company';
	const roleTitle = state.roleTitle ?? 'the role';
	const projectName = state.projectName ?? 'that project';

	return `That covers what I wanted to learn about ${projectName}. Thank you, ${candidateName}, for walking me through it in detail. We appreciate your time today, and we wish you the best with the rest of the ${roleTitle} process at ${companyName}. Goodbye.`;
}

export function recordAnchorAnswer(
	state: ProjectDeepdiveState,
	answerText: string,
): {
	status: 'recorded' | 'error';
	anchorId?: AnchorId;
	message: string;
} {
	const active = state.activeQuestion;
	if (!active) {
		return {
			status: 'error',
			message: 'No active anchor question is waiting for an answer.',
		};
	}

	const trimmed = answerText.trim();
	if (!trimmed) {
		return {
			status: 'error',
			anchorId: active.id,
			message: 'Answer text is empty.',
		};
	}

	state.answers.push({
		anchorId: active.id,
		questionText: active.text,
		answerText: trimmed,
		timestamp: Date.now(),
	});
	state.activeQuestion = undefined;
	state.activeQuestionKind = undefined;

	return {
		status: 'recorded',
		anchorId: active.id,
		message: `Recorded answer for ${active.id}.`,
	};
}

export function getProjectDeepdiveStatus(state: ProjectDeepdiveState): Record<string, unknown> {
	return {
		phase: state.phase,
		candidateName: state.candidateName,
		companyName: state.companyName,
		roleTitle: state.roleTitle,
		projectName: state.projectName,
		questionsPrepared: state.questions.length,
		nextQuestionIndex: state.nextQuestionIndex,
		activeAnchorId: state.activeQuestion?.id,
		activeQuestionKind: state.activeQuestionKind,
		answersRecorded: state.answers.length,
		dynamicQuestionsAsked: state.dynamicQuestions.length,
		remainingAnchors: Math.max(0, state.questions.length - state.nextQuestionIndex),
		usedFallback: state.usedFallback,
		prepareError: state.prepareError,
	};
}

function validatePlan(plan: ProjectDeepdivePlan): void {
	if (plan.questions.length !== ANCHOR_IDS.length) {
		throw new Error(
			`Project deep-dive plan must contain exactly ${ANCHOR_IDS.length} anchor questions.`,
		);
	}
	for (let i = 0; i < ANCHOR_IDS.length; i++) {
		if (plan.questions[i].id !== ANCHOR_IDS[i]) {
			throw new Error(
				`Anchor ${i + 1} must have id "${ANCHOR_IDS[i]}", got "${plan.questions[i].id}".`,
			);
		}
	}
}

function buildFallbackDeepdivePlan(documents: ProjectDocuments): ProjectDeepdivePlan {
	const candidateName = firstMarkdownHeading(documents.candidateResume) ?? 'the candidate';

	return {
		digest: {
			candidateName,
			projectName: 'one of your past projects',
			projectSummary:
				'Subagent plan preparation failed; falling back to generic anchors that ask the candidate to choose a project.',
			candidateRole: 'engineer',
			technologies: ['software'],
			selectionRationale: 'Fallback path — no specific project selected.',
		},
		questions: [
			{
				id: 'project_context',
				text: `${candidateName}, pick one project from your resume that you owned end-to-end. Walk me through what it was, the timeframe, the team size, and what success looked like.`,
				rationale: 'Open the deep-dive by anchoring on a project the candidate chose.',
				sourceRefs: ['candidate_resume'],
			},
			{
				id: 'contribution_and_decisions',
				text: 'Within that project, what was specifically yours to own — and what was the most consequential design decision you made? What alternatives did you consider?',
				rationale: 'Probe ownership boundaries and decision-making depth.',
				sourceRefs: ['candidate_resume'],
			},
			{
				id: 'problems_and_failures',
				text: 'What was the hardest problem you hit on that project — something that did not go to plan? Walk me through what happened, how you diagnosed it, and how you recovered.',
				rationale: 'Probe technical depth + honesty about failure.',
				sourceRefs: ['candidate_resume'],
			},
			{
				id: 'outcomes_and_metrics',
				text: 'How did you measure whether the project succeeded? What numbers or signals would you point to today, and what would you do differently if you started it again?',
				rationale: 'Probe outcome quantification and reflective judgment.',
				sourceRefs: ['candidate_resume'],
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
	values: { candidateName: string; projectName: string },
): string {
	return text
		.replace(/\[Project\]/g, values.projectName)
		.replace(/\bthe project\b/g, values.projectName)
		.replace(/\[Candidate\]/g, values.candidateName)
		.replace(/\bthe candidate\b/g, values.candidateName);
}
