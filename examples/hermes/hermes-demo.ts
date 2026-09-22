/**
 * Bodhi + Hermes — Voice-Driven Remote Agent Demo
 *
 * A voice assistant that uses Gemini native audio for conversation and delegates
 * complex work to the user's Hermes agent (by Nous Research) running on a remote
 * VPS through Hermes' OpenAI-compatible HTTP API.
 *
 * Features:
 * - Voice interface: Speak requests naturally
 * - Hermes delegation: Sends coding, research, browsing, file, and productivity
 *   tasks to the user's remote Hermes agent
 * - Persistent Hermes state: Reuses X-Hermes-Session-Id across delegated turns
 * - Google Search: Quick factual lookups via Gemini's built-in grounding
 * - Transcript store: Per-session WhatsApp-style markdown transcript
 * - Graceful shutdown
 *
 * Usage:
 *   1. On the VPS, set ~/.hermes/.env with API_SERVER_ENABLED=true and
 *      API_SERVER_KEY=<secret>, then run: hermes gateway
 *   2. Expose the Hermes API safely (tunnel/reverse proxy) and set env vars below
 *   3. Run: pnpm tsx examples/hermes/hermes-demo.ts
 *   4. In another terminal: pnpm web-client
 *   5. Open http://localhost:8080 in Chrome, click Connect
 *
 * Environment Variables:
 *   GEMINI_API_KEY     - Required: Google AI Studio API key for the voice model
 *   HERMES_URL         - Hermes API base URL without /v1
 *                        (default: http://127.0.0.1:8642)
 *   HERMES_API_KEY     - Required: Hermes API_SERVER_KEY bearer token
 *   HERMES_MODEL       - Hermes model/profile name (default: hermes-agent)
 *   PORT               - Voice agent WebSocket port (default: 9900)
 *   HOST               - Voice agent bind address (default: 0.0.0.0)
 *   TRANSCRIPT_DIR     - Directory for per-session WhatsApp-style markdown
 *                        transcripts (default: ./transcripts)
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { MarkdownConversationHistoryStore } from '../../src/core/markdown-conversation-history-store.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import { askHermesTool, createHermesSubagentConfig } from '../lib/hermes-tools.js';

// =============================================================================
// Helpers
// =============================================================================

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

// =============================================================================
// Configuration
// =============================================================================

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY environment variable is required');
	process.exit(1);
}

const HERMES_API_KEY = process.env.HERMES_API_KEY ?? '';
if (HERMES_API_KEY.length === 0) {
	console.error('Error: HERMES_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const HERMES_URL = process.env.HERMES_URL || 'http://127.0.0.1:8642';
const HERMES_MODEL = process.env.HERMES_MODEL || 'hermes-agent';
const SESSION_ID = `hermes_${Date.now()}`;
// Where the WhatsApp-style markdown transcript for each session is written.
// Each session lands as `{TRANSCRIPT_DIR}/{sessionId}.md`.
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || './transcripts';
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const google = createGoogleGenerativeAI({ apiKey: API_KEY });

// =============================================================================
// Static Tools
// =============================================================================

const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get the current date and time.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async () => {
		return {
			time: new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }),
		};
	},
};

const endSession: ToolDefinition = {
	name: 'end_session',
	description: 'End the voice session gracefully. Call this when the user says goodbye or is done.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx) => {
		setTimeout(() => {
			ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' });
		}, 5000);
		return { status: 'ending' };
	},
};

// =============================================================================
// Main
// =============================================================================

async function main() {
	const hermesSessionId = `${SESSION_ID}_hermes`;
	const hermesSubagent = createHermesSubagentConfig({
		baseUrl: HERMES_URL,
		apiKey: HERMES_API_KEY,
		model: HERMES_MODEL,
		sessionId: hermesSessionId,
	});

	const mainAgent: MainAgent = {
		name: 'main',
		greeting: [
			'[System: A user just connected. Greet them warmly. Introduce yourself as Bodhi,',
			'a voice assistant that can delegate complex work to their Hermes agent running on a VPS.',
			'Keep the greeting brief — 2-3 sentences max.]',
		].join(' '),
		instructions: [
			"You are Bodhi, a concise voice assistant connected to the user's remote Hermes agent.",
			"Hermes is a Nous Research agent running on the user's VPS with its own tools and memory.",
			'',
			'TOOL ROUTING:',
			'- ask_hermes: Delegate complex or action-oriented tasks to Hermes.',
			'  Use it for coding, debugging, repo/file operations, research, web browsing, data analysis,',
			'  writing, email/productivity requests, and any multi-step task that should run on the VPS.',
			'- Google Search: Use Gemini native search for quick factual lookups only.',
			'- get_current_time: Current date/time.',
			'- end_session: When the user says goodbye.',
			'',
			'VOICE RULES:',
			'- Keep responses short and clear (2-3 sentences).',
			'- Do not read code, logs, or long markdown aloud; summarize the outcome.',
			'- If Hermes asks for clarification, relay one concise question to the user.',
			'- Never claim Hermes completed an external action unless Hermes confirmed it.',
			'- Do not expose internal routing details unless the user asks how the system works.',
		].join('\n'),
		tools: [askHermesTool, getCurrentTime, endSession],
		googleSearch: true,
		onEnter: async () => {
			console.log(`${ts()} [Agent] Main agent entered`);
		},
	};

	// -------------------------------------------------------------------------
	// Markdown transcript store — emits a per-session .md chat log to
	// TRANSCRIPT_DIR. Configured as a sole store; reads (getSession etc.) are
	// not used by the writer. If you also want queryable history, add a
	// JsonConversationHistoryStore alongside.
	// -------------------------------------------------------------------------
	const transcriptStore = new MarkdownConversationHistoryStore({
		baseDir: TRANSCRIPT_DIR,
		modelName: LIVE_MODEL,
		log: (msg) => console.error(`${ts()} [Transcript] ${msg}`),
	});

	// -------------------------------------------------------------------------
	// Voice Session
	// -------------------------------------------------------------------------
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.5-flash'),
		orchestrationMode: 'actor',
		conversationHistoryStores: [transcriptStore],
		subagentConfigs: {
			ask_hermes: hermesSubagent,
		},
		geminiModel: LIVE_MODEL,
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-3-flash-preview' }),
		speechConfig: { voiceName: 'Puck' },
		hooks: {
			onSessionStart: (event) => {
				console.log(`${ts()} [Session] Started: ${event.sessionId}`);
			},
			onSessionEnd: (event) => {
				console.log(`${ts()} [Session] Ended: ${event.sessionId} (${event.reason})`);
			},
			onToolCall: (event) => {
				console.log(`${ts()} [Hook] Tool called: ${event.toolName} (${event.execution})`);
			},
			onToolResult: (event) => {
				console.log(
					`${ts()} [Hook] Tool result: ${event.toolCallId} (${event.status}, ${event.durationMs}ms)`,
				);
			},
			onSubagentStep: (event) => {
				console.log(
					`${ts()} [Hook] Subagent step: ${event.subagentName} #${event.stepNumber} tools=[${event.toolCalls.join(',')}]`,
				);
			},
			onError: (event) => {
				console.error(
					`${ts()} [Error] ${event.component}: ${event.error.message} (${event.severity})`,
				);
			},
		},
	});

	// Log conversation turns
	let lastLoggedIndex = 0;
	session.eventBus.subscribe('turn.end', (payload) => {
		console.log(`${ts()} [Event] Turn ended: ${payload.turnId}`);
		const items = session.conversationContext.items;
		const newItems = items.slice(lastLoggedIndex);
		lastLoggedIndex = items.length;
		for (const item of newItems) {
			if (item.role === 'user' || item.role === 'assistant') {
				console.log(`${ts()}   [${item.role}] ${item.content}`);
			}
		}
	});

	// Shutdown handler
	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session.close('user_hangup');
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Start
	await session.start();

	console.log('============================================================');
	console.log('Bodhi + Hermes — Voice-Driven Remote Agent');
	console.log('============================================================');
	console.log();
	console.log(`  Voice agent:     ws://localhost:${PORT}`);
	console.log(`  Hermes endpoint: ${HERMES_URL.replace(/\/$/, '')}/v1`);
	console.log(`  Hermes model:    ${HERMES_MODEL}`);
	console.log(`  Hermes session:  ${hermesSessionId}`);
	console.log(`  Session ID:      ${SESSION_ID}`);
	console.log(`  Transcript:      ${TRANSCRIPT_DIR}/${SESSION_ID}.md`);
	console.log();
	console.log('Start the web client in another terminal:');
	console.log('  pnpm web-client');
	console.log();
	console.log('Then open http://localhost:8080 and try saying:');
	console.log("  - 'What is the weather in San Francisco?'      (Gemini Search)");
	console.log("  - 'Ask Hermes to inspect my project files'     (Hermes delegation)");
	console.log("  - 'Have Hermes write a Python prime checker'   (Hermes coding)");
	console.log("  - 'Ask Hermes to research deployment options'  (Hermes research)");
	console.log("  - 'Goodbye'");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
