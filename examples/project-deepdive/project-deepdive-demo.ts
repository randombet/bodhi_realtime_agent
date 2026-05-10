/**
 * Bodhi Project Deep-Dive Example
 *
 * Voice interview that deep-dives into ONE specific past project from the
 * candidate's resume using a STAR-aligned anchor sequence:
 *   1. project_context        — what the project was, scope, timeframe.
 *   2. contribution_and_decisions — candidate's role + key decisions.
 *   3. problems_and_failures  — hardest problems + recovery.
 *   4. outcomes_and_metrics   — quantified outcomes + reflection.
 *
 * The persistent project_deepdive subagent picks the project up-front
 * (highest signal opportunity from the resume) and decides per-anchor
 * follow-up depth (clarification / follow-up / deep-dive).
 *
 * Usage:
 *   1. Set GEMINI_API_KEY in .env or the environment.
 *   2. Run: pnpm tsx examples/project-deepdive/project-deepdive-demo.ts
 *   3. In another terminal: pnpm web-client:dev
 *   4. Open the local web client and connect to ws://localhost:9900.
 *
 * Environment Variables:
 *   GEMINI_API_KEY                       - Required: Google AI Studio API key
 *   PORT                                 - WebSocket port (default: 9900)
 *   HOST                                 - Bind address (default: 0.0.0.0)
 *   GEMINI_LIVE_MODEL                    - Live voice model (default: gemini-3.1-flash-live-preview)
 *   DEEPDIVE_REASONING_MODEL             - MainAgent reasoning model (default: gemini-2.5-flash)
 *   DEEPDIVE_SUBAGENT_MODEL              - Persistent subagent model (default: gemini-3.1-flash-lite-preview)
 *   DEEPDIVE_SUBAGENT_THINKING_BUDGET    - Reasoning budget for the subagent (default: 128)
 *   GEMINI_VOICE                         - Gemini voice name (default: Puck)
 *   TRANSCRIPT_DIR                       - Directory for per-session WhatsApp-style markdown
 *                                          transcripts (default: ./transcripts)
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { MarkdownConversationHistoryStore } from '../../src/core/markdown-conversation-history-store.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import { TimingReminderBackgroundAgent } from '../interviewer/lib/timing-reminder-agent.js';
import { createProjectDeepdiveAgent } from './lib/project-deepdive-agent.js';
import {
	createProjectDeepdiveState,
	ensurePreparedWithFallback,
} from './lib/project-deepdive-state.js';
import {
	createLowReasoningSubagentProviderOptions,
	createProjectDeepdiveSubagentConfig,
	ProjectDeepdiveSubagent,
} from './lib/project-deepdive-subagent.js';
import { loadProjectDocuments } from './lib/project-documents.js';

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

function parseSubagentThinkingBudget(): number {
	const value = process.env.DEEPDIVE_SUBAGENT_THINKING_BUDGET;
	if (value === undefined) return 128;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 128;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
if (!GEMINI_API_KEY) {
	console.error('Error: GEMINI_API_KEY or GOOGLE_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_ID = `deepdive_${Date.now()}`;
// Where the WhatsApp-style markdown transcript for each session is written.
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || './transcripts';
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const REASONING_MODEL = process.env.DEEPDIVE_REASONING_MODEL || 'gemini-2.5-flash';
const SUBAGENT_MODEL = process.env.DEEPDIVE_SUBAGENT_MODEL || 'gemini-3.1-flash-lite-preview';
const SUBAGENT_THINKING_BUDGET = parseSubagentThinkingBudget();
const REALTIME_INPUT_CONFIG = {
	automaticActivityDetection: {
		endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
		silenceDurationMs: 500,
	},
};

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

async function main() {
	const documents = loadProjectDocuments();
	const state = createProjectDeepdiveState();
	const reasoningModel = google(REASONING_MODEL);
	const subagentReasoningModel = google(SUBAGENT_MODEL);
	const subagent = new ProjectDeepdiveSubagent(
		'record_answer_and_get_next_question',
		state,
		documents,
		subagentReasoningModel,
		createLowReasoningSubagentProviderOptions(SUBAGENT_THINKING_BUDGET),
	);

	console.log(`${ts()} [Deepdive] Preparing document-grounded plan...`);
	try {
		await subagent.prepare();
		console.log(
			`${ts()} [Deepdive] Picked project: "${state.projectName ?? 'unknown'}" (${state.questions.length} anchors)`,
		);
		if (state.projectDigest) {
			console.log(`${ts()} [Deepdive] Why: ${state.projectDigest.selectionRationale}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`${ts()} [Deepdive] Subagent preparation failed; using fallback plan: ${message}`);
		ensurePreparedWithFallback(state, documents, message);
	}

	const subagentConfig = createProjectDeepdiveSubagentConfig(subagent);
	const chosenProjectName = state.projectName ?? 'one of your past projects';
	const deepdiveAgent = createProjectDeepdiveAgent(documents, chosenProjectName);

	// Periodic time-remaining reminder (reused from the interviewer demo).
	const timingReminder = new TimingReminderBackgroundAgent(state);

	const transcriptStore = new MarkdownConversationHistoryStore({
		baseDir: TRANSCRIPT_DIR,
		modelName: LIVE_MODEL,
		log: (msg) => console.error(`${ts()} [Transcript] ${msg}`),
	});

	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'deepdive_demo_user',
		apiKey: GEMINI_API_KEY,
		agents: [deepdiveAgent],
		initialAgent: 'project_deepdive',
		port: PORT,
		host: HOST,
		model: reasoningModel,
		orchestrationMode: 'actor',
		conversationHistoryStores: [transcriptStore],
		subagentConfigs: {
			record_answer_and_get_next_question: subagentConfig,
		},
		backgroundAgents: [timingReminder],
		geminiModel: LIVE_MODEL,
		speechConfig: { voiceName: process.env.GEMINI_VOICE || 'Puck' },
		realtimeInputConfig: REALTIME_INPUT_CONFIG,
		hooks: {
			onSessionStart: (event) =>
				console.log(`${ts()} [Session] Started: ${event.sessionId} (${event.agentName})`),
			onSessionEnd: (event) =>
				console.log(`${ts()} [Session] Ended: ${event.sessionId} (${event.reason})`),
			onToolCall: (event) => console.log(`${ts()} [Tool] ${event.toolName} (${event.execution})`),
			onToolResult: (event) =>
				console.log(`${ts()} [Tool] Result ${event.toolCallId}: ${event.status}`),
			onSubagentStep: (event) =>
				console.log(
					`${ts()} [Subagent] ${event.subagentName} step ${event.stepNumber} tools=[${event.toolCalls.join(',')}]`,
				),
			onBackgroundNotification: (event) =>
				console.log(
					`${ts()} [BgNotify] ${event.label} (priority=${event.priority}, deferred=${event.deferredMs}ms)`,
				),
			onError: (event) =>
				console.error(`${ts()} [Error] ${event.component}: ${event.error.message}`),
		},
	});

	let lastLoggedIndex = 0;
	session.eventBus.subscribe('turn.end', (payload) => {
		console.log(`${ts()} [Turn] ${payload.turnId}`);
		const items = session.conversationContext.items;
		for (const item of items.slice(lastLoggedIndex)) {
			if (item.role === 'user' || item.role === 'assistant') {
				console.log(`${ts()}   [${item.role}] ${item.content}`);
			}
		}
		lastLoggedIndex = items.length;
	});

	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session.close('user_hangup');
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await session.start();

	console.log('============================================================');
	console.log('Bodhi — Project Deep-Dive Example');
	console.log('============================================================');
	console.log(`  WebSocket:       ws://localhost:${PORT}`);
	console.log(`  Session:         ${SESSION_ID}`);
	console.log(`  Voice model:     ${LIVE_MODEL}`);
	console.log(`  Main model:      ${REASONING_MODEL}`);
	console.log(`  Subagent model:  ${SUBAGENT_MODEL}`);
	console.log(`  Subagent budget: ${SUBAGENT_THINKING_BUDGET}`);
	console.log('  Gemini VAD:      end=HIGH silence=500ms');
	console.log('  Documents:       examples/project-deepdive/docs/*.md');
	console.log(`  Project:         ${chosenProjectName}`);
	console.log(`  Transcript:      ${TRANSCRIPT_DIR}/${SESSION_ID}.md`);
	console.log();
	console.log('Connect via: pnpm web-client:dev');
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
