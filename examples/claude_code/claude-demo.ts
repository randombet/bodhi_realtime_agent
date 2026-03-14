/**
 * Bodhi + Claude Code — Voice-Driven Coding Assistant
 *
 * A voice assistant that delegates coding tasks to Claude Code. Claude has full
 * access to the local codebase — it can read, edit, create, and delete files,
 * run shell commands, and search code.
 *
 * Features:
 * - Voice interface: Speak coding requests naturally
 * - Claude Code agent: Full codebase access (Read, Edit, Write, Bash, Glob, Grep)
 * - Email sending: Claude can send email via macOS Mail.app (AppleScript)
 * - Google Search: Real-time web search via Gemini's built-in grounding
 * - Image generation: Creates images via Gemini
 * - Interactive delegation: Claude can ask follow-up questions via voice
 *
 * Usage:
 *   1. Set environment variables (see below)
 *   2. Run: pnpm tsx examples/claude_code/claude-demo.ts
 *   3. In another terminal: pnpm tsx examples/openclaw/web-client.ts
 *   4. Open http://localhost:8080 in Chrome, click Connect
 *
 * Environment Variables:
 *   GEMINI_API_KEY     - Required: Google AI Studio API key
 *   ANTHROPIC_API_KEY  - Required: Anthropic API key for Claude Agent SDK
 *   PROJECT_DIR        - Claude's working directory (default: process.cwd())
 *   PORT               - Voice agent WebSocket port (default: 9900)
 *   HOST               - Voice agent bind address (default: 0.0.0.0)
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createSdkMcpServer, tool as mcpTool } from '@anthropic-ai/claude-agent-sdk';
import { GoogleGenAI } from '@google/genai';
import { tool } from 'ai';
import { z } from 'zod';
import { VoiceSession } from '../../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent, SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import { assertMacOS, sendEmail } from './apple-mail-sender.js';
import { askClaudeTool, createClaudeCodeSubagentConfig } from './claude-code-tools.js';

// =============================================================================
// Helpers
// =============================================================================

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

interface PendingToolCall {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	args: Record<string, unknown>;
}

/**
 * Derive pending tool calls from ConversationContext.
 *
 * A call is considered pending if a `tool_call` exists without a matching
 * `tool_result` for the same toolCallId.
 */
function getPendingToolCalls(toolName?: string): PendingToolCall[] {
	const items = sessionRef?.conversationContext.items ?? [];
	const calls = new Map<string, PendingToolCall>();
	const completed = new Set<string>();

	for (const item of items) {
		if (item.role === 'tool_call') {
			try {
				const parsed = JSON.parse(item.content) as Partial<{
					toolCallId: string;
					toolName: string;
					args: Record<string, unknown>;
				}>;
				if (typeof parsed.toolCallId === 'string' && typeof parsed.toolName === 'string') {
					calls.set(parsed.toolCallId, {
						toolCallId: parsed.toolCallId,
						toolName: parsed.toolName,
						startedAt: item.timestamp,
						args: parsed.args ?? {},
					});
				}
			} catch {
				// Ignore malformed historical entries.
			}
		}

		if (item.role === 'tool_result') {
			try {
				const parsed = JSON.parse(item.content) as Partial<{ toolCallId: string }>;
				if (typeof parsed.toolCallId === 'string') {
					completed.add(parsed.toolCallId);
				}
			} catch {
				// Ignore malformed historical entries.
			}
		}
	}

	const pending = [...calls.values()].filter((call) => !completed.has(call.toolCallId));
	return toolName ? pending.filter((call) => call.toolName === toolName) : pending;
}

// =============================================================================
// Configuration
// =============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
if (GEMINI_API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY environment variable is required');
	process.exit(1);
}


const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const CLAUDE_DEFAULT_THREAD_KEY = process.env.CLAUDE_DEFAULT_THREAD_KEY || 'claude_demo_main';

const SESSION_ID = `session_${Date.now()}`;
const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

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

const getClaudeTaskStatus: ToolDefinition = {
	name: 'get_claude_task_status',
	description:
		'Check whether Claude currently has an in-progress ask_claude task. ' +
		'Use this for status/progress questions. Do NOT call ask_claude only to check progress.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async () => {
		const pendingClaudeCalls = getPendingToolCalls('ask_claude');
		const oldestStartedAt =
			pendingClaudeCalls.length > 0
				? Math.min(...pendingClaudeCalls.map((call) => call.startedAt))
				: null;
		const elapsedSeconds = oldestStartedAt ? Math.floor((Date.now() - oldestStartedAt) / 1000) : 0;

		return {
			inProgress: pendingClaudeCalls.length > 0,
			pendingCount: pendingClaudeCalls.length,
			elapsedSeconds,
			pendingTasks: pendingClaudeCalls
				.map((call) => (typeof call.args.task === 'string' ? call.args.task : ''))
				.filter((text) => text.length > 0)
				.slice(0, 3),
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

// =============================================================================
// Agent Definition
// =============================================================================

const mainAgent: MainAgent = {
	name: 'main',
	greeting: [
		'[System: A user just connected. Greet them warmly. Introduce yourself as Bodhi,',
		'a voice-powered coding assistant backed by Claude Code.',
		'Claude has full access to the project codebase and can read, edit, create files,',
		'run commands, and search code. Mention you can also look things up on the web',
		'and generate images. Keep the greeting brief — 2-3 sentences max.]',
	].join(' '),
		instructions: [
			'You are Bodhi, a voice-powered coding assistant backed by Claude Code.',
			'Claude has full access to the local project codebase. It can read, edit, create,',
			'and delete files, run shell commands, search code, and send emails via Apple Mail.',
			'',
			'TOOL ROUTING:',
			'- Google Search: Use for quick factual lookups — weather, news, documentation,',
			'  "who is X", "what is Y". Gemini handles this natively (no tool call needed).',
			'- generate_image: When the user asks for any picture, image, card, or illustration.',
			'- get_current_time: For the current date/time.',
			'- get_claude_task_status: For progress/status questions about an ongoing Claude task.',
			'  If it reports inProgress=true, tell the user Claude is still working and',
			'  do NOT start a new ask_claude task just to check progress.',
			'- ask_claude: For ALL coding tasks — editing files, fixing bugs, refactoring,',
			'  debugging, code review, adding features, running tests, reading code,',
			'  explaining code, creating new files, searching the codebase.',
			'  Also for sending emails — Claude can send email via Apple Mail.',
			'  When in doubt about whether something is a coding task, route to Claude.',
			`  Continuity contract: use threadKey "${CLAUDE_DEFAULT_THREAD_KEY}" for follow-ups on`,
			'  the same coding task with continuityMode "resume_if_available".',
			'  For unrelated new coding tasks, use continuityMode "force_fresh" and a new threadKey.',
			'- end_session: When the user says goodbye.',
			'',
			'VOICE RULES:',
		'- Keep responses short and clear (2-3 sentences).',
		'- Do NOT read code aloud — summarize what was done.',
		'- When relaying results from Claude, focus on the outcome: "Claude fixed the bug',
		'  in auth.py by adding null checking" — not the raw diff.',
		'- If Claude asks a follow-up question, relay it naturally to the user.',
			'',
			'IMPORTANT:',
			'- Claude may ask follow-up questions — these will be relayed to the user via voice.',
			'- For image generation, warn the user it may take a moment.',
		].join('\n'),
	tools: [askClaudeTool, getClaudeTaskStatus, getCurrentTime, generateImage, endSession],
	googleSearch: true,
	onEnter: async () => {
		console.log(`${ts()} [Agent] Main agent entered`);
	},
};

// =============================================================================
// Main
// =============================================================================

async function main() {
	// Verify macOS for Apple Mail integration
	assertMacOS();

	// Create Claude coding subagent config with email MCP tool.
	// Uses a factory so each query() gets its own MCP Protocol instance
	// (the SDK's Protocol can only be connected to one transport at a time).
	const claudeSubagent = createClaudeCodeSubagentConfig({
		projectDir: PROJECT_DIR,
		model: 'claude-opus-4-5',
		mcpServerFactory: () => {
			console.log('[MCP Factory] Creating fresh email MCP server');
			return {
				email: createSdkMcpServer({
					name: 'email',
					version: '1.0.0',
					tools: [
						mcpTool(
							'send_email',
							'Send an email via Apple Mail.app on macOS. Requires Mail.app to be configured with at least one account.',
							{
								to: z.array(z.string()).min(1).describe('Recipient email addresses'),
								subject: z.string().min(1).describe('Email subject line'),
								body: z.string().min(1).describe('Email body (plain text)'),
								cc: z.array(z.string()).optional().describe('CC recipients'),
								bcc: z.array(z.string()).optional().describe('BCC recipients'),
								draft_only: z
									.boolean()
									.optional()
									.default(false)
									.describe('If true, create a draft instead of sending'),
							},
							async (args) => {
								console.log('[MCP:send_email] Tool invoked!', { to: args.to, subject: args.subject });
								const result = await sendEmail({
									to: args.to,
									subject: args.subject,
									body: args.body,
									cc: args.cc,
									bcc: args.bcc,
									draftOnly: args.draft_only,
								});
								if (!result.success) {
									return {
										content: [{ type: 'text' as const, text: `Failed to send email: ${result.error}` }],
									};
								}
								const action = result.action === 'sent' ? 'Email sent' : 'Draft created';
								return {
									content: [{ type: 'text' as const, text: `${action}. Recipients: ${args.to.join(', ')}` }],
								};
							},
						),
					],
				}),
			};
		},
		extraAllowedTools: ['mcp__email__*'],
	});
	console.log(`${ts()} Claude coding subagent configured (project: ${PROJECT_DIR})`);

	// Start voice session
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: GEMINI_API_KEY,
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.5-flash'),
		subagentConfigs: {
			ask_claude: claudeSubagent,
			generate_image: imageSubagent,
		},
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		sttProvider: new GeminiBatchSTTProvider({
			apiKey: GEMINI_API_KEY,
			model: 'gemini-3-flash-preview',
		}),
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
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Start
	await session.start();

	console.log('============================================================');
	console.log('Bodhi + Claude Code — Voice-Driven Coding Assistant');
	console.log('============================================================');
	console.log();
	console.log(`  Voice agent:     ws://localhost:${PORT}`);
	console.log(`  Project dir:     ${PROJECT_DIR}`);
	console.log(`  Session ID:      ${SESSION_ID}`);
	console.log();
	console.log('Start the web client in another terminal:');
	console.log('  pnpm tsx examples/openclaw/web-client.ts');
	console.log();
	console.log('Then open http://localhost:8080 and try saying:');
	console.log("  - 'Fix the bug in auth.py'                 (Claude Code)");
	console.log("  - 'Now add tests for that fix'             (same thread resume)");
	console.log("  - 'Add input validation to the login form' (Claude Code)");
	console.log("  - 'Run the tests and fix any failures'     (Claude Code)");
	console.log("  - 'Email me a summary of the README'       (Email via Mail.app)");
	console.log("  - 'What is the weather in San Francisco?'  (Google Search)");
	console.log("  - 'Draw me a picture of a sunset'          (Image generation)");
	console.log("  - 'Goodbye'");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
