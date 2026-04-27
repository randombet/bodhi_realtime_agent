// SPDX-License-Identifier: MIT

/**
 * Bodhi — Senior-Friendly Voice Assistant with Deepgram Nova-3 Live STT
 *
 * A warm, patient voice assistant designed for older adults. Built with
 * the Bodhi Realtime Agent Framework using Gemini Live for realtime audio
 * and Deepgram Nova-3 live streaming for low-latency user transcription.
 *
 * Features:
 * - Senior-friendly: Slow pacing, plain language, one idea per turn
 * - Deepgram Nova-3 live STT: Partial and final user transcripts
 * - Function tools: Calculator, current time, speech speed, image generation
 * - Multi-agent: Transfers to a patient math helper for harder questions
 * - Session management: Graceful goodbye with end_session tool
 *
 * Usage:
 *   1. Set GEMINI_API_KEY and DEEPGRAM_API_KEY in .env or as environment variables
 *   2. Run: pnpm tsx examples/gemini-deepgram-streaming-stt.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *   4. Try saying:
 *        "What time is it?"
 *        "What is 25 times 17?"
 *        "I need help with harder math" (transfers to math helper)
 *        "Goodbye" (ends session gracefully)
 */

import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { VoiceSession } from '../src/core/voice-session.js';
import { DeepgramSTTProvider } from '../src/transport/deepgram-stt-provider.js';
import type { MainAgent } from '../src/types/agent.js';
import type { ToolContext, ToolDefinition } from '../src/types/tool.js';

// =============================================================================
// Helpers
// =============================================================================

/** Compact timestamp for server logs: HH:MM:SS.mmm */
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

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? '';
if (DEEPGRAM_API_KEY.length === 0) {
	console.error('Error: DEEPGRAM_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0'; // '0.0.0.0' binds to all interfaces for EC2
const SESSION_ID = `session_${Date.now()}`;

// =============================================================================
// Custom Tools
// =============================================================================

/**
 * Calculator tool — evaluates mathematical expressions safely.
 */
const calculate: ToolDefinition = {
	name: 'calculate',
	description: `Evaluate a mathematical expression.
Supports: sqrt, sin, cos, tan, log, log10, exp, abs, round, pow, pi, e
Examples: "2 + 2", "sqrt(16)", "sin(pi/2)", "pow(2, 10)"`,
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
			return {
				error: `Error evaluating "${expression}": ${error instanceof Error ? error.message : 'Unknown error'}`,
			};
		}
	},
};

/**
 * Current time tool — returns the current date/time in any timezone.
 */
const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get the current date and time. Optionally specify a timezone.',
	parameters: z.object({
		timezone: z
			.string()
			.optional()
			.describe('Timezone name (e.g., "UTC", "America/Los_Angeles"). Defaults to local time.'),
	}),
	execution: 'inline',
	execute: async (args) => {
		const { timezone } = args as { timezone?: string };
		const now = new Date();
		try {
			if (timezone) {
				const formatted = now.toLocaleString('en-US', {
					timeZone: timezone,
					dateStyle: 'full',
					timeStyle: 'long',
				});
				return { timezone, time: formatted };
			}
			return {
				timezone: 'local',
				time: now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }),
			};
		} catch {
			return { timezone: 'UTC', time: now.toISOString() };
		}
	},
};

/**
 * Slow web search tool — demonstrates handling of slow operations.
 * The framework lets Gemini continue speaking while this runs.
 */
const slowWebSearch: ToolDefinition = {
	name: 'slow_web_search',
	description: `Search the web for information (demonstrates slow tool handling).
This tool simulates a slow web search that takes 3 seconds.
Use this when the user specifically asks for a "slow search" demo.`,
	parameters: z.object({
		query: z.string().describe('The search query'),
	}),
	execution: 'inline',
	execute: async (args, ctx: ToolContext) => {
		const { query } = args as { query: string };
		console.log(`${ts()} [Tool] slow_web_search starting for: ${query}`);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				console.log(`${ts()} [Tool] slow_web_search completed for: ${query}`);
				resolve({
					query,
					results: [
						'AI advances in 2025',
						'New language models released',
						'Major tech announcements',
					],
				});
			}, 3000);

			ctx.abortSignal.addEventListener('abort', () => {
				clearTimeout(timeout);
				console.log(`${ts()} [Tool] slow_web_search interrupted for: ${query}`);
				resolve({ query, error: 'Search cancelled by user interruption' });
			});
		});
	},
};

/**
 * Speech speed control — sends playback rate change to the web client.
 */
const setSpeechSpeed: ToolDefinition = {
	name: 'set_speech_speed',
	description: `Change the speech speed. You MUST call this tool whenever the user asks to speak slower, faster, or at normal speed. Verbally agreeing to change speed does NOT work — only this tool actually changes the pace. Always call this tool first, then confirm the change.`,
	parameters: z.object({
		speed: z.enum(['slow', 'normal', 'fast']).describe('The desired speech speed'),
	}),
	execution: 'inline',
	execute: async (args, ctx: ToolContext) => {
		const { speed } = args as { speed: 'slow' | 'normal' | 'fast' };
		console.log(`${ts()} [Tool] set_speech_speed: ${speed}`);

		// Set active directive — reinforced every turn via sendClientContent
		const paceDirectives: Record<string, string | null> = {
			slow: 'IMPORTANT PACING OVERRIDE: Speak at a slow, measured pace. Use shorter sentences with brief pauses between them. Do not rush through any information.',
			normal: null,
			fast: 'IMPORTANT PACING OVERRIDE: Speak at a brisk, efficient pace. Be concise and direct.',
		};
		ctx.setDirective?.('pacing', paceDirectives[speed]);

		return { speed, status: 'applied' };
	},
};

/**
 * Image generation tool — generates images using Gemini and sends them to the web client.
 * Uses @google/genai SDK directly for image output capabilities.
 */
const generateImage: ToolDefinition = {
	name: 'generate_image',
	description: `Generate an image and display it to the user.
ALWAYS call this tool when the user wants any kind of picture, image, card, illustration, or visual content.
Do NOT describe the image verbally instead of calling this tool — you MUST call this tool to actually create it.`,
	parameters: z.object({
		prompt: z.string().describe('Detailed description of the image to generate'),
	}),
	execution: 'inline',
	timeout: 60_000, // Image generation can take longer
	execute: async (args, ctx: ToolContext) => {
		const { prompt } = args as { prompt: string };
		console.log(`${ts()} [Tool] generate_image: ${prompt}`);

		const ai = new GoogleGenAI({ apiKey: API_KEY });

		try {
			const response = await ai.models.generateContent({
				model: 'gemini-2.5-flash-image',
				contents: prompt,
				config: { responseModalities: ['TEXT', 'IMAGE'] },
			});

			const parts = response.candidates?.[0]?.content?.parts ?? [];
			for (const part of parts) {
				if (part.inlineData?.data) {
					ctx.sendJsonToClient?.({
						type: 'image',
						data: {
							base64: part.inlineData.data,
							mimeType: part.inlineData.mimeType ?? 'image/png',
							description: prompt,
						},
					});
					console.log(`${ts()} [Tool] Image generated for: ${prompt}`);
					return { status: 'success', description: `Image generated: ${prompt}` };
				}
			}

			const text = response.text ?? '';
			return { status: 'no_image', description: text || 'No image was generated' };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`${ts()} [Tool] generate_image error: ${msg}`);
			return { error: msg };
		}
	},
};

/**
 * End session tool — gracefully closes the voice session when the user says goodbye.
 */
const endSession: ToolDefinition = {
	name: 'end_session',
	description: `End the voice session gracefully. Call this when the user says goodbye, wants to hang up, or indicates they are done.`,
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx: ToolContext) => {
		console.log(`${ts()} [Tool] end_session: User requested session end`);
		// Schedule close after Gemini finishes its goodbye response
		setTimeout(async () => {
			ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' });
		}, 5000);
		return { status: 'ending', message: 'Session will close after goodbye.' };
	},
};

/**
 * Transfer-to-agent tool — used by Gemini to trigger agent transfers.
 * The framework intercepts calls to 'transfer_to_agent' automatically.
 */
const transferFromMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer the conversation to a specialist agent.
- "math_expert": For complex math questions or detailed mathematical explanations.`,
	parameters: z.object({
		agent_name: z
			.enum(['math_expert'])
			.describe('The agent to transfer to'),
	}),
	execution: 'inline',
	execute: async () => ({ status: 'transferred' }),
};

const transferToMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer the conversation back to the main assistant.
Use this when you've finished helping with the specialized task
and the user wants general assistance again.`,
	parameters: z.object({
		agent_name: z.literal('main').describe('The agent to transfer to'),
	}),
	execution: 'inline',
	execute: async () => ({ status: 'transferred' }),
};

// =============================================================================
// Agent Definitions
// =============================================================================

const mainAgent: MainAgent = {
	name: 'main',
	greeting:
		'[System: A user just connected to the voice session. Greet them warmly. Introduce yourself as Bodhi, their voice assistant. Give a brief overview of what you can help with: looking things up on the web like weather or news, doing math calculations, telling the time, creating pictures from a description, and adjusting your speech speed if they need you to talk slower or faster. Then ask how you can help today. Keep it friendly and not too long.]',
	instructions: `You are a warm, patient voice assistant designed for older adults. Your name is Bodhi. Speak as a trusted companion — calm, clear, and never rushed.

VOICE & PACING RULES (follow these strictly):
- Deliver ONE idea per turn. Never chain two topics together.
- Pause briefly after each sentence. Let the user absorb what you said.
- Keep every response under 3 sentences unless the user asks for more detail.
- Speak at a measured pace. Never rush through information.
- If the user seems confused, slow down and rephrase — do not repeat the same words louder.

LANGUAGE RULES:
- Use short, simple sentences. Subject first, then verb, then object.
- Say "You can" instead of "Would you like to" or "Shall I".
- Say "I will" instead of "What I could potentially do is".
- Use everyday words: say "start" not "initiate", "use" not "utilize", "help" not "assist".
- Never use jargon, acronyms, or technical terms. If you must refer to something technical, explain it in plain words right away.
- Use positive phrasing: say "Please stay on the line" instead of "Don't hang up".
- Give binary choices, not open-ended questions: "Do you want the weather, or the news?" not "What would you like to know?"

RESPONSE TEMPLATE (follow this pattern):
1. Acknowledge: Confirm what the user said so they know you heard them correctly.
2. Act or Inform: Give the answer or take the action. Keep it brief.
3. Check: Ask one simple yes-or-no follow-up to confirm understanding.

Example:
  User: "What time is it?"
  You: "Sure, let me check the time for you. [call tool] It is 3:15 in the afternoon. Is there anything else you need?"

TOOLS YOU CAN USE:
- Google Search: Look up weather, news, or current events on the web.
- Calculator: Do math for the user.
- Current Time: Tell the user what time and date it is.
- Speech Speed: Make your voice slower or faster when the user asks.
- Image Generation: Create a picture from a description.
- Math Expert: For harder math questions, you can hand off to a math specialist.
- End Session: When the user says goodbye or is done, call end_session.

TOOL GUIDELINES:
- Use the calculator for simple math.
- For harder math, tell the user: "Let me connect you with our math specialist." Then call transfer_to_agent with agent_name "math_expert".
- When the user asks to speak slower or faster, you MUST call set_speech_speed IMMEDIATELY. Do NOT just verbally agree to change speed — only the tool actually changes your pace. Call the tool first, then confirm.
- When the user asks for any picture, image, card, or illustration, you MUST call generate_image immediately. Do not describe an image verbally — always call the tool so the user can see it.
- When the user says goodbye, says they are done, or wants to hang up, say a warm goodbye and call end_session.

THINGS TO AVOID:
- Never say "As an AI" or "As a language model".
- Never give long lists. If there are more than 3 items, offer them one at a time.
- Never assume the user knows how to do something. Offer to walk them through it.
- Never interrupt. Always wait for the user to finish speaking.
- Never use filler like "Great question!" — just answer directly and warmly.`,
	tools: [calculate, getCurrentTime, setSpeechSpeed, generateImage, endSession, transferFromMain],
	googleSearch: true,
	onEnter: async () => {
		console.log(`${ts()} [Agent] Main agent entered`);
	},
	onExit: async () => {
		console.log(`${ts()} [Agent] Main agent exited`);
	},
};

const mathExpertAgent: MainAgent = {
	name: 'math_expert',
	instructions: `You are a patient math helper named Bodhi. You explain math in plain, simple language for older adults.

VOICE & PACING RULES:
- One step at a time. Never rush through calculations.
- Pause after each step so the user can follow along.
- Keep sentences short and clear.

HOW TO EXPLAIN MATH:
- Break every problem into small steps.
- Say each number clearly. For example, say "twenty-five" not "25".
- After each step, briefly say what you did and what comes next.
- Use the calculator tool to do the actual math — never ask the user to compute.

WHEN DONE:
- When the user has no more math questions, say: "I will take you back to your main assistant now."
- Then call transfer_to_agent with agent_name "main".`,
	tools: [calculate, transferToMain],
	onEnter: async () => {
		console.log(`${ts()} [Agent] Math expert entered`);
	},
	onExit: async () => {
		console.log(`${ts()} [Agent] Math expert exited`);
	},
};

// =============================================================================
// Start the Voice Session
// =============================================================================

async function main() {
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent, mathExpertAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.0-flash'),
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		sttProvider: new DeepgramSTTProvider({
			apiKey: DEEPGRAM_API_KEY,
			model: 'nova-3',
			language: 'en-US',
			endpointingMs: 300,
			utteranceEndMs: 1000,
			punctuate: true,
			smartFormat: true,
		}),
		inputAudioTranscription: false,
		speechConfig: { voiceName: 'Puck' },
		hooks: {
			onSessionStart: (event) => {
				console.log(`${ts()} [Session] Started: ${event.sessionId} (agent: ${event.agentName})`);
			},
			onSessionEnd: (event) => {
				console.log(`${ts()} [Session] Ended: ${event.sessionId} (${event.reason})`);
			},
			onToolCall: (event) => {
				console.log(`${ts()} [Hook] Tool called: ${event.toolName} (${event.execution})`);
			},
			onToolResult: (event) => {
				console.log(`${ts()} [Hook] Tool result: ${event.toolCallId} (${event.status})`);
			},
			onAgentTransfer: (event) => {
				console.log(`${ts()} [Hook] Agent transfer: ${event.fromAgent} → ${event.toAgent}`);
			},
			onError: (event) => {
				console.error(
					`${ts()} [Error] ${event.component}: ${event.error.message} (${event.severity})`,
				);
			},
		},
	});

	// Subscribe to events for logging — track item index to print only new items per turn
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

	session.eventBus.subscribe('agent.transfer', (payload) => {
		console.log(`${ts()} [Event] Agent transfer: ${payload.fromAgent} → ${payload.toAgent}`);
	});

	// Handle shutdown
	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session.close('user_hangup');
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Start the session
	await session.start();

	console.log('============================================================');
	console.log('Bodhi Realtime Agent — Gemini Live + Deepgram Nova-3 STT');
	console.log('============================================================');
	console.log();
	console.log(`  WebSocket audio server: ws://localhost:${PORT}`);
	console.log(`  Session ID: ${SESSION_ID}`);
	console.log('  STT provider: Deepgram Nova-3 live');
	console.log();
	console.log('Connect a WebSocket audio client and try saying:');
	console.log("  - 'What time is it?'");
	console.log("  - 'What is 25 times 17?'");
	console.log("  - 'I need help with harder math' (transfers to math helper)");
	console.log("  - 'What is the weather today?' (uses Google Search)");
	console.log("  - 'Speak slower please' (changes speech speed)");
	console.log("  - 'Draw me a picture of a sunset' (creates and displays image)");
	console.log("  - 'Goodbye' (ends the session)");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
