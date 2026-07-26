/**
 * Bodhi + Sutando — Voice-Driven Personal Agent Demo
 *
 * A voice assistant (Gemini native audio) that delegates real work to the
 * user's Sutando agent on their MacBook — email, calendar, meetings, files,
 * screen, coding — through Sutando's remote-gateway relay protocol. The Mac
 * dials OUT to this process (no inbound port, tunnel, or Mac reconfiguration),
 * so this demo can run anywhere close to the user: on the MacBook itself, a
 * GCP VM, or a LAN box. See dev_docs/design-sutando-persistent-subagent.md.
 *
 * Mirrors examples/hermes/hermes-demo.ts with two deliberate deviations:
 *  (a) the voice WebSocket binds to 127.0.0.1 by default and FAILS CLOSED on
 *      a non-loopback HOST unless VOICE_FRONT_AUTH_CONFIRMED=true attests to
 *      an authenticated front (proxy/VPN/allowlist + Origin checking);
 *  (b) end_session actually closes the VoiceSession, so the persistent
 *      Sutando instance is disposed and no ghost tasks outlive "goodbye".
 *
 * Setup (Mac side — one channel .env, no code changes):
 *   REMOTE_TASK_URL=<this host's relay URL>
 *   REMOTE_TASK_TOKEN=<same value as SUTANDO_RELAY_TOKEN here>
 *   then: bash src/startup.sh   (starts the bridge alongside everything else)
 *
 * Environment Variables:
 *   GEMINI_API_KEY               - Required: Google AI Studio API key
 *   SUTANDO_RELAY_TOKEN          - Required: bearer the Mac's bridge presents
 *   SUTANDO_RELAY_PORT           - Relay listen port (default: 7930)
 *   SUTANDO_RELAY_HOST           - Relay bind host (default: 127.0.0.1);
 *                                  non-loopback needs SUTANDO_RELAY_ALLOW_NONLOOPBACK=true
 *   PORT                         - Voice agent WebSocket port (default: 9900)
 *   HOST                         - Voice agent bind (default: 127.0.0.1);
 *                                  non-loopback needs VOICE_FRONT_AUTH_CONFIRMED=true
 *   TRANSCRIPT_DIR               - Per-session transcripts + raw sidecar (default: ./transcripts)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { MarkdownConversationHistoryStore } from '../../src/core/markdown-conversation-history-store.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
import { DEFAULT_GEMINI_LIVE_MODEL } from '../../src/transport/gemini-live-transport.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import { SutandoRelayServer } from '../lib/sutando-relay-server.js';
import { SutandoTaskLedger } from '../lib/sutando-task-ledger.js';
import {
	ASK_SUTANDO_TOOL_NAME,
	createSutandoAgentConfig,
	validateSutandoWiring,
} from '../lib/sutando-tools.js';

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

const RELAY_TOKEN = process.env.SUTANDO_RELAY_TOKEN ?? '';
if (RELAY_TOKEN.length === 0) {
	console.error('Error: SUTANDO_RELAY_TOKEN environment variable is required');
	console.error('Generate one (e.g. `openssl rand -hex 32`) and set the same value as');
	console.error("REMOTE_TASK_TOKEN in the Mac's Sutando channel .env.");
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '127.0.0.1';
const RELAY_PORT = Number(process.env.SUTANDO_RELAY_PORT) || 7930;
const RELAY_HOST = process.env.SUTANDO_RELAY_HOST || '127.0.0.1';
const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR || './transcripts';
const LEDGER_DIR = process.env.SUTANDO_LEDGER_DIR || './sutando-ledger';
const SESSION_ID = `sutando_${Date.now()}`;
// Google Search grounding — ON by default (SUTANDO_GOOGLE_SEARCH=0 disables).
const GOOGLE_SEARCH = process.env.SUTANDO_GOOGLE_SEARCH !== '0';
// Live model — always the 3.1 Live model (~1.32s replies with a 62ms spread;
// probed 2026-07-26, dev_docs/framework/investigation-sutando-voice-latency.md).
// Caveat: on a FREE-TIER key, declaring google_search at connect on this model
// is rejected with 1011 "quota exceeded" (the grounding entitlement, not a
// rate limit) — set SUTANDO_GOOGLE_SEARCH=0 there and lookups fall back to
// ask_sutando. SUTANDO_LIVE_MODEL overrides the model if needed.
const LIVE_MODEL = process.env.SUTANDO_LIVE_MODEL || DEFAULT_GEMINI_LIVE_MODEL;
const google = createGoogleGenerativeAI({ apiKey: API_KEY });

// Deviation (a): fail closed on a non-loopback voice bind — the voice WS is
// unauthenticated, and whoever reaches it can issue owner-tier delegations.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK.has(HOST) && process.env.VOICE_FRONT_AUTH_CONFIRMED !== 'true') {
	console.error(`Error: HOST=${HOST} binds the (unauthenticated) voice WebSocket beyond loopback.`);
	console.error('Front it with an authenticated layer (TLS proxy + session auth, VPN/tailnet, or');
	console.error('network allowlist + Origin checking), then set VOICE_FRONT_AUTH_CONFIRMED=true.');
	console.error('See dev_docs/design-sutando-persistent-subagent.md §6.');
	process.exit(1);
}

// =============================================================================
// Static tools
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

// =============================================================================
// Main
// =============================================================================

async function main() {
	// ---------------------------------------------------------------------------
	// Relay — the four-endpoint gateway contract the Mac's bridge long-polls.
	// ---------------------------------------------------------------------------
	const relay = new SutandoRelayServer({
		token: RELAY_TOKEN,
		port: RELAY_PORT,
		host: RELAY_HOST,
		allowNonLoopbackBind: process.env.SUTANDO_RELAY_ALLOW_NONLOOPBACK === 'true',
		// M2 durability: the ledger makes acked work recoverable across restarts
		// (IDs, states, one-line descriptions only — never result content).
		ledger: new SutandoTaskLedger({ dir: LEDGER_DIR }),
		log: (line) => console.log(`${ts()} [Relay] ${line}`),
	});
	await relay.start();

	// ---------------------------------------------------------------------------
	// Sutando wiring — session-scoped; hooks late-bind to the session below.
	// ---------------------------------------------------------------------------
	let session: VoiceSession | null = null;
	const rawDir = join(TRANSCRIPT_DIR, `${SESSION_ID}-raw`);
	const wiring = createSutandoAgentConfig({
		relay,
		sessionId: SESSION_ID,
		userId: 'demo_user',
		// Keeps the persona's tool-routing lines in sync with the declared tools:
		// when search is off, the fragment must not advertise it (the model would
		// route "quick lookups" to a tool it cannot call).
		googleSearch: GOOGLE_SEARCH,
		hooks: {
			notifySystem: (text) => session?.publishSystemNotification(text),
			recordRaw: (taskId, raw) => {
				// Raw retention policy: full bodies go only to this owner-controlled
				// per-session sidecar — never into logs or the live context.
				mkdirSync(rawDir, { recursive: true });
				writeFileSync(join(rawDir, `${taskId}.txt`), raw);
			},
		},
	});

	const endSession: ToolDefinition = {
		name: 'end_session',
		description:
			'End the voice session gracefully. Call this when the user says goodbye or is done.',
		parameters: z.object({}),
		execution: 'inline',
		execute: async (_args, ctx) => {
			setTimeout(() => {
				ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' });
				// Deviation (b): actually close the VoiceSession so dispose() runs —
				// undelivered Sutando tasks are cancelled, delivered ones orphaned,
				// and no late result is ever spoken into a future conversation.
				void session?.close('user_goodbye');
			}, 5000);
			return { status: 'ending' };
		},
	};

	const mainAgent: MainAgent = {
		name: 'main',
		greeting: [
			'[System: A user just connected. Greet them warmly. Introduce yourself as Bodhi,',
			'a voice assistant connected to their Sutando agent on their Mac.',
			'Keep the greeting brief — 2-3 sentences max.]',
		].join(' '),
		onEnter: async () => {
			console.log(`${ts()} [Agent] Main agent entered`);
			// M2 reaper: surface each due recovery notice ONCE, in the opening
			// brief — class-worded (dropped → "redo?"; delivered-unclaimed →
			// "may have completed, archived"). Draining marks them consumed.
			relay.reapNow();
			for (const notice of relay.drainRecoveryNotices()) {
				session?.publishSystemNotification(notice.text);
			}
		},
		instructions: [
			"You are Bodhi, a concise voice assistant connected to the user's Sutando agent.",
			"Sutando is the user's personal AI agent running on their Mac with full access to their",
			'email, calendar, meetings, phone, files, and screen. It remembers them across sessions.',
			'',
			wiring.personaFragment,
			'- get_current_time: Current date/time.',
			'- end_session: When the user says goodbye.',
		].join('\n'),
		tools: [wiring.tool, getCurrentTime, endSession],
		// Declared to Gemini only when enabled — see the free-tier caveat on the
		// GOOGLE_SEARCH const above. (This agent-level flag works here because the
		// demo uses VoiceSession's built-in transport construction, which forwards it.)
		googleSearch: GOOGLE_SEARCH,
	};

	const transcriptStore = new MarkdownConversationHistoryStore({
		baseDir: TRANSCRIPT_DIR,
		modelName: LIVE_MODEL,
		log: (msg) => console.error(`${ts()} [Transcript] ${msg}`),
	});

	// Fail fast on any wiring invariant before constructing the session —
	// a half-wired config silently degrades to non-persistent execution.
	const sessionConfig = {
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.5-flash'),
		orchestrationMode: 'actor' as const,
		conversationHistoryStores: [transcriptStore],
		subagentConfigs: {
			[ASK_SUTANDO_TOOL_NAME]: wiring.subagentConfig,
		},
		geminiModel: LIVE_MODEL,
		// Gemini's input-commit latency (client-VAD end → first model activity)
		// runs 5.5-7.5s on live audio; the framework's 5s default watchdog would
		// fire mid-turn and the forced reconnect truncates the in-flight reply.
		responseWatchdogMs: 12_000,
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-3-flash-preview' }),
		speechConfig: { voiceName: 'Puck' as const },
		hooks: {
			onSessionStart: (event: { sessionId: string }) => {
				console.log(`${ts()} [Session] Started: ${event.sessionId}`);
			},
			onSessionEnd: (event: { sessionId: string; reason: string }) => {
				console.log(`${ts()} [Session] Ended: ${event.sessionId} (${event.reason})`);
			},
			onToolCall: (event: { toolName: string; execution: string }) => {
				console.log(`${ts()} [Hook] Tool called: ${event.toolName} (${event.execution})`);
			},
			onError: (event: { component: string; error: Error; severity: string }) => {
				console.error(
					`${ts()} [Error] ${event.component}: ${event.error.message} (${event.severity})`,
				);
			},
		},
	};
	validateSutandoWiring(sessionConfig);

	session = new VoiceSession(sessionConfig);

	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session?.close('user_hangup');
		await relay.stop();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await session.start();

	console.log('============================================================');
	console.log('Bodhi + Sutando — Voice-Driven Personal Agent');
	console.log('============================================================');
	console.log();
	console.log(`  Voice agent:   ws://${HOST}:${PORT}`);
	console.log(`  Relay:         ${relay.url}  (Mac's REMOTE_TASK_URL)`);
	console.log(`  Task prefix:   ${wiring.taskIdPrefix}`);
	console.log(`  Session ID:    ${SESSION_ID}`);
	console.log(`  Transcript:    ${TRANSCRIPT_DIR}/${SESSION_ID}.md`);
	console.log(`  Raw sidecar:   ${rawDir}/`);
	console.log(`  Mac presence:  ${relay.presence().fresh ? 'online' : 'no heartbeat yet'}`);
	console.log(`  Live model:    ${LIVE_MODEL}`);
	console.log(
		`  Search:        ${GOOGLE_SEARCH ? 'Gemini grounding enabled (free-tier keys: set SUTANDO_GOOGLE_SEARCH=0 if connect fails with 1011)' : 'off — quick lookups route to ask_sutando'}`,
	);
	console.log();
	console.log('Start the web client in another terminal:');
	console.log('  pnpm tsx examples/openclaw/web-client.ts');
	console.log();
	console.log('Then open http://localhost:8080 and try saying:');
	console.log(
		GOOGLE_SEARCH
			? "  - 'What is the weather in San Francisco?'          (Gemini Search)"
			: "  - 'What is the weather in San Francisco?'          (delegated to Sutando)",
	);
	console.log("  - 'Ask Sutando to check my email for invoices'     (Sutando delegation)");
	console.log("  - 'Have Sutando join my 2pm meeting'               (Sutando meetings)");
	console.log("  - 'What time is it?'                               (inline tool)");
	console.log("  - 'Goodbye'");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
