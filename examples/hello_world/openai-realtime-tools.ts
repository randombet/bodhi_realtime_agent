/**
 * Bodhi — Senior-Friendly Voice Assistant (OpenAI Realtime)
 *
 * A warm, patient voice assistant designed for older adults. Built with
 * the Bodhi Realtime Agent Framework using the OpenAI Realtime API.
 *
 * Features:
 * - Senior-friendly: Slow pacing, plain language, one idea per turn
 * - Function tools: Calculator, current time, speech speed, image generation, video generation
 * - Multi-agent: Transfers to a patient math helper for harder questions
 * - Session management: Graceful goodbye with end_session tool
 *
 * Usage:
 *   1. Set OPENAI_API_KEY and GEMINI_API_KEY in .env file or as environment variables
 *      (OPENAI_API_KEY for the voice session, GEMINI_API_KEY for image/video subagents)
 *   2. Run: pnpm tsx examples/hello_world/openai-realtime-tools.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *   4. Try saying:
 *        "What time is it?"
 *        "What is 25 times 17?"
 *        "I need help with harder math" (transfers to math helper)
 *        "Goodbye" (ends session gracefully)
 */

import 'dotenv/config';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { tool } from 'ai';
import { z } from 'zod';
import { speechSpeed } from '../../src/behaviors/presets.js';
import { VoiceSession } from '../../src/core/voice-session.js';

import { OpenAIRealtimeTransport } from '../../src/transport/openai-realtime-transport.js';
import type { MainAgent, SubagentConfig } from '../../src/types/agent.js';
import type { ToolContext, ToolDefinition } from '../../src/types/tool.js';

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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
if (OPENAI_API_KEY.length === 0) {
	console.error('Error: OPENAI_API_KEY environment variable is required');
	process.exit(1);
}

// Gemini API key is still needed for image/video subagents
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
if (GEMINI_API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY environment variable is required (for image/video subagents)');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0'; // '0.0.0.0' binds to all interfaces for EC2
const SESSION_ID = `session_${Date.now()}`;
const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });


// =============================================================================
// OpenAI Realtime Transport
// =============================================================================

const transport = new OpenAIRealtimeTransport({
	apiKey: OPENAI_API_KEY,
	model: 'gpt-4o-realtime-preview',
	voice: 'coral',
	turnDetection: { type: 'semantic_vad', eagerness: 'medium' },
});

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
 * The framework lets the LLM continue speaking while this runs.
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
 * Image generation tool — background tool that hands off to a subagent.
 * The LLM keeps talking while the subagent generates the image and pushes it
 * to the client when ready.
 */
const generateImage: ToolDefinition = {
	name: 'generate_image',
	description: `Generate an image and display it to the user.
ALWAYS call this tool when the user wants any kind of picture, image, card, illustration, or visual content.
Do NOT describe the image verbally instead of calling this tool — you MUST call this tool to actually create it.`,
	parameters: z.object({
		prompt: z.string().describe('Detailed description of the image to generate'),
	}),
	execution: 'background',
	pendingMessage: "I'm generating your image now. It'll appear on screen shortly.",
	execute: async () => ({}),
};

// Mutable ref so the subagent tool closure can publish events on the session
let sessionRef: VoiceSession | null = null;

/** Subagent that generates an image via Gemini and pushes it to the client. */
const imageSubagent: SubagentConfig = {
	name: 'image_generator',
	instructions:
		'You generate images. Call the create_image tool with the prompt from the task description. Return a short summary of what was generated.',
	tools: {
		create_image: tool({
			description: 'Generate an image using Gemini and display it to the user.',
			parameters: z.object({
				prompt: z.string().describe('Image generation prompt'),
			}),
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
						console.log(`${ts()} [Subagent] Image ready: ${prompt}`);
						return { status: 'success', description: `Generated image: ${prompt}` };
					}
				}

				console.log(`${ts()} [Subagent] No image returned for: ${prompt}`);
				return { status: 'no_image', description: `No image was returned for: ${prompt}` };
			},
		}),
	},
	maxSteps: 3,
};

/**
 * Video generation tool — background tool that hands off to a subagent.
 * The LLM keeps talking while the subagent generates a video via Veo
 * and pushes it to the client when ready.
 */
const generateVideo: ToolDefinition = {
	name: 'generate_video',
	description: `Generate a short video and display it to the user.
ALWAYS call this tool when the user wants a video, animation, or movie clip.
Do NOT describe the video verbally — you MUST call this tool to actually create it.`,
	parameters: z.object({
		prompt: z.string().describe('Detailed description of the video to generate'),
	}),
	execution: 'background',
	pendingMessage:
		"I'm generating your video now. This takes a minute or two — I'll let you know when it's ready.",
	execute: async () => ({}),
};

/** Subagent that generates a video via Veo and pushes it to the client. */
const videoSubagent: SubagentConfig = {
	name: 'video_generator',
	instructions:
		'You generate videos. Call the create_video tool with the prompt from the task arguments. Return a short summary of what was generated.',
	tools: {
		create_video: tool({
			description: 'Generate a video using Veo and display it to the user.',
			parameters: z.object({
				prompt: z.string().describe('Video generation prompt'),
			}),
			execute: async ({ prompt }) => {
				console.log(`${ts()} [Subagent] create_video: ${prompt}`);
				const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

				// Start video generation (long-running operation)
				let operation = await ai.models.generateVideos({
					model: 'veo-3.1-generate-preview',
					prompt,
					config: {
						aspectRatio: '16:9',
						personGeneration: 'allow_all',
					},
				});
				console.log(`${ts()} [Subagent] Video generation started: ${operation.name}`);

				// Poll until done (typically 30s–3min)
				while (!operation.done) {
					await new Promise((r) => setTimeout(r, 10_000));
					operation = await ai.operations.getVideosOperation({ operation });
					console.log(`${ts()} [Subagent] Polling video... done=${operation.done}`);
				}

				const video = operation.response?.generatedVideos?.[0]?.video;
				if (!video?.uri) {
					console.log(`${ts()} [Subagent] No video returned for: ${prompt}`);
					return { status: 'no_video', description: `No video was returned for: ${prompt}` };
				}

				// Download to temp file, read as base64
				const tmpPath = join(tmpdir(), `bodhi-video-${Date.now()}.mp4`);
				await ai.files.download({ file: video, downloadPath: tmpPath });
				const videoBytes = await readFile(tmpPath);
				const base64 = videoBytes.toString('base64');
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
				console.log(`${ts()} [Subagent] Video ready: ${prompt}`);
				return { status: 'success', description: `Generated video: ${prompt}` };
			},
		}),
	},
	maxSteps: 3,
	timeout: 300_000, // 5 min — video generation is slow
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
		// Schedule close after the LLM finishes its goodbye response
		setTimeout(async () => {
			ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' });
		}, 5000);
		return { status: 'ending', message: 'Session will close after goodbye.' };
	},
};

/**
 * Transfer-to-agent tool — used by the LLM to trigger agent transfers.
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
		'[System: A user just connected to the voice session. Greet them warmly. Introduce yourself as Bodhi, their voice assistant. Give a brief overview of what you can help with: doing math calculations, telling the time, creating pictures or videos from a description, and adjusting your speech speed if they need you to talk slower or faster. Then ask how you can help today. Keep it friendly and not too long.]',
	instructions: `You are a warm, patient voice assistant designed for older adults. Your name is Bodhi. Speak as a trusted companion — calm, clear, and never rushed.

VOICE & PACING RULES (follow these strictly):
- Deliver ONE idea per turn. Never chain two topics together.
- Pause briefly after each sentence. Let the user absorb what you said.
- Keep every response under 3 sentences unless the user asks for more detail.
- Speak at a measured pace. Never rush through information.
- If the user seems confused, slow down and rephrase — do not repeat the same words louder.
- CRITICAL: If the user mentions speed, pace, slower, or faster — even a single word like "slow" or "speak" — you MUST call the set_speech_speed tool BEFORE responding. Verbally agreeing to change speed does nothing. Only the tool changes your pace. Use preset "slow", "normal", or "fast".

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
- Calculator: Do math for the user.
- Current Time: Tell the user what time and date it is.
- Speech Speed: Make your voice slower or faster when the user asks.
- Image Generation: Create a picture from a description.
- Video Generation: Create a short video from a description. Warn the user it takes a minute or two.
- Math Expert: For harder math questions, you can hand off to a math specialist.
- End Session: When the user says goodbye or is done, call end_session.

TOOL GUIDELINES:
- Use the calculator for simple math.
- For harder math, tell the user: "Let me connect you with our math specialist." Then call transfer_to_agent with agent_name "math_expert".
- When the user asks to speak slower or faster, you MUST call set_speech_speed IMMEDIATELY. Do NOT just verbally agree to change speed — only the tool actually changes your pace. Call the tool first, then confirm.
- When the user asks for any picture, image, card, or illustration, you MUST call generate_image immediately. Do not describe an image verbally — always call the tool so the user can see it.
- When the user asks for a video, animation, or movie clip, you MUST call generate_video immediately. Warn them it takes a minute or two. Do not describe the video verbally — always call the tool.
- When the user says goodbye, says they are done, or wants to hang up, say a warm goodbye and call end_session.

THINGS TO AVOID:
- Never say "As an AI" or "As a language model".
- Never give long lists. If there are more than 3 items, offer them one at a time.
- Never assume the user knows how to do something. Offer to walk them through it.
- Never interrupt. Always wait for the user to finish speaking.
- Never use filler like "Great question!" — just answer directly and warmly.`,
	tools: [calculate, getCurrentTime, slowWebSearch, generateImage, generateVideo, endSession, transferFromMain],
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
	greeting: 'You just transferred to the math expert. Greet the user briefly — one short sentence — then ask what math problem they need help with.',
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
		apiKey: GEMINI_API_KEY, // Used for subagent text generation, not voice transport
		agents: [mainAgent, mathExpertAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.5-flash'),
		behaviors: [speechSpeed()],
		subagentConfigs: { generate_image: imageSubagent, generate_video: videoSubagent },
		transport, // Inject OpenAI Realtime transport
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

	sessionRef = session;

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
	console.log('Bodhi Realtime Agent — Senior-Friendly Voice Assistant');
	console.log('(OpenAI Realtime API)');
	console.log('============================================================');
	console.log();
	console.log(`  WebSocket audio server: ws://localhost:${PORT}`);
	console.log(`  Session ID: ${SESSION_ID}`);
	console.log();
	console.log('Connect a WebSocket audio client and try saying:');
	console.log("  - 'What time is it?'");
	console.log("  - 'What is 25 times 17?'");
	console.log("  - 'I need help with harder math' (transfers to math helper)");
	console.log("  - 'Speak slower please' (changes speech speed)");
	console.log("  - 'Draw me a picture of a sunset' (creates and displays image)");
	console.log("  - 'Make a video of a cat playing' (creates and displays video)");
	console.log("  - 'Goodbye' (ends the session)");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
