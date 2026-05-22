/**
 * Bodhi — Gemini Live + Context Caching Observability
 *
 * A focused voice-assistant demo that uses the Gemini Live API and shows
 * what context-caching support actually looks like on Gemini today.
 *
 * Important context (May 2026):
 *   Gemini Live's BidiGenerateContentSetup has NO `cachedContent` field —
 *   there is no documented way to attach a cached-content resource to a
 *   Live session. Implicit caching that works for `generateContent` does
 *   not currently apply to Live (confirmed by Google staffer in
 *   discuss.ai.google.dev #108063, Dec 2025). The framework therefore
 *   does NOT expose a `cacheConfig` field on `GeminiTransportConfig` —
 *   shipping a no-op safety knob would mislead callers.
 *
 *   See dev_docs/framework/design-context-caching.md §Background and
 *   architecture.md "Session resumption (P2)" for the full rationale.
 *
 * What this demo DOES show:
 *   1. `sessionResumption` — the privacy/ZDR opt-out and the resumable-handle
 *      lifecycle. Toggle SESSION_RESUMPTION_DISABLE=1 to opt out.
 *   2. `compressionConfig` — sliding-window context compression (extends
 *      session length without billing discount; the only Live-side mechanism
 *      to manage long-context behaviour today).
 *   3. `realtime.usage` EventBus event (P4) — provider-aware cache-hit-ratio
 *      observability. `cacheHitRatio` is undefined for Gemini today
 *      (deriveUsageSource → 'gemini.turn.final' → returns undefined per
 *      computeCacheHitRatio's policy, since cachedContentTokenCount: 0 is
 *      "no signal", not a 0% hit). The day Google enables Live caching, the
 *      same code path will surface non-zero ratios automatically.
 *   4. `cachedContentTokenCount` raw value from `usage.modalityBreakdown.cachedTokens`
 *      — directly logged so any nonzero value (i.e. Google flips Live caching
 *      on) is immediately visible without modifying this demo.
 *
 * Pair this with `examples/openai-realtime-tools.ts` to see the OpenAI side,
 * where `cacheConfig.truncation` actually does reduce billing.
 *
 * Usage:
 *   1. Set GEMINI_API_KEY in .env or env
 *   2. Run: pnpm tsx examples/gemini-live-context-caching.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *   4. Try saying:
 *        "What time is it?"
 *        "What is 25 times 17?"
 *        "Goodbye"  (ends the session)
 *   5. Watch the server logs — every model turn prints a [Usage] line
 *      with input/output/cached token counts and the computed cacheHitRatio.
 *
 * Optional flags (env vars):
 *   SESSION_RESUMPTION_DISABLE=1  Pass `sessionResumption: false` (ZDR
 *                                  opt-out — server will not issue handles).
 *                                  Mutually exclusive with _RESUME.
 *   SESSION_RESUMPTION_RESUME=1   Read the handle previously written to
 *                                  .cache/gemini-resumption.handle and
 *                                  resume that session if available.
 *                                  Mutually exclusive with _DISABLE.
 *   (neither set)                  Default: { } (fresh resumable session).
 *                                  The latest server-issued resumable handle
 *                                  is written to the .cache file so a
 *                                  subsequent run with _RESUME=1 picks it up.
 *   COMPRESSION_TRIGGER=8000      triggerTokens (default off).
 *   COMPRESSION_TARGET=4000       slidingWindow.targetTokens (default off).
 *   GEMINI_LIVE_MODEL             Live model (default:
 *                                  gemini-3.1-flash-live-preview).
 */

import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { VoiceSession } from '../src/core/voice-session.js';
import {
	DEFAULT_GEMINI_LIVE_MODEL,
	GeminiLiveTransport,
} from '../src/transport/gemini-live-transport.js';
import type { MainAgent } from '../src/types/agent.js';
import type { ToolContext, ToolDefinition } from '../src/types/tool.js';

// =============================================================================
// Helpers
// =============================================================================

/** Compact timestamp for server logs: HH:MM:SS.mmm */
function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

/** Where the latest resumable handle is persisted across runs. */
const HANDLE_FILE = join(process.cwd(), '.cache', 'gemini-resumption.handle');

function readHandleFromDisk(): string | undefined {
	try {
		const raw = readFileSync(HANDLE_FILE, 'utf8').trim();
		return raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}

function writeHandleToDisk(handle: string): void {
	try {
		mkdirSync(dirname(HANDLE_FILE), { recursive: true });
		writeFileSync(HANDLE_FILE, handle, 'utf8');
	} catch (e) {
		console.warn(`${ts()} [Resumption] failed to persist handle: ${(e as Error).message}`);
	}
}

function clearHandleOnDisk(): void {
	try {
		writeFileSync(HANDLE_FILE, '', 'utf8');
	} catch {
		/* best-effort */
	}
}

// =============================================================================
// Configuration
// =============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
if (GEMINI_API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_ID = `gemini_cache_demo_${Date.now()}`;

const SESSION_RESUMPTION_DISABLE = process.env.SESSION_RESUMPTION_DISABLE === '1';
const SESSION_RESUMPTION_RESUME = process.env.SESSION_RESUMPTION_RESUME === '1';
const COMPRESSION_TRIGGER = Number(process.env.COMPRESSION_TRIGGER) || 0;
const COMPRESSION_TARGET = Number(process.env.COMPRESSION_TARGET) || 0;
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || DEFAULT_GEMINI_LIVE_MODEL;

if (SESSION_RESUMPTION_DISABLE && SESSION_RESUMPTION_RESUME) {
	console.error(
		'Error: SESSION_RESUMPTION_DISABLE and SESSION_RESUMPTION_RESUME are mutually exclusive',
	);
	process.exit(1);
}

// Resolve the actual sessionResumption value the transport will receive.
// `false`  → ZDR opt-out (server will not issue handles).
// `{ handle }` → resume a specific prior session.
// `{}`     → fresh resumable session (server will issue handles).
let sessionResumptionConfig: false | { handle?: string } | undefined;
if (SESSION_RESUMPTION_DISABLE) {
	sessionResumptionConfig = false;
} else if (SESSION_RESUMPTION_RESUME) {
	const handle = readHandleFromDisk();
	if (handle) {
		sessionResumptionConfig = { handle };
		console.log(`${ts()} [Boot] resuming prior session with handle="${handle.slice(0, 8)}…"`);
	} else {
		sessionResumptionConfig = {};
		console.log(`${ts()} [Boot] SESSION_RESUMPTION_RESUME=1 but no handle on disk; starting fresh`);
	}
} else {
	sessionResumptionConfig = undefined; // transport defaults to {}
}

// Google AI SDK provider — required by VoiceSessionConfig.model (used by
// subagents). This demo doesn't ship subagents, but the field is required.
const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

// =============================================================================
// Gemini Live Transport
// =============================================================================
//
// Constructed directly (NOT via VoiceSession's default-construction path)
// because we want to:
//   (a) Demonstrate the `sessionResumption: false` ZDR opt-out — VoiceSession
//       does not surface this through its config (per design-context-caching.md
//       §1, callers wanting the opt-out must inject their own transport).
//   (b) Show explicit `compressionConfig` use.
//
// There is intentionally NO `cacheConfig` field on this transport — Gemini
// Live does not support context caching today (see file header).
const transport = new GeminiLiveTransport(
	{
		apiKey: GEMINI_API_KEY,
		// Use the current documented Live model by default. Override with
		// GEMINI_LIVE_MODEL if your API key or region has a different Live
		// model enabled.
		model: LIVE_MODEL,
		// Session resumption — three modes resolved above:
		//   `false`        → ZDR opt-out, no handles issued
		//   `{ handle }`   → resume a specific prior session
		//   `{}`           → fresh resumable session
		// `undefined` falls through to the transport default ({}).
		...(sessionResumptionConfig !== undefined
			? { sessionResumption: sessionResumptionConfig }
			: {}),
		// Sliding-window context-window compression. The only Live-side
		// mechanism to extend session length under long context. No billing
		// discount — caching for cost reduction is unavailable on Live.
		...(COMPRESSION_TRIGGER > 0 && COMPRESSION_TARGET > 0
			? {
					compressionConfig: {
						triggerTokens: COMPRESSION_TRIGGER,
						targetTokens: COMPRESSION_TARGET,
					},
				}
			: {}),
		inputAudioTranscription: true,
	},
	{
		onResumptionUpdate: (handle, resumable) => {
			// Demonstrates the resumable-true vs resumable-false policy
			// (P2 follow-up): the framework's effectiveResumptionHandle is
			// updated only on resumable: true and CLEARED on resumable: false
			// (forces a fresh-session-with-replay on next reconnect, per
			// Google's docs warning that resuming after non-resumable can
			// lose data).
			//
			// We mirror that policy to disk so subsequent runs of this demo
			// with SESSION_RESUMPTION_RESUME=1 pick up the latest valid
			// handle (or get a clean slate after a non-resumable update).
			const suffix = resumable
				? ' → persisted to .cache/gemini-resumption.handle'
				: ' → handle CLEARED, next reconnect replays history';
			console.log(
				`${ts()} [Resumption] handle="${handle.slice(0, 8)}…" resumable=${resumable}${suffix}`,
			);
			if (resumable) {
				writeHandleToDisk(handle);
			} else {
				clearHandleOnDisk();
			}
		},
		onError: (err) => {
			console.error(`${ts()} [Transport] error:`, err);
		},
	},
);

// =============================================================================
// Tools
// =============================================================================

const calculate: ToolDefinition = {
	name: 'calculate',
	description: 'Evaluate a simple arithmetic expression.',
	parameters: z.object({
		expression: z.string().describe('e.g. "25 * 17"'),
	}),
	execution: 'inline',
	execute: async (args) => {
		const { expression } = args as { expression: string };
		try {
			// Tiny sandboxed evaluator: only digits and basic operators.
			if (!/^[\d\s+\-*/().]+$/.test(expression)) {
				return { error: 'invalid expression (digits and + - * / ( ) only)' };
			}
			const result = new Function(`return (${expression});`)();
			console.log(`${ts()} [Tool] calculate: ${expression} = ${result}`);
			return { expression, result };
		} catch (e) {
			return { error: `Error: ${e instanceof Error ? e.message : 'unknown'}` };
		}
	},
};

const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get the current local date and time.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async () => {
		const now = new Date();
		return { time: now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }) };
	},
};

const endSession: ToolDefinition = {
	name: 'end_session',
	description: 'End the voice session gracefully when the user says goodbye or is done.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx: ToolContext) => {
		console.log(`${ts()} [Tool] end_session`);
		setTimeout(() => ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' }), 3000);
		return { status: 'ending', message: 'Session will close after goodbye.' };
	},
};

// =============================================================================
// Agent
// =============================================================================

const mainAgent: MainAgent = {
	name: 'main',
	greeting:
		'[System: A user just connected. Greet them briefly as Bodhi, mention you can do simple math and tell the time, and ask how you can help.]',
	instructions: `You are Bodhi, a friendly voice assistant.

VOICE & PACING:
- One idea per turn. Keep responses under 3 sentences unless asked.
- Speak in plain language.
- Always use the calculator tool for math — never compute in your head.

TOOLS:
- calculate: simple arithmetic
- get_current_time: current local time
- end_session: when the user says goodbye

When the user says goodbye, give a warm one-sentence farewell and call end_session.`,
	tools: [calculate, getCurrentTime, endSession],
	onEnter: async () => console.log(`${ts()} [Agent] main entered`),
	onExit: async () => console.log(`${ts()} [Agent] main exited`),
};

// =============================================================================
// Main
// =============================================================================

async function main() {
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: GEMINI_API_KEY,
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		// AI SDK provider model — required by VoiceSessionConfig for subagents.
		// Even though this demo doesn't ship subagents, the field is required.
		model: google('gemini-2.5-flash'),
		// IMPORTANT: inject the pre-constructed transport so our
		// sessionResumption / compressionConfig settings take effect.
		// VoiceSession's default-construction path uses no resumption opt-out
		// and no compression.
		transport,
		hooks: {
			onSessionStart: (e) =>
				console.log(`${ts()} [Session] start sessionId=${e.sessionId} agent=${e.agentName}`),
			onSessionEnd: (e) => console.log(`${ts()} [Session] end ${e.reason}`),
			onError: (e) =>
				console.error(`${ts()} [Error] ${e.component}: ${e.error.message} (${e.severity})`),
		},
	});

	// =========================================================================
	// Cache observability — subscribe to realtime.usage (P4)
	// =========================================================================
	//
	// One emission per provider usage callback (Gemini fires interim updates
	// AND a final per turn). Billing aggregation should filter to terminal
	// sources — `gemini.turn.final` for Gemini.
	//
	// `cacheHitRatio` will be UNDEFINED for every Gemini event today —
	// computeCacheHitRatio returns undefined for Gemini sources because
	// `cachedContentTokenCount: 0` is "no signal," not a 0% hit. If Google
	// ever enables Live caching, this branch starts returning real ratios
	// without any code change here.
	//
	// We also surface the raw `cachedTokens` from the modality breakdown so
	// any nonzero value is immediately visible in the demo logs.
	session.eventBus.subscribe('realtime.usage', (evt) => {
		// Skip interim Gemini updates — too noisy for a demo. Real apps
		// might keep them for fine-grained observability.
		if (evt.source === 'gemini.usage.update') return;
		const u = evt.usage;
		const cached = u.modalityBreakdown?.cachedTokens ?? null;
		const ratioStr =
			evt.cacheHitRatio !== undefined
				? `${(evt.cacheHitRatio * 100).toFixed(1)}%`
				: 'undefined (no signal — Gemini Live caching unavailable today)';
		console.log(
			`${ts()} [Usage] turn=${evt.turnId ?? '-'} source=${evt.source} ` +
				`input=${u.inputTokens ?? '?'} output=${u.outputTokens ?? '?'} ` +
				`cachedTokens=${cached ?? 'absent'} cacheHitRatio=${ratioStr}`,
		);
	});

	// `realtime.cache.bust` — Gemini does not currently fire this (the
	// underlying onCacheBust callback is OpenAI-only because Gemini has no
	// in-place session updates that mutate the prefix on the wire). The
	// subscription is harmless and demonstrates the EventBus shape.
	session.eventBus.subscribe('realtime.cache.bust', (evt) => {
		console.log(`${ts()} [CacheBust] ${evt.reason} agent=${evt.agentName}`);
	});

	// Per-turn final transcript log (also useful for verifying whether the
	// model sees the same prefix repeatedly, which is what server-side
	// caching would benefit from once Google enables it on Live).
	let lastIdx = 0;
	session.eventBus.subscribe('turn.end', () => {
		const items = session.conversationContext.items;
		for (const item of items.slice(lastIdx)) {
			if (item.role === 'user' || item.role === 'assistant') {
				const preview = item.content.length > 80 ? `${item.content.slice(0, 77)}…` : item.content;
				console.log(`${ts()}   [${item.role}] ${preview}`);
			}
		}
		lastIdx = items.length;
	});

	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down…`);
		await session.close('user_hangup');
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await session.start();

	console.log('============================================================');
	console.log('Bodhi — Gemini Live + Context Caching Observability');
	console.log('============================================================');
	console.log();
	console.log(`  WebSocket audio: ws://localhost:${PORT}`);
	console.log(`  Session ID:      ${SESSION_ID}`);
	console.log(`  Live model:      ${LIVE_MODEL}`);
	const resumptionLabel =
		sessionResumptionConfig === false
			? 'DISABLED (ZDR opt-out — server will not issue handles)'
			: sessionResumptionConfig?.handle
				? `RESUMING handle="${sessionResumptionConfig.handle.slice(0, 8)}…"`
				: 'enabled — fresh resumable session ({})';
	console.log(`  Resumption:      ${resumptionLabel}`);
	console.log(`  Handle file:     ${HANDLE_FILE}`);
	console.log(
		`  Compression:     ${
			COMPRESSION_TRIGGER > 0 && COMPRESSION_TARGET > 0
				? `trigger=${COMPRESSION_TRIGGER} target=${COMPRESSION_TARGET}`
				: 'off (set COMPRESSION_TRIGGER and COMPRESSION_TARGET to enable)'
		}`,
	);
	console.log('  Cache support:   NOT AVAILABLE on Gemini Live (May 2026)');
	console.log();
	console.log('Try saying:');
	console.log("  - 'What time is it?'");
	console.log("  - 'What is 25 times 17?'");
	console.log("  - 'Goodbye'");
	console.log();
	console.log('Watch [Usage] log lines — they show input/output/cached tokens.');
	console.log('cachedTokens will be 0 (or absent) for every turn until Google');
	console.log('enables Live caching. The day they do, this same demo will');
	console.log('start surfacing non-zero values without code changes.');
	console.log();
	console.log('Resumption demo:');
	console.log('  Run once, talk for a turn or two (a [Resumption] log line will');
	console.log('  appear and the handle is persisted), Ctrl+C, then re-run with');
	console.log('  SESSION_RESUMPTION_RESUME=1 to resume the prior server-side');
	console.log('  session without replaying history.');
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
