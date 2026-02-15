/**
 * Gemini Realtime Voice Agent with Tools
 *
 * Demonstrates the Bodhi Realtime Agent Framework with:
 * - Gemini Live API: Native audio model with server-side turn detection
 * - Custom function tools: Calculator, current time, slow search demo
 * - Multi-agent: Agent transfer between main assistant and math expert
 *
 * Usage:
 *   1. Set GEMINI_API_KEY environment variable
 *   2. Run: pnpm tsx examples/gemini-realtime-tools.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *   4. Try saying:
 *        "What time is it?"
 *        "What is 25 times 17?"
 *        "I need help with complex math" (triggers agent transfer)
 *        "Use slow search for AI news"
 */

import { google } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { VoiceSession } from '../src/core/voice-session.js';
import type { MainAgent } from '../src/types/agent.js';
import type { ToolContext, ToolDefinition } from '../src/types/tool.js';

// =============================================================================
// Configuration
// =============================================================================

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
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

			console.log(`[Tool] calculate: ${expression} = ${result}`);
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
		console.log(`[Tool] slow_web_search starting for: ${query}`);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				console.log(`[Tool] slow_web_search completed for: ${query}`);
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
				console.log(`[Tool] slow_web_search interrupted for: ${query}`);
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
	description: `Change the speech speed. Call this when the user asks you to speak slower, faster, or at normal speed.`,
	parameters: z.object({
		speed: z.enum(['slow', 'normal', 'fast']).describe('The desired speech speed'),
	}),
	execution: 'inline',
	execute: async (args, ctx: ToolContext) => {
		const { speed } = args as { speed: 'slow' | 'normal' | 'fast' };
		console.log(`[Tool] set_speech_speed: ${speed}`);
		ctx.sendJsonToClient?.({ type: 'speech_speed', speed });
		return { speed, status: 'applied' };
	},
};

/**
 * Image generation tool — generates images using Gemini and sends them to the web client.
 * Uses @google/genai SDK directly for image output capabilities.
 */
const generateImage: ToolDefinition = {
	name: 'generate_image',
	description: `Generate an image based on a text description.
Use this when the user asks you to create, draw, or generate an image.
The image will appear in the web client while you describe it.`,
	parameters: z.object({
		prompt: z.string().describe('Detailed description of the image to generate'),
	}),
	execution: 'inline',
	execute: async (args, ctx: ToolContext) => {
		const { prompt } = args as { prompt: string };
		console.log(`[Tool] generate_image: ${prompt}`);

		try {
			const ai = new GoogleGenAI({ apiKey: API_KEY });
			const response = await ai.models.generateContent({
				model: 'gemini-2.0-flash-exp',
				contents: prompt,
				config: { responseModalities: ['TEXT', 'IMAGE'] },
			});

			// biome-ignore lint/suspicious/noExplicitAny: Gemini response parts have dynamic shape
			const parts = (response as any).candidates?.[0]?.content?.parts ?? [];
			let imageData: { base64: string; mimeType: string } | null = null;
			let textDescription = '';

			for (const part of parts) {
				if (part.inlineData?.data) {
					imageData = {
						base64: part.inlineData.data,
						mimeType: part.inlineData.mimeType ?? 'image/png',
					};
				}
				if (part.text) {
					textDescription += part.text;
				}
			}

			if (imageData) {
				ctx.sendJsonToClient?.({
					type: 'image',
					data: {
						base64: imageData.base64,
						mimeType: imageData.mimeType,
						description: prompt,
					},
				});
				console.log(`[Tool] Image generated for: ${prompt}`);
				return {
					status: 'success',
					description: textDescription || `Image generated: ${prompt}`,
				};
			}

			return { status: 'no_image', description: textDescription || 'No image was generated' };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[Tool] generate_image error: ${msg}`);
			return { error: msg };
		}
	},
};

/**
 * Transfer-to-agent tool — used by Gemini to trigger agent transfers.
 * The framework intercepts calls to 'transfer_to_agent' automatically.
 */
const transferFromMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer the conversation to a specialist agent.
- "math_expert": For complex math questions or detailed mathematical explanations.
- "spanish_agent": When the user wants to speak in Spanish or practice Spanish.`,
	parameters: z.object({
		agent_name: z
			.enum(['math_expert', 'spanish_agent'])
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
	instructions: `You are a helpful voice assistant. ALWAYS respond in English.

You have access to:
1. **Google Search**: You can search the web for real-time information (weather, news, current events)
2. **Calculator**: Evaluate math expressions (sqrt, sin, cos, log, pi, etc.)
3. **Current Time**: Get the current date and time in any timezone
4. **Slow Web Search**: Demo tool that takes 3 seconds — shows how the framework handles slow operations
5. **Speech Speed**: Change speech speed (slow/normal/fast) when the user asks
6. **Image Generation**: Generate images from text descriptions
7. **Agent Transfers**: Transfer to math expert or Spanish assistant

Guidelines:
- ALWAYS speak in English, regardless of what language the user speaks
- Be conversational and friendly
- Keep responses concise (this is voice)
- Use calculator for simple math
- For COMPLEX math questions, use transfer_to_agent with agent_name "math_expert"
- When the user wants to speak Spanish or practice Spanish, use transfer_to_agent with agent_name "spanish_agent"
- When the user asks you to speak slower or faster, call set_speech_speed
- When the user asks you to generate or draw an image, use generate_image and describe what you created
- When using slow_web_search, tell the user you're searching while you wait for results`,
	tools: [calculate, getCurrentTime, slowWebSearch, setSpeechSpeed, generateImage, transferFromMain],
	googleSearch: true,
	onEnter: async () => {
		console.log('[Agent] Main agent entered');
	},
	onExit: async () => {
		console.log('[Agent] Main agent exited');
	},
};

const mathExpertAgent: MainAgent = {
	name: 'math_expert',
	instructions: `You are a MATH EXPERT assistant. You speak with confidence about mathematics.

Your specialty is:
- Complex mathematical calculations
- Explaining mathematical concepts
- Step-by-step problem solving
- Statistical analysis

Guidelines:
- ALWAYS respond in English
- Be precise and accurate
- Explain your reasoning step by step
- Use the calculate tool for actual computation
- When the user is done with math questions, offer to transfer them back to the main assistant
- Use transfer_to_agent with agent_name "main" when the user wants general help

You have a more serious, professorial tone compared to the main assistant.`,
	tools: [calculate, transferToMain],
	onEnter: async () => {
		console.log('[Agent] Math expert entered');
	},
	onExit: async () => {
		console.log('[Agent] Math expert exited');
	},
};

const spanishAgent: MainAgent = {
	name: 'spanish_agent',
	instructions: `Eres un asistente amigable que habla en español.

Tus capacidades:
- Conversación general en español
- Ayuda con traducciones entre inglés y español
- Práctica de conversación para estudiantes de español
- Calculadora y hora actual

Directrices:
- Sé amigable y paciente
- Si el usuario comete errores en español, corrígelos amablemente
- Cuando el usuario quiera volver al asistente principal en inglés, usa transfer_to_agent con agent_name "main"`,
	tools: [calculate, getCurrentTime, transferToMain],
	language: 'es-ES',
	onEnter: async () => {
		console.log('[Agent] Spanish agent entered');
	},
	onExit: async () => {
		console.log('[Agent] Spanish agent exited');
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
		agents: [mainAgent, mathExpertAgent, spanishAgent],
		initialAgent: 'main',
		port: PORT,
		model: google('gemini-2.0-flash'),
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		speechConfig: { voiceName: 'Puck' },
		hooks: {
			onSessionStart: (event) => {
				console.log(`[Session] Started: ${event.sessionId} (agent: ${event.agentName})`);
			},
			onSessionEnd: (event) => {
				console.log(`[Session] Ended: ${event.sessionId} (${event.reason})`);
			},
			onToolCall: (event) => {
				console.log(`[Hook] Tool called: ${event.toolName} (${event.execution})`);
			},
			onToolResult: (event) => {
				console.log(`[Hook] Tool result: ${event.toolCallId} (${event.status})`);
			},
			onAgentTransfer: (event) => {
				console.log(`[Hook] Agent transfer: ${event.fromAgent} → ${event.toAgent}`);
			},
			onError: (event) => {
				console.error(
					`[Error] ${event.component}: ${event.error.message} (${event.severity})`,
				);
			},
		},
	});

	// Subscribe to events for logging
	session.eventBus.subscribe('turn.end', (payload) => {
		console.log(`[Event] Turn ended: ${payload.turnId}`);
		// Print recent transcripts
		const items = session.conversationContext.items;
		const recent = items.slice(-2);
		for (const item of recent) {
			console.log(`  [${item.role}] ${item.content}`);
		}
	});

	session.eventBus.subscribe('agent.transfer', (payload) => {
		console.log(`[Event] Agent transfer: ${payload.fromAgent} → ${payload.toAgent}`);
	});

	// Handle shutdown
	const shutdown = async () => {
		console.log('\nShutting down...');
		await session.close('user_hangup');
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Start the session
	await session.start();

	console.log('============================================================');
	console.log('Bodhi Realtime Agent — Gemini Voice Assistant');
	console.log('============================================================');
	console.log();
	console.log(`  WebSocket audio server: ws://localhost:${PORT}`);
	console.log(`  Session ID: ${SESSION_ID}`);
	console.log();
	console.log('Connect a WebSocket audio client and try saying:');
	console.log("  - 'What time is it?'");
	console.log("  - 'What is 25 times 17?'");
	console.log("  - 'I need help with complex math' (transfers to math expert)");
	console.log("  - 'What's the weather in San Francisco?' (uses Google Search)");
	console.log("  - 'Use slow search for AI news'");
	console.log("  - 'Speak slower please' (changes speech speed)");
	console.log("  - 'Generate an image of a sunset' (creates and displays image)");
	console.log("  - 'I want to practice Spanish' (transfers to Spanish agent)");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
