// SPDX-License-Identifier: MIT

/**
 * Hello World — Multi-Agent Voice Assistant
 *
 * Demonstrates key features of the Bodhi Realtime Agent Framework:
 *
 *   1. Multi-agent transfer  — Main agent hands off to a math specialist
 *   2. Background subagent   — Long-running "deep research" tool runs asynchronously
 *   3. Image generation       — Creates images via Gemini and pushes them to the client
 *   4. Voice pacing           — Adjusts speech speed with active directives
 *
 * Usage:
 *   GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent.ts
 */

import { google } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { tool } from 'ai';
import { z } from 'zod';
import { VoiceSession } from '../../src/index.js';
import type {
	MainAgent,
	SubagentConfig,
	ToolContext,
	ToolDefinition,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (!API_KEY) {
	console.error('Error: set GEMINI_API_KEY environment variable');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;

/** Compact timestamp for logs. */
const ts = () => new Date().toISOString().slice(11, 23);

// ---------------------------------------------------------------------------
// Tools — inline
// ---------------------------------------------------------------------------

/** Returns the current date/time in an optional timezone. */
const getTime: ToolDefinition = {
	name: 'get_time',
	description: 'Get the current date and time, optionally in a given timezone.',
	parameters: z.object({
		timezone: z
			.string()
			.optional()
			.describe('IANA timezone, e.g. "America/New_York"'),
	}),
	execution: 'inline',
	execute: async (args) => {
		const { timezone } = args as { timezone?: string };
		const now = new Date();
		const time = now.toLocaleString('en-US', {
			timeZone: timezone ?? undefined,
			dateStyle: 'full',
			timeStyle: 'long',
		});
		return { timezone: timezone ?? 'local', time };
	},
};

/**
 * Changes the perceived speech speed by injecting a pacing directive.
 * The directive is reinforced every turn to prevent Gemini from drifting.
 */
const setSpeechSpeed: ToolDefinition = {
	name: 'set_speech_speed',
	description:
		'Change the speech speed. You MUST call this tool whenever the user asks to speak slower, faster, or at normal speed. Verbally agreeing to change speed does NOT work — only this tool actually changes the pace. Always call this tool first, then confirm the change.',
	parameters: z.object({
		speed: z.enum(['slow', 'normal', 'fast']).describe('Desired speech speed'),
	}),
	execution: 'inline',
	execute: async (args, ctx: ToolContext) => {
		const { speed } = args as { speed: 'slow' | 'normal' | 'fast' };
		console.log(`${ts()} [Tool] set_speech_speed → ${speed}`);

		const directives: Record<string, string | null> = {
			slow: 'PACING OVERRIDE: Speak slowly. Use shorter sentences with pauses.',
			normal: null,
			fast: 'PACING OVERRIDE: Speak at a brisk, efficient pace. Be concise.',
		};
		ctx.setDirective?.('pacing', directives[speed]);

		return { speed, status: 'applied' };
	},
};

/**
 * Generates an image with Gemini and sends it to the web client as a
 * base64-encoded JSON text frame (the web client renders it as an <img>).
 */
const generateImage: ToolDefinition = {
	name: 'generate_image',
	description:
		'Generate an image from a text description. ALWAYS call this when the user asks for a picture.',
	parameters: z.object({
		prompt: z.string().describe('What to draw'),
	}),
	execution: 'inline',
	timeout: 60_000,
	execute: async (args, ctx: ToolContext) => {
		const { prompt } = args as { prompt: string };
		console.log(`${ts()} [Tool] generate_image: ${prompt}`);

		const ai = new GoogleGenAI({ apiKey: API_KEY });
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
				return { status: 'success', description: prompt };
			}
		}
		return { status: 'no_image', text: response.text ?? '' };
	},
};

// ---------------------------------------------------------------------------
// Tools — background (triggers a subagent)
// ---------------------------------------------------------------------------

/**
 * A background tool that is handed off to a subagent.
 * While the subagent works, Gemini keeps talking to the user.
 * When the subagent finishes, the result is injected back and spoken aloud.
 */
const deepResearch: ToolDefinition = {
	name: 'deep_research',
	description:
		'Perform in-depth research on a topic. Use this for questions that need thorough investigation. Results arrive after a short delay.',
	parameters: z.object({
		topic: z.string().describe('The research topic'),
	}),
	execution: 'background',
	pendingMessage:
		'Research is underway. I will share the findings once they are ready.',
	timeout: 30_000,
	// The execute function is NOT called for background tools —
	// the subagent (configured below) handles execution instead.
	execute: async () => ({}),
};

/**
 * Subagent configuration for the deep_research tool.
 * Uses Vercel AI SDK tools (not framework ToolDefinitions).
 */
const deepResearchSubagent: SubagentConfig = {
	name: 'research_subagent',
	instructions:
		'You are a research assistant. Use the search tool to find information, then write a concise summary.',
	maxSteps: 3,
	tools: {
		// Vercel AI SDK tool — the subagent calls this during generateText
		search: tool({
			description: 'Search for information on a topic.',
			parameters: z.object({
				query: z.string().describe('Search query'),
			}),
			execute: async ({ query }) => {
				// In production you would call a real search API here.
				// This mock simulates a search result after a short delay.
				console.log(`${ts()} [Subagent] Searching: "${query}"`);
				await new Promise((r) => setTimeout(r, 2000));
				return {
					results: [
						`Latest developments in "${query}" as of 2026.`,
						`Key facts: ${query} is a rapidly evolving field.`,
						`Experts suggest watching ${query} closely this year.`,
					],
				};
			},
		}),
	},
};

// ---------------------------------------------------------------------------
// Tools — agent transfer
// ---------------------------------------------------------------------------

const transferFromMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description:
		'Transfer the conversation to a specialist agent. You MUST call this tool when the user needs math help — do not ask for confirmation, just transfer immediately.\n- "math_expert": For complex math questions or detailed mathematical explanations.',
	parameters: z.object({
		agent_name: z.enum(['math_expert']).describe('Agent to transfer to'),
	}),
	execution: 'inline',
	execute: async () => ({ status: 'transferred' }),
};

const transferToMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: 'Transfer back to the main assistant when done.',
	parameters: z.object({
		agent_name: z.literal('main').describe('Agent to transfer to'),
	}),
	execution: 'inline',
	execute: async () => ({ status: 'transferred' }),
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const mainAgent: MainAgent = {
	name: 'main',
	greeting:
		'[System: Introduce yourself as Bodhi. Greet the user warmly and briefly. Mention you can tell the time, generate images, do research, adjust your speech speed, and transfer to a math expert. Keep it short.]',
	instructions: `You are a friendly voice assistant named Bodhi. Keep responses concise — this is voice.

TOOLS YOU HAVE:
1. get_time — Tell the time in any timezone.
2. set_speech_speed — Change your pace. You MUST call this tool when the user asks to speak slower/faster. Saying "okay I'll slow down" without calling the tool does NOTHING.
3. generate_image — Create images. You MUST call this tool when the user asks for a picture. Describing an image verbally does NOT show them anything.
4. deep_research — For in-depth questions, delegates to a research assistant.
5. transfer_to_agent — Transfer to the math expert for complex math.

MANDATORY TOOL RULES (violating these is a failure):
1. SPEECH SPEED: When the user asks to speak slower, faster, or at normal speed, you MUST call set_speech_speed IMMEDIATELY. Do NOT respond first. Do NOT say "sure" first. Call the tool, THEN confirm. If you say "I've adjusted" without calling the tool, you are LYING — only the tool changes your speed.
2. IMAGE GENERATION: When the user asks for any picture, image, card, or illustration, you MUST call generate_image IMMEDIATELY. Do NOT describe the image verbally instead.
3. AGENT TRANSFER: When the user asks for math help or complex calculations, say "Let me connect you with the math expert" and IMMEDIATELY call transfer_to_agent with agent_name "math_expert". Do NOT ask "should I transfer you?" — just do it.
4. NEVER claim you did something without calling the corresponding tool. Tools are the ONLY way to take action.`,
	tools: [getTime, setSpeechSpeed, generateImage, deepResearch, transferFromMain],
	googleSearch: true,
	onEnter: async () => console.log(`${ts()} [Agent] main entered`),
};

const mathExpert: MainAgent = {
	name: 'math_expert',
	greeting:
		'[System: Introduce yourself briefly as the math expert. Ask what math problem they need help with.]',
	instructions: `You are a patient math expert. Break problems into clear steps.
Use simple language. Explain your reasoning step by step.

WHEN DONE: When the user has no more math questions or asks for general help,
say "Let me take you back to the main assistant." then IMMEDIATELY call
transfer_to_agent with agent_name "main". Do NOT ask for confirmation.`,
	tools: [transferToMain],
	onEnter: async () => console.log(`${ts()} [Agent] math_expert entered`),
};

// ---------------------------------------------------------------------------
// Start session
// ---------------------------------------------------------------------------

async function main() {
	const session = new VoiceSession({
		sessionId: `session_${Date.now()}`,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent, mathExpert],
		initialAgent: 'main',
		port: PORT,
		model: google('gemini-2.0-flash'),
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		speechConfig: { voiceName: 'Puck' },

		// Map the background tool name → subagent config
		subagentConfigs: {
			deep_research: deepResearchSubagent,
		},

		hooks: {
			onToolCall: (e) =>
				console.log(`${ts()} [Hook] tool.call  ${e.toolName} (${e.execution})`),
			onToolResult: (e) =>
				console.log(`${ts()} [Hook] tool.result ${e.toolCallId} → ${e.status}`),
			onAgentTransfer: (e) =>
				console.log(`${ts()} [Hook] transfer   ${e.fromAgent} → ${e.toAgent}`),
			onError: (e) =>
				console.error(
					`${ts()} [Error] ${e.component}: ${e.error.message}`,
				),
		},
	});

	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session.close('user_hangup');
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await session.start();

	console.log('');
	console.log('  Hello World — Multi-Agent Voice Assistant');
	console.log('  ─────────────────────────────────────────');
	console.log(`  WebSocket server:  ws://localhost:${PORT}`);
	console.log('');
	console.log('  Try saying:');
	console.log('    "What time is it?"              → inline tool');
	console.log('    "Speak slower please"           → voice pacing');
	console.log('    "Draw me a cat in a spacesuit"  → image generation');
	console.log('    "Research quantum computing"    → background subagent');
	console.log('    "I need help with math"         → agent transfer');
	console.log('');
	console.log('  Press Ctrl+C to stop.');
	console.log('');
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
