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
 * Transfer-to-agent tool — used by Gemini to trigger agent transfers.
 * The framework intercepts calls to 'transfer_to_agent' automatically.
 */
const transferToMathExpert: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer the conversation to a math specialist.
Use this when the user has complex math questions or needs
detailed mathematical explanations beyond simple calculations.`,
	parameters: z.object({
		agent_name: z.literal('math_expert').describe('The agent to transfer to'),
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
1. **Calculator**: Evaluate math expressions (sqrt, sin, cos, log, pi, etc.)
2. **Current Time**: Get the current date and time in any timezone
3. **Slow Web Search**: Demo tool that takes 3 seconds — shows how the framework handles slow operations
4. **Math Expert Transfer**: Transfer to a specialized math expert for complex calculations

Guidelines:
- ALWAYS speak in English, regardless of what language the user speaks
- Be conversational and friendly
- Keep responses concise (this is voice)
- Use calculator for simple math
- For COMPLEX math questions or when the user wants detailed mathematical explanations,
  use transfer_to_agent with agent_name "math_expert" to hand them off to our math specialist
- When using slow_web_search, tell the user you're searching while you wait for results`,
	tools: [calculate, getCurrentTime, slowWebSearch, transferToMathExpert],
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
	console.log("  - 'Use slow search for AI news'");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
