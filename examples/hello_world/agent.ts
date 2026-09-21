// SPDX-License-Identifier: MIT

/**
 * Hello World — Multi-Agent Voice Assistant
 *
 * Demonstrates five key features of the Bodhi Realtime Agent Framework:
 *
 *   1. Voice pacing      — Declarative behaviors API with speechSpeed preset
 *   2. Agent transfer    — Main agent hands off to a math specialist
 *   3. Google Search     — Grounded web search via Gemini
 *   4. Image generation  — Creates images via Gemini and pushes them to the client
 *   5. Video generation  — Creates videos via Veo and pushes them to the client
 *
 * Usage:
 *   GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent.ts
 */

import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { GoogleGenAI } from '@google/genai';
import { tool } from 'ai';
import { z } from 'zod';
import { VoiceSession } from '../../src/index.js';
import { speechSpeed } from '../../src/behaviors/presets.js';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent, SubagentConfig, ToolDefinition } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (!API_KEY) {
	console.error('Error: set GEMINI_API_KEY environment variable');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_ID = `session_${Date.now()}`;

const ts = () => new Date().toISOString().slice(11, 23);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Background image generation — Gemini keeps talking while a subagent
 * generates the image and pushes it to the client when ready.
 */
const generateImage: ToolDefinition = {
	name: 'generate_image',
	description: `Generate an image and display it to the user.
ALWAYS call this tool when the user wants any kind of picture, image, or illustration.
Do NOT describe the image verbally — you MUST call this tool to actually create it.`,
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

/**
 * Background video generation — Gemini keeps talking while a subagent
 * generates a video via Veo and pushes it to the client when ready.
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
		'You generate videos. Call the create_video tool with the prompt from the task description. Return a short summary of what was generated.',
	tools: {
		create_video: tool({
			description: 'Generate a video using Veo and display it to the user.',
			parameters: z.object({
				prompt: z.string().describe('Video generation prompt'),
			}),
			execute: async ({ prompt }) => {
				console.log(`${ts()} [Subagent] create_video: ${prompt}`);
				const ai = new GoogleGenAI({ apiKey: API_KEY });

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

/** Transfer from main → math_expert. */
const transferFromMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: `Transfer to the math expert for complex math questions.`,
	parameters: z.object({
		agent_name: z.enum(['math_expert']).describe('Agent to transfer to'),
	}),
	execution: 'inline',
	execute: async () => ({ status: 'transferred' }),
};

/** Transfer from math_expert → main. */
const transferToMain: ToolDefinition = {
	name: 'transfer_to_agent',
	description: 'Transfer back to the main assistant when done with math.',
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
		'[System: Greet the user warmly. Introduce yourself as Bodhi. Mention you can search the web, do math, create pictures and videos, and adjust speech speed. Keep it short.]',
	instructions: `You are a friendly voice assistant named Bodhi. Keep responses concise — this is voice.

MANDATORY TOOL RULES (violating these is a failure):
1. SPEECH SPEED: When the user asks to speak slower, faster, or at normal speed, you MUST call set_speech_speed IMMEDIATELY. Do NOT say "sure" first. Call the tool, THEN confirm. If you say "I've adjusted" without calling the tool, you are LYING — only the tool changes your speed.
2. IMAGE GENERATION: When the user asks for any picture, image, or illustration, you MUST call generate_image IMMEDIATELY. Do NOT describe the image verbally instead.
3. VIDEO GENERATION: When the user asks for a video, animation, or movie clip, you MUST call generate_video IMMEDIATELY. Do NOT describe the video verbally instead. Warn the user it may take a minute or two.
4. AGENT TRANSFER: When the user asks for math help, say "Let me connect you with the math expert" and IMMEDIATELY call transfer_to_agent with agent_name "math_expert".
5. NEVER claim you did something without calling the corresponding tool.`,
	tools: [generateImage, generateVideo, transferFromMain],
	googleSearch: true,
	onEnter: async () => console.log(`${ts()} [Agent] main entered`),
};

const mathExpert: MainAgent = {
	name: 'math_expert',
	greeting:
		'Greet the user briefly and ask what math problem they need help with.',
	instructions: `You are a patient math helper named Bodhi. Break problems into clear steps. Use simple language.

When the user has no more math questions, say "Let me take you back" and IMMEDIATELY call transfer_to_agent with agent_name "main".`,
	tools: [transferToMain],
	onEnter: async () => console.log(`${ts()} [Agent] math_expert entered`),
};

// ---------------------------------------------------------------------------
// Start session
// ---------------------------------------------------------------------------

async function main() {
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent, mathExpert],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: createGoogleGenerativeAI({ apiKey: API_KEY })('gemini-2.5-flash'),
		behaviors: [speechSpeed()],
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-2.5-flash' }),
		speechConfig: { voiceName: 'Puck' },
		subagentConfigs: { generate_image: imageSubagent, generate_video: videoSubagent },
		hooks: {
			onToolCall: (e) =>
				console.log(`${ts()} [Hook] ${e.toolName} (${e.execution})`),
			onAgentTransfer: (e) =>
				console.log(`${ts()} [Hook] transfer: ${e.fromAgent} → ${e.toAgent}`),
			onError: (e) =>
				console.error(`${ts()} [Error] ${e.component}: ${e.error.message}`),
		},
	});

	sessionRef = session;

	process.on('SIGINT', async () => {
		await session.close('user_hangup');
		process.exit(0);
	});

	await session.start();

	console.log(`\n  Bodhi — Hello World Example`);
	console.log(`  ws://localhost:${PORT}\n`);
	console.log('  Try saying:');
	console.log("    'Speak slower'               → voice pacing");
	console.log("    'I need help with math'       → agent transfer");
	console.log("    'What is the weather today?'  → Google Search");
	console.log("    'Draw me a sunset'            → image generation");
	console.log("    'Make a video of a cat'       → video generation");
	console.log('\n  Press Ctrl+C to stop.\n');
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
