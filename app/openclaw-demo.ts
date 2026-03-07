/**
 * Bodhi + OpenClaw — Voice-Driven AI Agent Demo
 *
 * A voice assistant that combines Gemini's native capabilities (search, image/video
 * generation) with OpenClaw's general-purpose agent for coding, research, writing,
 * emails, and more.
 *
 * Features:
 * - Voice interface: Speak requests naturally
 * - OpenClaw agent: Delegates complex tasks (coding, research, email, etc.)
 * - Google Search: Real-time web search via Gemini's built-in grounding
 * - Image generation: Creates images via Gemini
 * - Video generation: Creates short videos via Veo
 * - Interactive delegation: OpenClaw can ask follow-up questions via voice
 *
 * Usage:
 *   1. Start OpenClaw gateway (ws://127.0.0.1:18789 by default)
 *   2. Set environment variables (see below)
 *   3. Run: pnpm tsx app/openclaw-demo.ts
 *   4. In another terminal: pnpm tsx app/web-client.ts
 *   5. Open http://localhost:8080 in Chrome, click Connect
 *
 * Environment Variables:
 *   GEMINI_API_KEY     - Required: Google AI Studio API key
 *   OPENCLAW_URL       - OpenClaw gateway WebSocket URL (default: ws://127.0.0.1:18789)
 *   OPENCLAW_TOKEN     - OpenClaw auth token (default: empty string)
 *   PORT               - Voice agent WebSocket port (default: 9900)
 *   HOST               - Voice agent bind address (default: 0.0.0.0)
 */

import 'dotenv/config';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { tool } from 'ai';
import { z } from 'zod';
import { VoiceSession } from '../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent, SubagentConfig } from '../src/types/agent.js';
import type { ToolDefinition } from '../src/types/tool.js';
import { OpenClawClient } from './lib/openclaw-client.js';
import { loadOrCreateDeviceIdentity } from './lib/openclaw-device-identity.js';
import { askOpenClawTool, createOpenClawSubagentConfig } from './lib/openclaw-tools.js';

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
if (API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'ws://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

const SESSION_ID = `session_${Date.now()}`;
const google = createGoogleGenerativeAI({ apiKey: API_KEY });

// Mutable ref so subagent tool closures can publish events on the session
let sessionRef: VoiceSession | null = null;

// =============================================================================
// Tools
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

const endSession: ToolDefinition = {
	name: 'end_session',
	description:
		'End the voice session gracefully. Call this when the user says goodbye or is done.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx) => {
		setTimeout(() => {
			ctx.sendJsonToClient?.({ type: 'session_end', reason: 'user_goodbye' });
		}, 5000);
		return { status: 'ending' };
	},
};

// -----------------------------------------------------------------------------
// Image Generation (background tool → subagent)
// -----------------------------------------------------------------------------

const generateImage: ToolDefinition = {
	name: 'generate_image',
	description:
		'Generate an image and display it to the user. ' +
		'ALWAYS call this tool when the user wants any kind of picture, image, card, illustration, or visual content. ' +
		'Do NOT describe the image verbally instead of calling this tool — you MUST call this tool to actually create it.',
	parameters: z.object({
		prompt: z.string().describe('Detailed description of the image to generate'),
	}),
	execution: 'background',
	pendingMessage: "I'm generating your image now. It'll appear on screen shortly.",
	execute: async () => ({}),
};

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
				const ai = new GoogleGenAI({ apiKey: API_KEY });
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

// -----------------------------------------------------------------------------
// Video Generation (background tool → subagent)
// -----------------------------------------------------------------------------

const generateVideo: ToolDefinition = {
	name: 'generate_video',
	description:
		'Generate a short video and display it to the user. ' +
		'ALWAYS call this tool when the user wants a video, animation, or movie clip. ' +
		'Do NOT describe the video verbally — you MUST call this tool to actually create it.',
	parameters: z.object({
		prompt: z.string().describe('Detailed description of the video to generate'),
	}),
	execution: 'background',
	pendingMessage:
		"I'm generating your video now. This takes a minute or two — I'll let you know when it's ready.",
	execute: async () => ({}),
};

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
				const ai = new GoogleGenAI({ apiKey: API_KEY });

				let operation = await ai.models.generateVideos({
					model: 'veo-3.1-generate-preview',
					prompt,
					config: {
						aspectRatio: '16:9',
						personGeneration: 'allow_all',
					},
				});
				console.log(`${ts()} [Subagent] Video generation started: ${operation.name}`);

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
	timeout: 300_000,
};

// =============================================================================
// Agent Definition
// =============================================================================

const mainAgent: MainAgent = {
	name: 'main',
	greeting: [
		'[System: A user just connected. Greet them warmly. Introduce yourself as Bodhi,',
		'a voice assistant with a powerful AI agent that can help with almost anything —',
		'coding, research, writing, browsing the web, sending emails, generating images and videos.',
		'Keep the greeting brief — 2-3 sentences max.]',
	].join(' '),
	instructions: [
		'You are Bodhi, a voice assistant powered by a capable AI agent (OpenClaw).',
		'OpenClaw is a general-purpose agent that can handle a wide range of tasks:',
		'coding, file management, web browsing, research, writing, sending emails,',
		'and much more. Do NOT assume it is limited to coding.',
		'',
		'TOOL ROUTING:',
		'- Google Search: Use for quick factual lookups — weather, news, sports scores,',
		'  "who is X", "what is Y". Gemini handles this natively (no tool call needed).',
		'- generate_image: When the user asks for any picture, image, card, or illustration.',
		'- generate_video: When the user asks for a video, animation, or movie clip.',
		'- get_current_time: For the current date/time.',
		'- ask_openclaw: For all other complex tasks fall into this category — generic tasks',
		'  include coding, writing emails, research reports, file operations, multi-step tasks',
		'  and anything you cannot handle with your built-in tools.',
		'  If unsure, route to OpenClaw.',
		'- end_session: When the user says goodbye.',
		'',
		'VOICE RULES:',
		'- Keep responses short and clear (2-3 sentences).',
		'- Do NOT read code aloud — summarize what was done.',
		'- When relaying results, focus on the outcome, not raw details.',
		'',
		'IMPORTANT:',
		'- OpenClaw may ask follow-up questions — these will be relayed to the user via voice.',
		'- For image/video generation, warn the user it may take a moment.',
	].join('\n'),
	tools: [askOpenClawTool, getCurrentTime, generateImage, generateVideo, endSession],
	googleSearch: true,
	onEnter: async () => {
		console.log(`${ts()} [Agent] Main agent entered`);
	},
};

// =============================================================================
// Main
// =============================================================================

async function main() {
	// Load or create Ed25519 device identity for gateway auth
	const device = await loadOrCreateDeviceIdentity();
	console.log(`${ts()} Device identity: ${device.deviceId.slice(0, 16)}...`);

	// Connect to OpenClaw gateway
	console.log(`${ts()} Connecting to OpenClaw gateway at ${OPENCLAW_URL}...`);
	const openclawClient = new OpenClawClient({
		url: OPENCLAW_URL,
		token: OPENCLAW_TOKEN,
		device,
	});
	await openclawClient.connect();
	console.log(`${ts()} OpenClaw gateway connected.`);

	// Create the interactive subagent config for OpenClaw
	const openclawSubagent = createOpenClawSubagentConfig(openclawClient, SESSION_ID);

	// Start voice session
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.5-flash'),
		subagentConfigs: {
			ask_openclaw: openclawSubagent,
			generate_image: imageSubagent,
			generate_video: videoSubagent,
		},
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-3-flash-preview' }),
		speechConfig: { voiceName: 'Puck' },
		hooks: {
			onSessionStart: (event) => {
				console.log(`${ts()} [Session] Started: ${event.sessionId}`);
			},
			onSessionEnd: (event) => {
				console.log(`${ts()} [Session] Ended: ${event.sessionId} (${event.reason})`);
			},
			onToolCall: (event) => {
				console.log(`${ts()} [Hook] Tool called: ${event.toolName} (${event.execution})`);
			},
			onToolResult: (event) => {
				console.log(
					`${ts()} [Hook] Tool result: ${event.toolCallId} (${event.status}, ${event.durationMs}ms)`,
				);
			},
			onSubagentStep: (event) => {
				console.log(
					`${ts()} [Hook] Subagent step: ${event.subagentName} #${event.stepNumber} tools=[${event.toolCalls.join(',')}]`,
				);
			},
			onError: (event) => {
				console.error(
					`${ts()} [Error] ${event.component}: ${event.error.message} (${event.severity})`,
				);
			},
		},
	});

	sessionRef = session;

	// Log conversation turns
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

	// Shutdown handler
	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session.close('user_hangup');
		await openclawClient.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Start
	await session.start();

	console.log('============================================================');
	console.log('Bodhi + OpenClaw — Voice-Driven AI Agent');
	console.log('============================================================');
	console.log();
	console.log(`  Voice agent:     ws://localhost:${PORT}`);
	console.log(`  OpenClaw:        ${OPENCLAW_URL}`);
	console.log(`  Session ID:      ${SESSION_ID}`);
	console.log();
	console.log('Start the web client in another terminal:');
	console.log('  pnpm tsx app/web-client.ts');
	console.log();
	console.log('Then open http://localhost:8080 and try saying:');
	console.log("  - 'What is the weather in San Francisco?'  (Google Search)");
	console.log("  - 'Draw me a picture of a sunset'          (Image generation)");
	console.log("  - 'Write a Python prime checker'           (OpenClaw agent)");
	console.log("  - 'Summarize today's tech news by email'   (OpenClaw agent)");
	console.log("  - 'Goodbye'");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
