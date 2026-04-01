/**
 * Twilio Human Transfer Demo
 *
 * Demonstrates the human agent transfer feature: the voice AI can transfer
 * a live call to a real human over the phone via Twilio, then resume the
 * AI conversation when the human hangs up.
 *
 * Usage:
 *   1. Set environment variables in .env:
 *      GEMINI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 *      TWILIO_FROM_NUMBER, HUMAN_AGENT_PHONE, TWILIO_WEBHOOK_URL
 *   2. Run: pnpm tsx examples/twilio-demo.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *   4. Say: "Transfer me to a human" or "I need to talk to a real person"
 *   5. Your phone will ring. When you answer, you'll hear the web client user.
 *   6. Hang up to return to the AI agent.
 *
 * Requirements:
 *   - Twilio account with a verified phone number
 *   - ngrok or similar for webhook URL (Twilio needs to reach your server)
 *   - Start ngrok: ngrok http 8766  (then set TWILIO_WEBHOOK_URL to the https URL)
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { VoiceSession } from '../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent } from '../src/types/agent.js';
import type { ToolContext, ToolDefinition } from '../src/types/tool.js';
import { createHumanAgent } from './lib/twilio-human-agent.js';

// =============================================================================
// Configuration
// =============================================================================

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (!API_KEY) {
	console.error('Error: GEMINI_API_KEY is required');
	process.exit(1);
}

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? '';
const HUMAN_AGENT_PHONE = process.env.HUMAN_AGENT_PHONE ?? '';
const TWILIO_WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL ?? '';

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
	console.error(
		'Error: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are required',
	);
	process.exit(1);
}
if (!HUMAN_AGENT_PHONE) {
	console.error('Error: HUMAN_AGENT_PHONE is required (the phone number to dial)');
	process.exit(1);
}
if (!TWILIO_WEBHOOK_URL) {
	console.error(
		'Error: TWILIO_WEBHOOK_URL is required (public URL for Twilio webhooks, e.g., ngrok)',
	);
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const TWILIO_WEBHOOK_PORT = Number(process.env.TWILIO_WEBHOOK_PORT) || 8766;
const SESSION_ID = `session_${Date.now()}`;
const google = createGoogleGenerativeAI({ apiKey: API_KEY });

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

// =============================================================================
// Tools
// =============================================================================

const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get the current date and time.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async () => ({
		time: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
	}),
};

const endSession: ToolDefinition = {
	name: 'end_session',
	description: 'End the voice session when the user says goodbye.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx: ToolContext) => {
		setTimeout(() => {
			ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' });
		}, 5000);
		return { status: 'ending' };
	},
};

const transferTool: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer the conversation to another agent.
- "human_agent": Transfer to a real human on the phone. Use when the user asks to speak with a person.`,
	parameters: z.object({
		agent_name: z.enum(['human_agent']).describe('The agent to transfer to'),
	}),
	execution: 'inline',
	execute: async () => ({ status: 'transferred' }),
};

// =============================================================================
// Agents
// =============================================================================

const humanAgent = createHumanAgent({
	phoneNumber: HUMAN_AGENT_PHONE,
	twilioAccountSid: TWILIO_ACCOUNT_SID,
	twilioAuthToken: TWILIO_AUTH_TOKEN,
	twilioFromNumber: TWILIO_FROM_NUMBER,
	twilioWebhookUrl: TWILIO_WEBHOOK_URL,
	twilioWebhookPort: TWILIO_WEBHOOK_PORT,
	returnAgent: 'main',
});

const mainAgent: MainAgent = {
	name: 'main',
	greeting:
		'[System: Greet the user. You are Bodhi, a voice assistant. You can tell the time, transfer to a human agent on the phone, or end the session. Keep it brief.]',
	instructions: `You are Bodhi, a friendly voice assistant.

CAPABILITIES:
- Tell the current time
- Transfer to a real human on the phone when asked
- End the session when the user says goodbye

TOOL ROUTING:
- get_current_time: When the user asks what time it is
- transfer_to_agent with agent_name "human_agent": When the user says they need a human, want to talk to a person, or asks to be transferred
- end_session: When the user says goodbye

CRITICAL TOOL CALLING RULES:
- When the user asks to speak with a human, you MUST call the transfer_to_agent tool with agent_name "human_agent". Do NOT just say "connecting you" or "transferring you" — speaking those words does NOTHING. The tool call is the ONLY way to initiate the transfer. If you do not call the tool, the user will NOT be connected.
- You MUST call the tool IMMEDIATELY when the user requests a human. Do not ask for confirmation. Do not explain what will happen. Just call the tool.
- Keep responses brief — this is voice, not text.`,
	tools: [getCurrentTime, endSession, transferTool],
	googleSearch: true,
	onEnter: async () => console.log(`${ts()} [Agent] Main agent entered`),
	onExit: async () => console.log(`${ts()} [Agent] Main agent exited`),
};

// =============================================================================
// Start
// =============================================================================

async function main() {
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent, humanAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.5-flash'),
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-3-flash-preview' }),
		speechConfig: { voiceName: 'Puck' },
		hooks: {
			onSessionStart: (e) => console.log(`${ts()} [Session] Started: ${e.sessionId}`),
			onSessionEnd: (e) => console.log(`${ts()} [Session] Ended: ${e.sessionId}`),
			onToolCall: (e) => console.log(`${ts()} [Hook] Tool called: ${e.toolName} (${e.execution})`),
			onToolResult: (e) => console.log(`${ts()} [Hook] Tool result: ${e.toolName} (${e.durationMs}ms)`),
			onAgentTransfer: (e) =>
				console.log(`${ts()} [Transfer] ${e.fromAgent} → ${e.toAgent}`),
			onError: (e) =>
				console.error(`${ts()} [Error] ${e.component}: ${e.error}`),
		},
	});

	await session.start();

	console.log(`
╔══════════════════════════════════════════════════════════╗
║  Twilio Human Transfer Demo                              ║
║                                                          ║
║  Voice WS:  ws://${HOST}:${PORT}                         ║
║  Twilio WH: ${TWILIO_WEBHOOK_URL}                        ║
║  Human Phone: ${HUMAN_AGENT_PHONE}                       ║
║                                                          ║
║  Say "transfer me to a human" to test the transfer       ║
╚══════════════════════════════════════════════════════════╝
`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
