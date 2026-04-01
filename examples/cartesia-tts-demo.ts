/**
 * Cartesia TTS Voice Demo
 *
 * A simple voice assistant that uses Cartesia for speech synthesis instead of
 * Gemini's native audio. Demonstrates the pluggable TTS provider with custom
 * voice, speed, and emotion controls.
 *
 * The LLM requests dual output modalities (AUDIO + TEXT). The app consumes
 * only the TEXT stream and sends it to Cartesia for ultra-low-latency TTS.
 *
 * Features:
 * - Custom Cartesia voice (configurable via CARTESIA_VOICE_ID)
 * - Speed control via Cartesia's speed parameter
 * - Emotion tags via Cartesia's experimental controls
 * - Calculator, time, and end_session tools
 * - Real-time word boundary events for caption sync
 *
 * Usage:
 *   1. Set GEMINI_API_KEY and CARTESIA_API_KEY in .env or environment
 *   2. Optionally set CARTESIA_VOICE_ID (defaults to "a0e99841-438c-4a64-b679-ae501e7d6091")
 *   3. Run: pnpm tsx examples/cartesia-tts-demo.ts
 *   4. In another terminal: pnpm web-client:dev
 *   5. Open http://localhost:8080 in Chrome, click Connect
 *
 * Environment Variables:
 *   GEMINI_API_KEY      - Required: Google AI Studio API key
 *   CARTESIA_API_KEY    - Required: Cartesia API key
 *   CARTESIA_VOICE_ID   - Cartesia voice ID (default: Barbershop Man)
 *   CARTESIA_SPEED      - Speed: slowest/slow/normal/fast/fastest (default: normal)
 *   CARTESIA_EMOTION    - Comma-separated emotions, e.g. "cheerful,friendly" (default: none)
 *   PORT                - WebSocket port (default: 9900)
 *   HOST                - Bind address (default: 0.0.0.0)
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { VoiceSession } from '../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../src/transport/gemini-batch-stt-provider.js';
import { CartesiaTTSProvider } from '../src/transport/cartesia-tts-provider.js';
import type { MainAgent } from '../src/types/agent.js';
import type { ToolDefinition, ToolContext } from '../src/types/tool.js';

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
if (!API_KEY) {
	console.error('Error: GEMINI_API_KEY environment variable is required');
	process.exit(1);
}

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY ?? '';
if (!CARTESIA_API_KEY) {
	console.error('Error: CARTESIA_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091'; // Barbershop Man
const SPEED = (process.env.CARTESIA_SPEED || 'normal') as
	| 'slowest'
	| 'slow'
	| 'normal'
	| 'fast'
	| 'fastest';
const EMOTION = process.env.CARTESIA_EMOTION?.split(',').filter(Boolean) ?? [];
const DEFAULT_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

const SESSION_ID = `session_${Date.now()}`;
const google = createGoogleGenerativeAI({ apiKey: API_KEY });

// =============================================================================
// Tools
// =============================================================================

const calculate: ToolDefinition = {
	name: 'calculate',
	description:
		'Evaluate a mathematical expression. Supports: sqrt, sin, cos, tan, log, log10, exp, abs, round, pow, pi, e.',
	parameters: z.object({
		expression: z.string().describe('The mathematical expression to evaluate'),
	}),
	execution: 'inline',
	execute: async (args) => {
		const { expression } = args as { expression: string };
		const mathFunctions: Record<string, unknown> = {
			sqrt: Math.sqrt,
			sin: Math.sin,
			cos: Math.cos,
			tan: Math.tan,
			log: Math.log,
			log10: Math.log10,
			exp: Math.exp,
			abs: Math.abs,
			round: Math.round,
			pow: Math.pow,
			pi: Math.PI,
			e: Math.E,
			PI: Math.PI,
			E: Math.E,
		};
		try {
			const safeExpression = expression.replace(
				/\b(sqrt|sin|cos|tan|log|log10|exp|abs|round|pow|pi|PI|e|E)\b/g,
				(match) => `mathFunctions.${match.toLowerCase()}`,
			);
			const fn = new Function('mathFunctions', `return ${safeExpression}`);
			const result = fn(mathFunctions);
			console.log(`${ts()} [Tool] calculate: ${expression} = ${result}`);
			return { expression, result };
		} catch (error) {
			return { error: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` };
		}
	},
};

const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get the current date and time. Optionally specify a timezone.',
	parameters: z.object({
		timezone: z.string().optional().describe('Timezone (e.g. "UTC", "America/Los_Angeles")'),
	}),
	execution: 'inline',
	execute: async (args) => {
		const { timezone } = args as { timezone?: string };
		const now = new Date();
		try {
			const formatted = now.toLocaleString('en-US', {
				...(timezone ? { timeZone: timezone } : {}),
				dateStyle: 'full',
				timeStyle: 'long',
			});
			return { timezone: timezone ?? 'local', time: formatted };
		} catch {
			return { timezone: 'UTC', time: now.toISOString() };
		}
	},
};

const endSession: ToolDefinition = {
	name: 'end_session',
	description: 'End the voice session. Call when the user says goodbye or is done.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx: ToolContext) => {
		console.log(`${ts()} [Tool] end_session`);
		setTimeout(() => {
			ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' });
		}, 5000);
		return { status: 'ending' };
	},
};

// =============================================================================
// Agent
// =============================================================================

const mainAgent: MainAgent = {
	name: 'main',
	greeting:
		'[System: A user connected. Greet them. You are Bodhi, a friendly voice assistant powered by Cartesia voice synthesis. Mention you can help with calculations, tell the time, or just chat. Keep it brief and warm.]',
	instructions: `You are Bodhi, a friendly and helpful voice assistant.

RULES:
- Keep responses concise — 1 to 3 sentences.
- Be warm and conversational.
- Use the calculator for math, get_current_time for time questions.
- When the user says goodbye, call end_session.
- Never say "As an AI" or "As a language model".

TOOLS:
- calculate: Math expressions
- get_current_time: Current date/time
- end_session: End the session on goodbye`,
	tools: [calculate, getCurrentTime, endSession],
};

// =============================================================================
// Start
// =============================================================================

async function main() {
	const geminiLiveModel = process.env.GEMINI_LIVE_MODEL || DEFAULT_LIVE_MODEL;

	// Create Cartesia TTS provider
	const ttsProvider = new CartesiaTTSProvider({
		apiKey: CARTESIA_API_KEY,
		voiceId: VOICE_ID,
		modelId: 'sonic-2',
		speed: SPEED,
		emotion: EMOTION.length > 0 ? EMOTION : undefined,
		language: 'en',
	});

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
		ttsProvider,
		// Use a live model that can emit text; external TTS handles speech synthesis.
		geminiModel: geminiLiveModel,
		speechConfig: { voiceName: 'Puck' },
		sttProvider: new GeminiBatchSTTProvider({
			apiKey: API_KEY,
			model: 'gemini-3-flash-preview',
		}),
		hooks: {
			onSessionStart: (e) => console.log(`${ts()} [Session] Started: ${e.sessionId}`),
			onSessionEnd: (e) => console.log(`${ts()} [Session] Ended (${e.reason})`),
			onToolCall: (e) => console.log(`${ts()} [Tool] ${e.toolName} (${e.execution})`),
			onTTSSynthesis: (e) =>
				console.log(
					`${ts()} [TTS] Synthesis done: ${e.textLength} chars, TTFB ${e.ttfbMs}ms, total ${e.durationMs}ms`,
				),
			onError: (e) =>
				console.error(`${ts()} [Error] ${e.component}: ${e.error.message} (${e.severity})`),
		},
	});

	// Log conversation turns
	let lastIdx = 0;
	session.eventBus.subscribe('turn.end', (payload) => {
		console.log(`${ts()} [Turn] ${payload.turnId}`);
		const items = session.conversationContext.items;
		for (const item of items.slice(lastIdx)) {
			if (item.role === 'user' || item.role === 'assistant') {
				console.log(`${ts()}   [${item.role}] ${item.content}`);
			}
		}
		lastIdx = items.length;
	});

	// Shutdown
	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session.close('user_hangup');
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await session.start();

	console.log('============================================================');
	console.log('Bodhi — Cartesia TTS Voice Demo');
	console.log('============================================================');
	console.log();
	console.log(`  WebSocket: ws://localhost:${PORT}`);
	console.log(`  Session:   ${SESSION_ID}`);
	console.log(`  Voice:     ${VOICE_ID}`);
	console.log(`  Speed:     ${SPEED}`);
	console.log(`  Emotion:   ${EMOTION.length > 0 ? EMOTION.join(', ') : '(none)'}`);
	console.log(`  Model:     ${geminiLiveModel} (AUDIO+TEXT; text stream → Cartesia sonic-2)`);
	console.log();
	console.log('Connect via: pnpm web-client:dev');
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
