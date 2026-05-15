/**
 * Bodhi Interviewer Example
 *
 * Document-driven software interviewer using one persistent subagent.
 *
 * Usage:
 *   1. Set GEMINI_API_KEY in .env or the environment.
 *   2. Run: pnpm tsx examples/interviewer/interviewer-demo.ts
 *   3. In another terminal: pnpm web-client:dev
 *   4. Open the local web client and connect to ws://localhost:9900.
 *
 * Environment Variables:
 *   GEMINI_API_KEY    - Required: Google AI Studio API key
 *   PORT              - WebSocket port (default: 9900)
 *   HOST              - Bind address (default: 0.0.0.0)
 *   GEMINI_LIVE_MODEL - Live model id (default: gemini-3.1-flash-live-preview)
 *   GEMINI_VOICE      - TTS voice (default: Puck)
 *   TRANSCRIPT_DIR    - Directory for per-session WhatsApp-style markdown
 *                       transcripts (default: ./transcripts)
 *
 * The document interviewer subagent uses a fixed Gemini Flash Lite id in code below; override
 * `subagentReasoningModel` there if you need a different planner model.
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { MarkdownConversationHistoryStore } from '../../src/core/markdown-conversation-history-store.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import { loadInterviewDocuments } from './lib/interview-documents.js';
import { createInterviewState, ensurePreparedWithFallback } from './lib/interview-state.js';
import { createInterviewerAgent } from './lib/interviewer-agent.js';
import {
	SoftwareInterviewerSubagent,
	createLowReasoningSubagentProviderOptions,
	createSoftwareInterviewerSubagentConfig,
} from './lib/interviewer-subagent.js';
import { TimingReminderBackgroundAgent } from './lib/timing-reminder-agent.js';

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

const SUBAGENT_THINKING_BUDGET = 128;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
if (!GEMINI_API_KEY) {
	console.error('Error: GEMINI_API_KEY or GOOGLE_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_ID = `interviewer_${Date.now()}`;
// Where the WhatsApp-style markdown transcript for each session is written.
// Each session lands as `{TRANSCRIPT_DIR}/{sessionId}.md`. See
// dev_docs/framework/design-markdown-conversation-history-store.md.
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || './transcripts';
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const REASONING_MODEL = process.env.INTERVIEWER_REASONING_MODEL || 'gemini-2.5-flash';
/** Planner / decision `generateObject` model (edit here or wire your own `LanguageModelV1`). */
const SUBAGENT_GEMINI_MODEL_ID = 'gemini-3.1-flash-lite-preview';
const REALTIME_INPUT_CONFIG = {
	automaticActivityDetection: {
		endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
		silenceDurationMs: 500,
	},
};

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

async function main() {
	const documents = loadInterviewDocuments();
	const state = createInterviewState();
	const reasoningModel = google(REASONING_MODEL);
	const subagentReasoningModel = google(SUBAGENT_GEMINI_MODEL_ID);
	const softwareInterviewerSubagent = new SoftwareInterviewerSubagent(
		'record_answer_and_get_next_question',
		state,
		documents,
		subagentReasoningModel,
		createLowReasoningSubagentProviderOptions(SUBAGENT_THINKING_BUDGET),
	);

	console.log(`${ts()} [Interviewer] Preparing document-grounded interview plan...`);
	try {
		await softwareInterviewerSubagent.prepare();
		console.log(
			`${ts()} [Interviewer] Prepared ${state.questions.length} questions for ${state.companyName ?? 'the company'}`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(
			`${ts()} [Interviewer] Subagent preparation failed; using fallback plan: ${message}`,
		);
		ensurePreparedWithFallback(state, documents, message);
	}

	const softwareInterviewerSubagentConfig = createSoftwareInterviewerSubagentConfig(
		softwareInterviewerSubagent,
	);
	const interviewerAgent = createInterviewerAgent(documents);

	// Periodic time-remaining reminder (5 min interval, 30 min total budget).
	// Demonstrates the actor-mode BackgroundAgent surface: produces wall-clock
	// notifications without holding a VoiceSession reference. See
	// `dev_docs/framework/design-background-notification-actor.md`.
	const timingReminder = new TimingReminderBackgroundAgent(state);

	// Markdown transcript store — emits a per-session .md chat log to
	// TRANSCRIPT_DIR. Configured as a sole store; reads (getSession etc.) are
	// not used by the writer. If you also want queryable history, add a
	// JsonConversationHistoryStore alongside.
	const transcriptStore = new MarkdownConversationHistoryStore({
		baseDir: TRANSCRIPT_DIR,
		modelName: LIVE_MODEL,
		log: (msg) => console.error(`${ts()} [Transcript] ${msg}`),
	});

	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'interviewer_demo_user',
		apiKey: GEMINI_API_KEY,
		agents: [interviewerAgent],
		initialAgent: 'interviewer',
		port: PORT,
		host: HOST,
		model: reasoningModel,
		orchestrationMode: 'actor',
		conversationHistoryStores: [transcriptStore],
		subagentConfigs: {
			record_answer_and_get_next_question: softwareInterviewerSubagentConfig,
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
	console.log('Bodhi — Document-Driven Interviewer Example');
	console.log('============================================================');
	console.log(`  WebSocket:       ws://localhost:${PORT}`);
	console.log(`  Session:         ${SESSION_ID}`);
	console.log(`  Voice model:     ${LIVE_MODEL}`);
	console.log(`  Main model:      ${REASONING_MODEL}`);
	console.log(`  Subagent model:  ${SUBAGENT_MODEL}`);
	console.log(`  Subagent budget: ${SUBAGENT_THINKING_BUDGET}`);
	console.log('  Gemini VAD:      end=HIGH silence=500ms');
	console.log('  Documents:       examples/interviewer/docs/*.md');
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
