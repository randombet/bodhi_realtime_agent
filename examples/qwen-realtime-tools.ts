/**
 * Bodhi — Qwen Omni Realtime with function tools (Alibaba DashScope).
 *
 * Demonstrates tool calling on QwenRealtimeTransport. Phase 0 confirmed Qwen's
 * realtime tool protocol is OpenAI-identical (streamed function_call args +
 * function_call_output round-trip), so the framework's ToolCallRouter works
 * unchanged. Two inline tools (no external services): current time + calculator.
 *
 * Usage:
 *   1. Set QWEN_API_KEY (or DASHSCOPE_API_KEY). GEMINI_API_KEY optional (subagents only).
 *   2. Run: pnpm tsx examples/qwen-realtime-tools.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900 and try:
 *        "What time is it?"
 *        "What is 25 times 17?"
 */

import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { VoiceSession } from '../src/core/voice-session.js';
import { QwenRealtimeTransport } from '../src/transport/qwen-realtime-transport.js';
import type { MainAgent } from '../src/types/agent.js';
import type { ToolDefinition } from '../src/types/tool.js';

const QWEN_API_KEY = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
if (!QWEN_API_KEY) {
	console.error('Error: QWEN_API_KEY (or DASHSCOPE_API_KEY) is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const ts = () => new Date().toISOString().slice(11, 23);

const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get the current date and time.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async () => {
		const now = new Date();
		return { iso: now.toISOString(), human: now.toLocaleString() };
	},
};

const calculate: ToolDefinition = {
	name: 'calculate',
	description: 'Evaluate a basic arithmetic expression (add, subtract, multiply, divide).',
	parameters: z.object({
		a: z.number(),
		op: z.enum(['add', 'subtract', 'multiply', 'divide']),
		b: z.number(),
	}),
	execution: 'inline',
	execute: async (args) => {
		const { a, op, b } = args as { a: number; op: string; b: number };
		const result =
			op === 'add' ? a + b : op === 'subtract' ? a - b : op === 'multiply' ? a * b : b === 0 ? null : a / b;
		return { result };
	},
};

const transport = new QwenRealtimeTransport({
	apiKey: QWEN_API_KEY,
	model: 'qwen3.5-omni-plus-realtime',
	...(process.env.QWEN_VOICE ? { voice: process.env.QWEN_VOICE } : {}),
	turnDetection: { type: 'server_vad' },
});

const mainAgent: MainAgent = {
	name: 'main',
	tools: [getCurrentTime, calculate],
	greeting:
		'[System: A user just connected. Greet them in one short sentence as Bodhi, and mention you can tell the time and do math.]',
	instructions: `You are Bodhi, a concise voice assistant with tools.
- Use get_current_time when asked about the time or date.
- Use calculate for arithmetic.
- Keep replies to one or two sentences. Confirm the result plainly.`,
};

async function main() {
	const session = new VoiceSession({
		sessionId: `qwen_tools_${Date.now()}`,
		userId: 'demo_user',
		apiKey: process.env.GEMINI_API_KEY ?? '',
		model: google('gemini-2.5-flash'),
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		transport,
		hooks: {
			onSessionStart: (e) => console.log(`${ts()} [Session] started ${e.sessionId}`),
			onToolCall: (e) => console.log(`${ts()} [Tool] ${e.toolName} (${e.execution})`),
			onToolResult: (e) => console.log(`${ts()} [Tool] result ${e.toolCallId} (${e.status})`),
			onError: (e) => console.error(`${ts()} [Error] ${e.component}: ${e.error.message}`),
		},
	});

	await session.start();
	console.log(`${ts()} Qwen tools session listening on ws://${HOST}:${PORT}`);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
