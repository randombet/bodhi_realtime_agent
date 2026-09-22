/**
 * Bodhi — Senior-Friendly Voice Assistant (OpenAI Realtime)
 *
 * A warm, patient voice assistant designed for older adults. Built with
 * the Bodhi Realtime Agent Framework using the OpenAI Realtime API.
 *
 * Features:
 * - Senior-friendly: Slow pacing, plain language, one idea per turn
 * - Function tools: Calculator, current time, image generation, video generation
 * - Multi-agent: Transfers to a patient math helper for harder questions
 * - Session management: Graceful goodbye with end_session tool
 *
 * Usage:
 *   1. Set OPENAI_API_KEY and GEMINI_API_KEY in .env file or as environment variables
 *      (OPENAI_API_KEY for the voice session, GEMINI_API_KEY for image/video subagents)
 *   2. Run: pnpm tsx examples/openai-realtime-tools.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *   4. Try saying:
 *        "What time is it?"
 *        "What is 25 times 17?"
 *        "I need help with harder math" (transfers to math helper)
 *        "Goodbye" (ends session gracefully)
 *        "I want to dictate a long passage" → agent calls set_transcription_mode
 *        "end dictation" / "stop dictation" / "exit transcription mode" / "done dictating"
 *           → exit-phrase watcher flips back to agent mode (and is NOT added to the buffer)
 *        "please send what I dictated" → agent calls inject_dictation_as_user_message
 *   5. (Optional) Send `{"type":"set_transcription_mode","mode":"agent"}` over the
 *      client WS at any time to flip back to agent mode from a UI button.
 *   6. While in transcription mode, Whisper transcripts are streamed to the connected
 *      client as `{"type":"dictation_transcript", text, partial?, exit?}` JSON messages
 *      AND logged to the server console — so a web client (`pnpm web-client`) can
 *      render live dictation, and you can see it from the server logs too.
 *
 * Optional context-caching env vars (see the Cache configuration block below
 * for the full details):
 *
 *   CACHE_TRUNCATION_RATIO=0.8    Set cacheConfig.truncation = retention_ratio:0.8.
 *                                  The documented OpenAI cost-preservation lever —
 *                                  retains more of the cached prefix when context
 *                                  fills, reducing per-turn cache busts.
 *   CACHE_PROMPT_KEY=my_agent_v1  EXPERIMENTAL prompt_cache_key. Probe-gated: the
 *                                  transport silently strips the field if the server
 *                                  rejects it. Recommended scoping: per agent + region.
 *   CACHE_ENFORCE_STABILITY=1     Throw CachePrefixMutationError on connected,
 *                                  non-transfer prefix mutations. Multi-agent transfers
 *                                  still work by default.
 *   CACHE_DISALLOW_TRANSFER=1     Also block transfers (set with CACHE_ENFORCE_STABILITY).
 *   OPENAI_BASE_URL / OPENAI_ORGANIZATION / OPENAI_PROJECT — pass-through to the SDK
 *                                  client (also part of the probe scope key).
 *
 *   Watch for [Usage] log lines after each turn — they print input/output/cached
 *   tokens and the computed cacheHitRatio. [CacheBust] lines fire on real
 *   instructions/tools mutations (same-canonical-prefix updates suppress the signal).
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

import {
	discardDictationTool,
	injectDictationTool,
	readDictationBufferTool,
} from '../src/tools/built-in-dictation-tools.js';
import { OpenAIRealtimeTransport } from '../src/transport/openai-realtime-transport.js';
import { OpenAIRealtimeWhisperSTTProvider } from '../src/transport/openai-realtime-whisper-stt-provider.js';
import type { MainAgent, SubagentConfig } from '../src/types/agent.js';
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
if (OPENAI_API_KEY.length === 0) {
	console.error('Error: OPENAI_API_KEY environment variable is required');
	process.exit(1);
}

// Gemini API key is still needed for image/video subagents
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
if (GEMINI_API_KEY.length === 0) {
	console.error(
		'Error: GEMINI_API_KEY environment variable is required (for image/video subagents)',
	);
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0'; // '0.0.0.0' binds to all interfaces for EC2
const SESSION_ID = `session_${Date.now()}`;
const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

// =============================================================================
// Cache configuration (env-driven)
// =============================================================================
//
// CACHE_TRUNCATION_RATIO  — float in [0, 1]. When set, maps to
//                           cacheConfig.truncation = { type: 'retention_ratio', ... }.
//                           This is the documented OpenAI cost-preservation lever:
//                           values < 1 retain more of the cached prefix when context
//                           fills, reducing per-turn cache busts. 0.8 is a sensible
//                           production default. Omit to fall through to server default.
// CACHE_PROMPT_KEY        — opaque string. EXPERIMENTAL — sent as prompt_cache_key.
//                           Routes the session to the same backend host as other
//                           sessions with the same key, improving hit rate. Documented
//                           for Responses/Chat; community-reported for Realtime, so the
//                           transport probes acceptance on first send and silently
//                           strips the field if rejected. Recommended scoping: per agent
//                           + region. Over-sharing one key hits the ~15 RPM/host cap and
//                           degrades hit rate.
// CACHE_ENFORCE_STABILITY=1  Opt in to cacheConfig.enforcePrefixStability. Throws
//                           CachePrefixMutationError on connected, non-transfer prefix
//                           changes. NOTE: this demo has multi-agent transfer
//                           (main ↔ math_expert), which legitimately swaps
//                           instructions/tools — that's allowed by default
//                           (allowMutationOnTransfer=true). Set CACHE_DISALLOW_TRANSFER=1
//                           on top to also block transfers (single-agent-only mode).
// CACHE_DISALLOW_TRANSFER=1  Set allowMutationOnTransfer=false. Only meaningful when
//                           CACHE_ENFORCE_STABILITY=1.
// OPENAI_BASE_URL / OPENAI_ORGANIZATION / OPENAI_PROJECT — pass-through to the SDK
//                           client. Probe scope keys include all three so a rejection
//                           in one deployment does not poison others.
const CACHE_TRUNCATION_RATIO_RAW = process.env.CACHE_TRUNCATION_RATIO;
const CACHE_TRUNCATION_RATIO =
	CACHE_TRUNCATION_RATIO_RAW !== undefined ? Number(CACHE_TRUNCATION_RATIO_RAW) : undefined;
if (
	CACHE_TRUNCATION_RATIO !== undefined &&
	(Number.isNaN(CACHE_TRUNCATION_RATIO) || CACHE_TRUNCATION_RATIO < 0 || CACHE_TRUNCATION_RATIO > 1)
) {
	console.error(
		`Error: CACHE_TRUNCATION_RATIO must be a number in [0, 1] (got "${CACHE_TRUNCATION_RATIO_RAW}")`,
	);
	process.exit(1);
}
const CACHE_PROMPT_KEY = process.env.CACHE_PROMPT_KEY;
const CACHE_ENFORCE_STABILITY = process.env.CACHE_ENFORCE_STABILITY === '1';
const CACHE_DISALLOW_TRANSFER = process.env.CACHE_DISALLOW_TRANSFER === '1';

// Build the cacheConfig object only when at least one knob is requested, so
// callers who don't opt in see the same wire payload they did before this
// demo grew the option.
type OpenAICacheConfig = NonNullable<
	ConstructorParameters<typeof OpenAIRealtimeTransport>[0]['cacheConfig']
>;
const cacheConfig: OpenAICacheConfig | undefined = (() => {
	const cfg: OpenAICacheConfig = {};
	if (CACHE_TRUNCATION_RATIO !== undefined) {
		cfg.truncation = { type: 'retention_ratio', retentionRatio: CACHE_TRUNCATION_RATIO };
	}
	if (CACHE_PROMPT_KEY) {
		cfg.experimental = { promptCacheKey: CACHE_PROMPT_KEY };
	}
	if (CACHE_ENFORCE_STABILITY) {
		cfg.enforcePrefixStability = true;
		// Default true (transfers allowed); only flip when explicitly requested.
		if (CACHE_DISALLOW_TRANSFER) cfg.allowMutationOnTransfer = false;
	}
	return Object.keys(cfg).length > 0 ? cfg : undefined;
})();

// =============================================================================
// OpenAI Realtime Transport
// =============================================================================

const transport = new OpenAIRealtimeTransport({
	apiKey: OPENAI_API_KEY,
	model: 'gpt-realtime-2',
	voice: 'coral',
	// `eagerness` left to framework default ('low') — reduces echo-induced
	// false-positive barge-ins on the 2nd+ response. Override to 'medium'
	// or 'high' here if you want snappier interrupts and accept the higher
	// false-positive rate.
	turnDetection: { type: 'semantic_vad' },
	noiseReduction: { type: 'far_field' },
	// gpt-realtime-2 supports configurable reasoning (low, medium, high, and xhigh). 'low' is the
	// documented production default — balances latency vs accuracy.
	reasoning: { effort: 'high' },
	// P3/P5/P6 cacheConfig — see env-vars block above. Omitted (undefined) when
	// no caching env vars are set, so existing demo behavior is unchanged.
	...(cacheConfig !== undefined ? { cacheConfig } : {}),
	// P6 SDK pass-throughs. The probe scope key includes baseURL, organization,
	// and project so a rejection in one deployment does not poison others.
	...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
	...(process.env.OPENAI_ORGANIZATION ? { organization: process.env.OPENAI_ORGANIZATION } : {}),
	...(process.env.OPENAI_PROJECT ? { project: process.env.OPENAI_PROJECT } : {}),
});

// =============================================================================
// Whisper STT Provider (for transcription mode)
// =============================================================================

/**
 * `gpt-realtime-whisper` is used in transcription mode. While in this mode,
 * the OpenAI Realtime transport is quiesced (no audio output, no
 * `response.create`) and mic audio is fed to Whisper instead. Whisper
 * transcripts accumulate in `voiceSession.getDictationBuffer()`; the user
 * exits dictation mode either by saying "end dictation" / "stop dictation"
 * (handled by the transcript watcher below) or by sending a JSON command
 * over the client WS (also handled below).
 */
const whisperProvider = new OpenAIRealtimeWhisperSTTProvider({
	apiKey: OPENAI_API_KEY,
});

// =============================================================================
// Lazy session proxy
// =============================================================================

/**
 * The built-in dictation tools and `set_transcription_mode` need a live
 * `VoiceSession` reference, but the agent's tools array must exist before
 * VoiceSession is constructed (the agent is passed into the constructor).
 *
 * Solution: a Proxy that forwards to `sessionRef.current` at call time.
 * The dictation tools never touch the session at factory time — they only
 * capture it for use inside `execute()`. By the time the model calls any
 * of them, `sessionRef.current` is populated.
 */
const sessionProxy = new Proxy({} as VoiceSession, {
	get(_target, prop, receiver) {
		const live = sessionRef;
		if (!live) {
			throw new Error(`sessionProxy: VoiceSession not constructed yet (accessed ${String(prop)})`);
		}
		const value = Reflect.get(live, prop, receiver);
		return typeof value === 'function' ? value.bind(live) : value;
	},
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
	description:
		'End the voice session gracefully. Call this when the user says goodbye, wants to hang up, or indicates they are done.',
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
		agent_name: z.enum(['math_expert']).describe('The agent to transfer to'),
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

/**
 * Switch the session between agent and transcription mode at the LLM's
 * request. Typical use: the user says "I want to dictate a long passage"
 * and the agent calls this tool with mode='transcription'. The
 * transport quiesces (the agent stops mid-response if needed), audio is
 * routed to Whisper, and transcripts accumulate in the dictation buffer.
 *
 * The agent CANNOT call this tool with mode='agent' while already in
 * transcription mode — once in dictation, the agent is silenced and tool
 * calls won't fire. Exits are user-driven: either say "end dictation"
 * (the transcript watcher in main() flips back) or send a JSON command
 * over the client WS (also handled in main()).
 */
const setTranscriptionMode: ToolDefinition = {
	name: 'set_transcription_mode',
	description:
		'Switch between "agent" mode (assistant is listening and replies) and "transcription" mode ' +
		'(user dictates a longer passage; assistant goes silent until the user says "end dictation"). ' +
		'Call ONLY when the user explicitly asks to dictate, take a memo, or compose a longer message. ' +
		'Once in transcription mode this tool CANNOT switch back — the user exits by saying "end dictation".',
	parameters: z.object({
		mode: z
			.enum(['agent', 'transcription'])
			.describe('Target mode. Typically "transcription"; reverse is user-driven.'),
	}),
	execution: 'inline',
	// scheduling: 'silent' — the result is informational only ("yes, I flipped").
	// Without this, the framework would queue the result during transcription mode
	// and fire `response.create` when we return to agent mode, causing the
	// assistant to speak a stale "ready for dictation" line at the wrong time.
	scheduling: 'silent',
	execute: async (args) => {
		const { mode } = args as { mode: 'agent' | 'transcription' };
		if (!sessionRef) return { error: 'session_not_ready' };
		await sessionRef.setTranscriptionMode(mode);
		console.log(`${ts()} [Tool] set_transcription_mode → ${mode}`);
		return { mode };
	},
};

// =============================================================================
// Dictation-buffer tools (factories from the framework; closed over sessionProxy)
// =============================================================================

/**
 * Three built-in factory tools that operate on the dictation buffer.
 * Each factory closes over `sessionProxy`, which forwards to the live
 * `VoiceSession` once it's constructed (lazy-Proxy pattern from above).
 *
 * The agent uses these AFTER the user has exited transcription mode and
 * asks the agent to do something with what they dictated.
 */
const injectDictation = injectDictationTool(sessionProxy);
const readDictation = readDictationBufferTool(sessionProxy);
const discardDictation = discardDictationTool(sessionProxy);

// =============================================================================
// Agent Definitions
// =============================================================================

const mainAgent: MainAgent = {
	name: 'main',
	greeting:
		'[System: A user just connected to the voice session. Greet them warmly. Introduce yourself as Bodhi, their voice assistant. Give a brief overview of what you can help with: doing math calculations, telling the time, and creating pictures or videos from a description. Then ask how you can help today. Keep it friendly and not too long.]',
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
- When giving suggestions, give binary choices, not open-ended questions: "Do you want the weather, or the news?" not "What would you like to know?"

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
- Image Generation: Create a picture from a description.
- Video Generation: Create a short video from a description. Warn the user it takes a minute or two.
- Math Expert: For harder math questions, you can hand off to a math specialist.
- End Session: When the user says goodbye or is done, call end_session.
- Set Transcription Mode: When the user wants to dictate a longer message or memo, call set_transcription_mode with mode "transcription". You go silent; the user dictates; they say "end dictation" to come back to you.
- Inject Dictation: After the user finishes dictating and tells you to "send it" or "use that", call inject_dictation_as_user_message — it adds their dictation to the conversation as their next message.
- Read Dictation Buffer: If you want to confirm with the user what they dictated before injecting, call read_dictation_buffer first.
- Discard Dictation: If the user says "scratch that" or "never mind" about a dictation, call discard_dictation.

TOOL GUIDELINES:
- Use the calculator for simple math.
- For harder math, tell the user: "Let me connect you with our math specialist." Then call transfer_to_agent with agent_name "math_expert".
- When the user asks for any picture, image, card, or illustration, you MUST call generate_image immediately. Do not describe an image verbally — always call the tool so the user can see it.
- When the user asks for a video, animation, or movie clip, you MUST call generate_video immediately. Warn them it takes a minute or two. Do not describe the video verbally — always call the tool.
- When the user says goodbye, says they are done, or wants to hang up, say a warm goodbye and call end_session.
- When the user asks to dictate, take a memo, or compose a longer passage, briefly acknowledge and call set_transcription_mode with mode "transcription". Do NOT call set_transcription_mode with mode "agent" — the user does that by saying "end dictation".

THINGS TO AVOID:
- Never say "As an AI" or "As a language model".
- Never give long lists. If there are more than 3 items, offer them one at a time.
- Never assume the user knows how to do something. Offer to walk them through it.
- Never interrupt. Always wait for the user to finish speaking.
- Never use filler like "Great question!" — just answer directly and warmly.`,
	tools: [
		calculate,
		getCurrentTime,
		slowWebSearch,
		generateImage,
		generateVideo,
		endSession,
		transferFromMain,
		setTranscriptionMode,
		injectDictation,
		readDictation,
		discardDictation,
	],
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
	greeting:
		'You just transferred to the math expert. Greet the user briefly — one short sentence — then ask what math problem they need help with.',
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
		subagentConfigs: { generate_image: imageSubagent, generate_video: videoSubagent },
		transport, // Inject OpenAI Realtime transport
		whisperProvider, // Powers transcription mode (gpt-realtime-whisper)
		// Playback-end gating for OpenAI native audio — keeps barge-in armed
		// through the buffered-playback tail (OpenAI streams faster than
		// realtime). See design-playback-end-gating-openai-native.md.
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: true,
		// Custom inbound-JSON handling: a UI client (or test harness) can send
		// { "type": "set_transcription_mode", "mode": "agent" | "transcription" }
		// over the client WebSocket. `onClientJson` fires for message types the
		// framework does not recognize (the supported public seam — no private
		// monkey-patching). `sessionRef` is the late-bound session (set below).
		onClientJson: (msg) => {
			if (msg.type !== 'set_transcription_mode') return;
			const mode = msg.mode;
			if (mode === 'agent' || mode === 'transcription') {
				console.log(`${ts()} [JSON] set_transcription_mode → ${mode}`);
				void sessionRef?.setTranscriptionMode(mode).catch((err) => {
					console.error(`${ts()} [JSON] setTranscriptionMode failed`, err);
				});
				return;
			}
			console.warn(`${ts()} [JSON] set_transcription_mode: invalid mode "${String(mode)}"`);
		},
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

	// =========================================================================
	// Transcription-mode exit mechanisms (two paths)
	// =========================================================================

	// (1) Voice exit: watch Whisper transcripts for an exit phrase. VoiceSession
	//     wired whisperProvider.onTranscript to append every transcript to the
	//     dictation buffer. We re-wrap it so:
	//       (a) the exit phrase is detected BEFORE the buffer append (so the
	//           phrase doesn't end up inside the buffer the agent later sees);
	//       (b) every final transcript is also logged to the console AND pushed
	//           to the connected web client as a JSON message, so dictation
	//           progress is visible without inspecting server logs.
	//
	// Exit phrases accepted (case-insensitive, word-boundary):
	//   "end dictation", "stop dictation", "exit dictation", "exit transcription",
	//   "done dictating", "finish dictation"
	const EXIT_PATTERN =
		/\b(end|stop|exit|finish)\s+(dictation|transcription(\s+mode)?)\b|\bdone\s+dictating\b/i;

	const wiredOnTranscript = whisperProvider.onTranscript;
	whisperProvider.onTranscript = (text, turnId) => {
		const isExit = EXIT_PATTERN.test(text);
		if (isExit) {
			console.log(`${ts()} [Watcher] Exit phrase heard ("${text}") — flipping to agent mode`);
			// Surface the event to the client so a UI can update.
			try {
				session.sendJsonToClient({
					type: 'dictation_transcript',
					text,
					exit: true,
				});
			} catch {
				/* best-effort */
			}
			void session.setTranscriptionMode('agent').catch((err) => {
				console.error(`${ts()} [Watcher] setTranscriptionMode failed`, err);
			});
			// IMPORTANT: do NOT call the wired buffer-append handler — the
			// exit phrase isn't part of the user's dictation content.
			return;
		}

		// Normal dictation transcript: append to buffer + log + forward to UI.
		wiredOnTranscript?.(text, turnId);
		console.log(`${ts()} [Dictation] final: "${text}"`);
		try {
			session.sendJsonToClient({
				type: 'dictation_transcript',
				text,
				partial: false,
			});
		} catch {
			/* best-effort */
		}
	};

	// Live partial-transcript stream → web client. Lets the UI render the
	// dictation as it's being recognised.
	whisperProvider.onPartialTranscript = (text) => {
		try {
			session.sendJsonToClient({
				type: 'dictation_transcript',
				text,
				partial: true,
			});
		} catch {
			/* best-effort */
		}
	};

	// (2) JSON-over-WS exit: handled via the `onClientJson` config hook above —
	//     a UI client sends { "type": "set_transcription_mode", "mode": ... } over
	//     the client WebSocket and the framework forwards the unrecognized type to
	//     that hook. No private monkey-patching required.

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

	// =========================================================================
	// Cache observability — realtime.usage + realtime.cache.bust (P4)
	// =========================================================================
	//
	// One realtime.usage event per provider usage callback (NOT one per turn).
	// OpenAI fires twice for a typical turn:
	//   - source='openai.response'      (response.done payload)
	//   - source='openai.transcription' (input audio transcription completed)
	// Both carry input/output/cached token counts in usage.modalityBreakdown.
	//
	// cacheHitRatio is provider-aware: returns a real ratio for openai.response
	// when caching was reported, undefined for openai.transcription (transcription
	// is not cache-eligible). For openai.response it includes explicit zero
	// (= cache miss) — that's a meaningful signal, not "no signal".
	//
	// Watch the [Usage] log lines after a few turns:
	//   - First turn typically has cachedTokens=0 (cold cache).
	//   - Subsequent turns with the same prefix should show non-zero cachedTokens
	//     and a cacheHitRatio ~0.5–0.95 depending on how much of the conversation
	//     fits in the cached prefix vs the dynamic tail.
	session.eventBus.subscribe('realtime.usage', (evt) => {
		const u = evt.usage;
		const cached = u.modalityBreakdown?.cachedTokens;
		const cachedAudio = u.modalityBreakdown?.cachedAudioTokens;
		const cachedText = u.modalityBreakdown?.cachedTextTokens;
		const ratioStr =
			evt.cacheHitRatio !== undefined ? `${(evt.cacheHitRatio * 100).toFixed(1)}%` : '—';
		const breakdown =
			cachedAudio !== undefined || cachedText !== undefined
				? ` (audio=${cachedAudio ?? 0}, text=${cachedText ?? 0})`
				: '';
		console.log(
			`${ts()} [Usage] turn=${evt.turnId ?? '-'} src=${evt.source} ` +
				`in=${u.inputTokens ?? '?'} out=${u.outputTokens ?? '?'} ` +
				`cached=${cached ?? 0}${breakdown} hitRatio=${ratioStr} ` +
				`item=${evt.providerItemId ?? '-'} seq=${evt.sequence}`,
		);
	});

	// Cache busts — fired by the OpenAI transport on instructions/tools mutations.
	// Same-canonical-prefix updates (e.g. re-applying identical instructions) do
	// NOT fire this signal (P5 hardening).
	session.eventBus.subscribe('realtime.cache.bust', (evt) => {
		console.log(
			`${ts()} [CacheBust] reason=${evt.reason} agent=${evt.agentName} turn=${evt.turnId ?? '-'}`,
		);
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
	const cacheLines: string[] = [];
	if (cacheConfig?.truncation && typeof cacheConfig.truncation === 'object') {
		cacheLines.push(`truncation=retention_ratio:${cacheConfig.truncation.retentionRatio}`);
	} else if (cacheConfig?.truncation) {
		cacheLines.push(`truncation=${cacheConfig.truncation}`);
	}
	if (cacheConfig?.experimental?.promptCacheKey) {
		cacheLines.push(`promptCacheKey="${cacheConfig.experimental.promptCacheKey}" (probe-gated)`);
	}
	if (cacheConfig?.enforcePrefixStability) {
		cacheLines.push(
			`enforcePrefixStability=on (allowMutationOnTransfer=${
				cacheConfig.allowMutationOnTransfer === false ? 'false' : 'true (default)'
			})`,
		);
	}
	console.log(
		`  Cache:    ${cacheLines.length > 0 ? cacheLines.join(', ') : 'off (set CACHE_TRUNCATION_RATIO / CACHE_PROMPT_KEY / CACHE_ENFORCE_STABILITY to opt in)'}`,
	);
	console.log();
	console.log('Connect a WebSocket audio client and try saying:');
	console.log("  - 'What time is it?'");
	console.log("  - 'What is 25 times 17?'");
	console.log("  - 'I need help with harder math' (transfers to math helper)");
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
