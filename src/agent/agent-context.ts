// SPDX-License-Identifier: MIT

import type { ConversationContext } from '../core/conversation-context.js';
import type { HooksManager } from '../core/hooks.js';
import type { AgentContext, MainAgent } from '../types/agent.js';
import type { ConversationItem } from '../types/conversation.js';
import type { MemoryFact } from '../types/memory.js';

/** Language name map for common BCP 47 tags used in system instruction directives. */
const LANGUAGE_NAMES: Record<string, string> = {
	'en-US': 'English',
	'en-GB': 'English',
	en: 'English',
	'zh-CN': 'Mandarin Chinese (Simplified)',
	'zh-TW': 'Mandarin Chinese (Traditional)',
	zh: 'Mandarin Chinese',
	'es-ES': 'Spanish',
	'es-MX': 'Spanish',
	es: 'Spanish',
	'fr-FR': 'French',
	fr: 'French',
	'de-DE': 'German',
	de: 'German',
	'ja-JP': 'Japanese',
	ja: 'Japanese',
	'ko-KR': 'Korean',
	ko: 'Korean',
	'pt-BR': 'Portuguese',
	pt: 'Portuguese',
	'hi-IN': 'Hindi',
	hi: 'Hindi',
	'ar-SA': 'Arabic',
	ar: 'Arabic',
	'it-IT': 'Italian',
	it: 'Italian',
	'nl-NL': 'Dutch',
	nl: 'Dutch',
	'ru-RU': 'Russian',
	ru: 'Russian',
	'th-TH': 'Thai',
	th: 'Thai',
	'vi-VN': 'Vietnamese',
	vi: 'Vietnamese',
	'id-ID': 'Indonesian',
	id: 'Indonesian',
};

/**
 * Resolve an agent's effective system instruction, including language directive if configured.
 * Evaluates the instruction (static string or factory function) and prepends a language
 * directive when `agent.language` is set.
 */
export function resolveInstructions(agent: MainAgent): string {
	const base = typeof agent.instructions === 'function' ? agent.instructions() : agent.instructions;
	if (!agent.language) return base;

	const langName = LANGUAGE_NAMES[agent.language] ?? agent.language;
	const directive = `You MUST respond in ${langName}. Speak only in ${langName} unless the user explicitly asks you to switch languages.`;
	return `${directive}\n\n${base}`;
}

/**
 * Factory that builds an AgentContext object for agent lifecycle hooks.
 * Wires `injectSystemMessage` and `getRecentTurns` to the live ConversationContext.
 */
export function createAgentContext(options: {
	sessionId: string;
	agentName: string;
	conversationContext: ConversationContext;
	hooks: HooksManager;
	memoryFacts?: MemoryFact[];
	requestTransfer?: (toAgent: string) => void;
	stopBufferingAndDrain?: (handler: (chunk: Buffer) => void) => void;
	sendJsonToClient?: (message: Record<string, unknown>) => void;
	sendAudioToClient?: (data: Buffer) => void;
	setExternalAudioHandler?: (handler: ((data: Buffer) => void) | null) => void;
}): AgentContext {
	return {
		sessionId: options.sessionId,
		agentName: options.agentName,
		injectSystemMessage(text: string): void {
			options.conversationContext.addAssistantMessage(`[system] ${text}`);
		},
		getRecentTurns(count = 10): ConversationItem[] {
			const items = options.conversationContext.items;
			return items.slice(-count) as ConversationItem[];
		},
		getMemoryFacts(): MemoryFact[] {
			return options.memoryFacts ?? [];
		},
		requestTransfer(toAgent: string): void {
			options.requestTransfer?.(toAgent);
		},
		stopBufferingAndDrain(handler: (chunk: Buffer) => void): void {
			options.stopBufferingAndDrain?.(handler);
		},
		sendJsonToClient(message: Record<string, unknown>): void {
			options.sendJsonToClient?.(message);
		},
		sendAudioToClient(data: Buffer): void {
			options.sendAudioToClient?.(data);
		},
		setExternalAudioHandler(handler: ((data: Buffer) => void) | null): void {
			options.setExternalAudioHandler?.(handler);
		},
	};
}
