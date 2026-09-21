// SPDX-License-Identifier: MIT

/**
 * Background Subagent Test — Non-Blocking Tool Demo
 *
 * A lightweight example that demonstrates background (non-blocking) tools
 * using sleep() delays instead of real API calls. Use this to test the
 * subagent queuing and notification flow without burning video/image quotas.
 *
 * Features demonstrated:
 *   1. Background tool with pendingMessage  — Gemini keeps talking while task runs
 *   2. Notification queuing                 — completion spoken after current turn
 *   3. Multiple concurrent background tools — fan-out, independent completion
 *   4. Error handling                       — graceful failure notification
 *
 * Usage:
 *   GEMINI_API_KEY=your_key pnpm tsx examples/hello_world/agent-background-test.ts
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { tool } from 'ai';
import { z } from 'zod';
import { VoiceSession } from '../../src/index.js';
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
// Background tools (sleep-based stubs)
// ---------------------------------------------------------------------------

/**
 * Simulates a slow task (e.g. image/video generation) that takes N seconds.
 * Gemini keeps talking while the subagent sleeps in the background.
 */
const slowTask: ToolDefinition = {
	name: 'slow_task',
	description: `Run a slow background task that takes several seconds to complete.
Call this when the user says "run a slow task", "start a background task", or "test background".
The user can keep talking while it runs.`,
	parameters: z.object({
		label: z.string().describe('Short label for this task'),
		seconds: z
			.number()
			.min(1)
			.max(60)
			.describe('How many seconds the task should take (1-60)'),
	}),
	execution: 'background',
	pendingMessage:
		"I've started your background task. You can keep chatting — I'll let you know when it's done.",
	execute: async () => ({}),
};

/**
 * Simulates a task that always fails after a delay.
 * Tests the error notification path.
 */
const failingTask: ToolDefinition = {
	name: 'failing_task',
	description: `Run a background task that will fail after a few seconds.
Call this when the user says "run a failing task" or "test error handling".`,
	parameters: z.object({
		label: z.string().describe('Short label for this task'),
	}),
	execution: 'background',
	pendingMessage:
		"I've started the task. Heads up — this one is designed to fail so we can test error handling.",
	execute: async () => ({}),
};

// ---------------------------------------------------------------------------
// Subagent configs (actual sleep logic lives here)
// ---------------------------------------------------------------------------

const slowTaskSubagent: SubagentConfig = {
	name: 'slow_task_runner',
	instructions:
		'You run slow tasks. Call the do_slow_work tool with the label and duration from the task arguments. Return a summary when done.',
	tools: {
		do_slow_work: tool({
			description: 'Simulate a slow operation by sleeping for the specified duration.',
			parameters: z.object({
				label: z.string().describe('Task label'),
				seconds: z.number().describe('Sleep duration in seconds'),
			}),
			execute: async ({ label, seconds }) => {
				console.log(`${ts()} [Subagent] Starting "${label}" (${seconds}s sleep)...`);
				await new Promise((r) => setTimeout(r, seconds * 1000));
				console.log(`${ts()} [Subagent] Finished "${label}"`);
				return {
					status: 'success',
					description: `Task "${label}" completed after ${seconds} seconds`,
				};
			},
		}),
	},
	maxSteps: 3,
	timeout: 120_000,
};

const failingTaskSubagent: SubagentConfig = {
	name: 'failing_task_runner',
	instructions:
		'You run tasks that fail. Call the do_failing_work tool with the label from the task arguments.',
	tools: {
		do_failing_work: tool({
			description: 'Simulate a task that fails after a short delay.',
			parameters: z.object({
				label: z.string().describe('Task label'),
			}),
			execute: async ({ label }) => {
				console.log(`${ts()} [Subagent] Starting failing task "${label}"...`);
				await new Promise((r) => setTimeout(r, 3000));
				console.log(`${ts()} [Subagent] Failing task "${label}" — throwing error`);
				throw new Error(`Simulated failure for task "${label}"`);
			},
		}),
	},
	maxSteps: 3,
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const mainAgent: MainAgent = {
	name: 'main',
	greeting: `[System: Greet the user. Introduce yourself as Bodhi Test Bot. Explain you're set up to test background tasks. Mention they can:
- Say "run a 10 second task" to test background processing
- Say "run a failing task" to test error handling
- Keep chatting while tasks run in the background
- Run multiple tasks at once
Keep it brief.]`,
	instructions: `You are a test assistant named Bodhi Test Bot. Keep responses concise — this is voice.

MANDATORY TOOL RULES:
1. When the user asks to run a slow/background task, IMMEDIATELY call slow_task. Pick a reasonable duration (5-15 seconds) if they don't specify one. Use their description as the label.
2. When the user asks to run a failing task or test errors, IMMEDIATELY call failing_task.
3. You can run multiple background tasks — each will complete independently.
4. While tasks are running, chat normally with the user about anything.
5. When a task completes, you'll get a notification — tell the user naturally.
6. NEVER claim a task is done without receiving the completion notification.`,
	tools: [slowTask, failingTask],
	googleSearch: true,
	onEnter: async () => console.log(`${ts()} [Agent] main entered`),
};

// ---------------------------------------------------------------------------
// Start session
// ---------------------------------------------------------------------------

async function main() {
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: createGoogleGenerativeAI({ apiKey: API_KEY })('gemini-2.5-flash'),
		geminiModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-2.5-flash' }),
		speechConfig: { voiceName: 'Puck' },
		subagentConfigs: {
			slow_task: slowTaskSubagent,
			failing_task: failingTaskSubagent,
		},
		hooks: {
			onToolCall: (e) => console.log(`${ts()} [Hook] ${e.toolName} (${e.execution})`),
			onError: (e) =>
				console.error(`${ts()} [Error] ${e.component}: ${e.error.message}`),
		},
	});

	process.on('SIGINT', async () => {
		await session.close('user_hangup');
		process.exit(0);
	});

	await session.start();

	console.log(`\n  Bodhi — Background Subagent Test`);
	console.log(`  ws://localhost:${PORT}\n`);
	console.log('  Try saying:');
	console.log("    'Run a 10 second task'        → background tool with sleep");
	console.log("    'Run a failing task'           → error handling path");
	console.log("    'Run two tasks at once'        → concurrent background tools");
	console.log("    (keep chatting while tasks run — test the queuing!)");
	console.log('\n  Press Ctrl+C to stop.\n');
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
