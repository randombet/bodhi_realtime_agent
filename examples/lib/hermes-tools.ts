import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';
import { z } from 'zod';
import type { SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';

export interface HermesSubagentOptions {
	/** Hermes API base URL without /v1, e.g. http://1.2.3.4:8642. */
	baseUrl: string;
	/** Bearer token from Hermes API_SERVER_KEY. */
	apiKey: string;
	/** Hermes model/profile name. Defaults to hermes-agent. */
	model?: string;
	/** Stable logical conversation id for Hermes server-side state. */
	sessionId: string;
	/** Optional Hermes session key when the gateway is configured to use one. */
	sessionKey?: string;
}

/**
 * Framework ToolDefinition for the main voice agent. Background execution is
 * routed by VoiceSession to the matching Hermes SubagentConfig.
 */
export const askHermesTool: ToolDefinition = {
	name: 'ask_hermes',
	description:
		"Delegate a task to the user's Hermes agent running on their VPS. " +
		'Use this for multi-step work, coding, research, file operations, email/productivity tasks, ' +
		"web browsing, and anything requiring the user's remote Hermes tools or memory. " +
		'Hermes remembers prior delegated tasks within this voice session.',
	parameters: z.object({
		task: z.string().describe('The task to delegate to Hermes'),
	}),
	execution: 'background',
	pendingMessage: "I'm sending that to your Hermes agent now. I'll update you shortly.",
	execute: async () => {
		return { text: 'Routed to Hermes agent', stepCount: 0 };
	},
};

export function createHermesModel(options: HermesSubagentOptions): LanguageModelV1 {
	const headers: Record<string, string> = {
		'X-Hermes-Session-Id': options.sessionId,
	};
	if (options.sessionKey) {
		headers['X-Hermes-Session-Key'] = options.sessionKey;
	}

	const hermes = createOpenAI({
		baseURL: `${options.baseUrl.replace(/\/$/, '')}/v1`,
		apiKey: options.apiKey,
		headers,
	});

	return hermes(options.model ?? 'hermes-agent');
}

export function createHermesSubagentConfig(options: HermesSubagentOptions): SubagentConfig {
	return {
		name: 'hermes',
		interactive: true,
		instructions: [
			"You are a voice-friendly relay to the user's remote Hermes agent by Nous Research.",
			'Hermes is the actual worker agent and may have tools, files, browser access, and memory on the VPS.',
			'',
			'WORKFLOW:',
			'1. Complete the delegated task by using the Hermes-backed model directly.',
			'2. If Hermes needs more information from the user, call ask_user with one concise question, then continue.',
			'3. When Hermes finishes, return a brief spoken summary of the outcome.',
			'',
			'VOICE RULES:',
			'- Keep the final answer short: usually 2-3 sentences.',
			'- Do not read long code, logs, or markdown aloud; summarize what changed or what was found.',
			'- If Hermes reports an error or missing permission, explain it plainly and say what the user should do next.',
		].join('\n'),
		tools: {},
		reasoningModel: createHermesModel(options),
		maxSteps: 6,
		timeout: 300_000,
	};
}
