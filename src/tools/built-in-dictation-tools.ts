import { z } from 'zod';
import type { VoiceSession } from '../core/voice-session.js';
import type { ToolDefinition } from '../types/tool.js';

/**
 * Built-in tools that operate on the dictation buffer maintained by
 * `VoiceSession` when transcription mode is in use.
 *
 * These tools are **opt-in** — apps register them on the relevant agent's
 * tools list. They give the model a user-driven path to inject dictated
 * text into the conversation; the framework never auto-injects.
 *
 * Typical wiring:
 *
 *   const session = new VoiceSession({ … whisperProvider: … });
 *   const agent = {
 *     name: 'main',
 *     instructions: '…',
 *     tools: [
 *       injectDictationTool(session),
 *       discardDictationTool(session),
 *       readDictationBufferTool(session),
 *       …
 *     ],
 *   };
 *
 * Each factory takes the live `VoiceSession` so the tool can read/mutate
 * the buffer at call time without a global registry.
 */

/** Inject the dictation buffer as a user message and clear it. */
export function injectDictationTool(session: VoiceSession): ToolDefinition {
	return {
		name: 'inject_dictation_as_user_message',
		description:
			'Take whatever the user dictated (currently buffered in the framework) and inject it ' +
			'into the conversation as their next user message. Use ONLY when the user explicitly ' +
			'asks to "send", "submit", "use that", or similar after a dictation session. Has no ' +
			'effect if the dictation buffer is empty or the session is not in agent mode.',
		parameters: z.object({}),
		execution: 'inline',
		async execute(): Promise<{ injected: string }> {
			const text = session.getDictationBuffer();
			if (!text) return { injected: '' };
			await session.injectDictationBuffer();
			return { injected: text };
		},
	};
}

/** Discard the dictation buffer with no injection. */
export function discardDictationTool(session: VoiceSession): ToolDefinition {
	return {
		name: 'discard_dictation',
		description:
			"Throw away the user's buffered dictation without sending it to the agent. " +
			'Use when the user says "scratch that", "never mind", or otherwise asks to discard ' +
			'their dictation.',
		parameters: z.object({}),
		execution: 'inline',
		async execute(): Promise<{ discardedChars: number }> {
			const text = session.getDictationBuffer();
			session.clearDictationBuffer();
			return { discardedChars: text.length };
		},
	};
}

/** Return the current dictation buffer as a tool result so the agent can
 *  quote or summarise before deciding whether to inject. */
export function readDictationBufferTool(session: VoiceSession): ToolDefinition {
	return {
		name: 'read_dictation_buffer',
		description:
			"Return the user's currently buffered dictation text as a tool result so the " +
			'agent can quote, summarise, or confirm with the user before calling ' +
			'`inject_dictation_as_user_message`.',
		parameters: z.object({}),
		execution: 'inline',
		async execute(): Promise<{ text: string; isEmpty: boolean }> {
			const text = session.getDictationBuffer();
			return { text, isEmpty: text === '' };
		},
	};
}
