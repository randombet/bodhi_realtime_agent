/**
 * Bodhi — Senior-Friendly Voice Assistant (Qwen Omni Realtime)
 *
 * A warm, patient voice assistant on the Qwen Omni Realtime transport (Alibaba
 * DashScope), mirroring examples/openai-realtime-tools.ts. Phase 0 confirmed Qwen
 * supports server_vad turn-taking, OpenAI-identical function calling, text-seeded
 * greetings, and in-place agent transfer — so the framework's tools, subagents,
 * and multi-agent routing work unchanged.
 *
 * Features:
 * - Senior-friendly: slow pacing, plain language, one idea per turn
 * - Function tools: calculator, current time, slow-search demo, image + video generation
 * - Multi-agent: transfers to a patient math helper, and back
 * - Background subagents (Gemini) for image (gemini-2.5-flash-image) and video (Veo)
 * - Graceful goodbye via end_session
 *
 * NOTE vs the OpenAI example: no dictation/transcription mode here — that relies on
 * transport quiesce(), which is a Qwen Phase 4 follow-up (not in V1).
 *
 * Usage:
 *   1. Set QWEN_API_KEY (or DASHSCOPE_API_KEY) for the voice transport, and
 *      GEMINI_API_KEY for the image/video subagents + subagent text generation.
 *   2. Run: pnpm tsx examples/qwen-realtime/tools.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *      (e.g. pnpm web-client:dev) and try saying:
 *        "What time is it in Tokyo?"
 *        "What is the square root of 144?"
 *        "I need help with harder math"      (transfers to the math helper)
 *        "Draw me a watercolor of a lighthouse"
 *        "Make a short video of waves on a beach"
 *        "Goodbye"                            (ends the session gracefully)
 */

import 'dotenv/config';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { tool } from 'ai';
import { z } from 'zod';
import { VoiceSession } from '../../src/core/voice-session.js';
import { QwenRealtimeTransport } from '../../src/transport/qwen-realtime-transport.js';
import type { MainAgent, SubagentConfig } from '../../src/types/agent.js';
import type { ToolContext, ToolDefinition } from '../../src/types/tool.js';

/** Compact timestamp for server logs: HH:MM:SS.mmm */
function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

// =============================================================================
// Configuration
// =============================================================================

const QWEN_API_KEY = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
if (QWEN_API_KEY.length === 0) {
	console.error('Error: QWEN_API_KEY (or DASHSCOPE_API_KEY) is required for the voice transport');
	process.exit(1);
}

// Gemini API key powers the image/video subagents + subagent text generation.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
if (GEMINI_API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY is required (image/video subagents + subagent text gen)');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_ID = `qwen_tools_${Date.now()}`;
const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

// =============================================================================
// Qwen Omni Realtime Transport
// =============================================================================

const transport = new QwenRealtimeTransport({
	apiKey: QWEN_API_KEY,
	model: 'qwen3.5-omni-plus-realtime',
	// voice omitted → server default (Tina). Set QWEN_VOICE to a validated voice.
	...(process.env.QWEN_VOICE ? { voice: process.env.QWEN_VOICE } : {}),
	turnDetection: { type: 'server_vad' },
});

// Mutable ref so subagent tool closures can publish events on the session.
let sessionRef: VoiceSession | null = null;

// =============================================================================
// Custom Tools
// =============================================================================

/** Calculator tool — evaluates mathematical expressions safely. */
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
		};
		try {
			const safeExpression = expression.replace(
				/\b(sqrt|sin|cos|tan|log|log10|exp|abs|round|pow|pi|e)\b/g,
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

/** Current time tool — returns the current date/time in any timezone. */
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
				return {
					timezone,
					time: now.toLocaleString('en-US', {
						timeZone: timezone,
						dateStyle: 'full',
						timeStyle: 'long',
					}),
				};
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

/** Slow web search — demonstrates an inline tool that runs while the model talks. */
const slowWebSearch: ToolDefinition = {
	name: 'slow_web_search',
	description: `Search the web for information (demonstrates slow tool handling).
Simulates a 3-second search. Use when the user asks for a "slow search" demo.`,
	parameters: z.object({ query: z.string().describe('The search query') }),
	execution: 'inline',
	execute: async (args, ctx: ToolContext) => {
		const { query } = args as { query: string };
		console.log(`${ts()} [Tool] slow_web_search starting: ${query}`);
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				resolve({ query, results: ['AI advances', 'New models released', 'Tech announcements'] });
			}, 3000);
			ctx.abortSignal.addEventListener('abort', () => {
				clearTimeout(timeout);
				resolve({ query, error: 'Search cancelled by user interruption' });
			});
		});
	},
};

/** Image generation — background tool that hands off to a Gemini subagent. */
const generateImage: ToolDefinition = {
	name: 'generate_image',
	description: `Generate an image and display it to the user.
ALWAYS call this when the user wants any picture, image, card, illustration, or visual.
Do NOT describe the image verbally — you MUST call this tool to actually create it.`,
	parameters: z.object({ prompt: z.string().describe('Detailed description of the image') }),
	execution: 'background',
	pendingMessage: "I'm generating your image now. It'll appear on screen shortly.",
	execute: async () => ({}),
};

const imageSubagent: SubagentConfig = {
	name: 'image_generator',
	instructions:
		'You generate images. Call create_image with the prompt from the task description. Return a short summary.',
	tools: {
		create_image: tool({
			description: 'Generate an image using Gemini and display it to the user.',
			parameters: z.object({ prompt: z.string().describe('Image generation prompt') }),
			execute: async ({ prompt }) => {
				console.log(`${ts()} [Subagent] create_image: ${prompt}`);
				const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
				const response = await ai.models.generateContent({
					model: 'gemini-2.5-flash-image',
					contents: prompt,
					config: { responseModalities: ['TEXT', 'IMAGE'] },
				});
				const parts = response.candidates?.[0]?.content?.parts ?? [];
				for (const part of parts) {
					if (part.inlineData?.data) {
						sessionRef?.eventBus.publish('gui.update', {
							sessionId: sessionRef.sessionManager.sessionId,
							data: {
								type: 'image',
								base64: part.inlineData.data,
								mimeType: part.inlineData.mimeType ?? 'image/png',
								description: prompt,
							},
						});
						return { status: 'success', description: `Generated image: ${prompt}` };
					}
				}
				return { status: 'no_image', description: `No image returned for: ${prompt}` };
			},
		}),
	},
	maxSteps: 3,
};

/** Video generation — background tool that hands off to a Veo subagent. */
const generateVideo: ToolDefinition = {
	name: 'generate_video',
	description: `Generate a short video and display it to the user.
ALWAYS call this when the user wants a video, animation, or movie clip.
Do NOT describe the video verbally — you MUST call this tool to actually create it.`,
	parameters: z.object({ prompt: z.string().describe('Detailed description of the video') }),
	execution: 'background',
	pendingMessage:
		"I'm generating your video now. This takes a minute or two — I'll let you know when it's ready.",
	execute: async () => ({}),
};

const videoSubagent: SubagentConfig = {
	name: 'video_generator',
	instructions:
		'You generate videos. Call create_video with the prompt from the task arguments. Return a short summary.',
	tools: {
		create_video: tool({
			description: 'Generate a video using Veo and display it to the user.',
			parameters: z.object({ prompt: z.string().describe('Video generation prompt') }),
			execute: async ({ prompt }) => {
				console.log(`${ts()} [Subagent] create_video: ${prompt}`);
				const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
				let operation = await ai.models.generateVideos({
					model: 'veo-3.1-generate-preview',
					prompt,
					config: { aspectRatio: '16:9', personGeneration: 'allow_all' },
				});
				console.log(`${ts()} [Subagent] Video generation started: ${operation.name}`);
				while (!operation.done) {
					await new Promise((r) => setTimeout(r, 10_000));
					operation = await ai.operations.getVideosOperation({ operation });
				}
				const video = operation.response?.generatedVideos?.[0]?.video;
				if (!video?.uri)
					return { status: 'no_video', description: `No video returned for: ${prompt}` };
				const tmpPath = join(tmpdir(), `bodhi-video-${Date.now()}.mp4`);
				await ai.files.download({ file: video, downloadPath: tmpPath });
				const base64 = (await readFile(tmpPath)).toString('base64');
				await unlink(tmpPath).catch(() => {});
				sessionRef?.eventBus.publish('gui.update', {
					sessionId: sessionRef.sessionManager.sessionId,
					data: {
						type: 'video',
						base64,
						mimeType: video.mimeType ?? 'video/mp4',
						description: prompt,
					},
				});
				return { status: 'success', description: `Generated video: ${prompt}` };
			},
		}),
	},
	maxSteps: 3,
	timeout: 300_000, // 5 min — video generation is slow
};

/** End session tool — gracefully closes the voice session on goodbye. */
const endSession: ToolDefinition = {
	name: 'end_session',
	description:
		'End the voice session gracefully. Call when the user says goodbye, wants to hang up, or is done.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx: ToolContext) => {
		console.log(`${ts()} [Tool] end_session`);
		setTimeout(() => ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' }), 5000);
		return { status: 'ending', message: 'Session will close after goodbye.' };
	},
};

/** Transfer to the math specialist (intercepted by the framework's agent router). */
const transferFromMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer the conversation to a specialist agent.
- "math_expert": For complex math questions or detailed mathematical explanations.`,
	parameters: z.object({
		agent_name: z.enum(['math_expert']).describe('The agent to transfer to'),
	}),
	execution: 'inline',
	execute: async () => ({ status: 'transferred' }),
};

const transferToMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer the conversation back to the main assistant once the
specialized task is done and the user wants general assistance again.`,
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
		'[System: A user just connected. Greet them warmly. Introduce yourself as Bodhi, their voice assistant. Briefly mention you can do math, tell the time, and create pictures or videos from a description. Then ask how you can help. Keep it friendly and short.]',
	instructions: `You are Bodhi, a warm, patient voice assistant for older adults. Speak calmly and clearly, never rushed.

VOICE & PACING:
- One idea per turn. Never chain two topics together.
- Keep every response under 3 sentences unless asked for more.
- Speak at a measured pace; if the user seems confused, slow down and rephrase.

LANGUAGE:
- Short, simple sentences. Everyday words ("use" not "utilize", "help" not "assist").
- Offer binary choices, not open-ended questions.

TOOLS:
- Use the calculator for simple math.
- For harder math, say "Let me connect you with our math specialist." then call transfer_to_agent with agent_name "math_expert".
- When the user wants a picture/image/illustration, you MUST call generate_image. Never describe it verbally instead.
- When the user wants a video/animation, you MUST call generate_video and warn it takes a minute or two.
- When the user says goodbye or is done, say a warm goodbye and call end_session.

AVOID: "As an AI", long lists (offer items one at a time), filler like "Great question!".`,
	tools: [
		calculate,
		getCurrentTime,
		slowWebSearch,
		generateImage,
		generateVideo,
		endSession,
		transferFromMain,
	],
	onEnter: async () => console.log(`${ts()} [Agent] Main entered`),
	onExit: async () => console.log(`${ts()} [Agent] Main exited`),
};

const mathExpertAgent: MainAgent = {
	name: 'math_expert',
	instructions: `You are a patient math helper named Bodhi, explaining math in plain language for older adults.
- One step at a time; pause after each step.
- Say numbers clearly ("twenty-five", not "25").
- Use the calculator tool for the actual math — never ask the user to compute.
- When the user has no more math questions, say "I will take you back to your main assistant now." then call transfer_to_agent with agent_name "main".`,
	tools: [calculate, transferToMain],
	greeting:
		'You just transferred to the math expert. Greet the user in one short sentence, then ask what math problem they need help with.',
	onEnter: async () => console.log(`${ts()} [Agent] Math expert entered`),
	onExit: async () => console.log(`${ts()} [Agent] Math expert exited`),
};

// =============================================================================
// Start the Voice Session
// =============================================================================

async function main() {
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		// Used for subagent text generation (image/video planning).
		apiKey: GEMINI_API_KEY,
		model: google('gemini-2.5-flash'),
		agents: [mainAgent, mathExpertAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		subagentConfigs: { generate_image: imageSubagent, generate_video: videoSubagent },
		transport, // Inject the Qwen Omni Realtime transport
		// Qwen (like OpenAI) sends response.done at generation end, but the client
		// plays buffered audio after — keep barge-in armed through that tail.
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: true,
		hooks: {
			onSessionStart: (e) =>
				console.log(`${ts()} [Session] started ${e.sessionId} (agent: ${e.agentName})`),
			onSessionEnd: (e) => console.log(`${ts()} [Session] ended ${e.sessionId} (${e.reason})`),
			onToolCall: (e) => console.log(`${ts()} [Hook] tool: ${e.toolName} (${e.execution})`),
			onToolResult: (e) => console.log(`${ts()} [Hook] tool result: ${e.toolCallId} (${e.status})`),
			onAgentTransfer: (e) => console.log(`${ts()} [Hook] transfer: ${e.fromAgent} → ${e.toAgent}`),
			onError: (e) =>
				console.error(`${ts()} [Error] ${e.component}: ${e.error.message} (${e.severity})`),
		},
	});

	sessionRef = session;

	await session.start();
	console.log(`${ts()} Qwen tools session listening on ws://${HOST}:${PORT}`);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
