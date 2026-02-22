// SPDX-License-Identifier: MIT

import type { BehaviorCategory } from '../types/behavior.js';

/** Speech speed behavior (slow / normal / fast). */
export function speechSpeed(opts?: { toolDescription?: string }): BehaviorCategory {
	return {
		key: 'pacing',
		toolName: 'set_speech_speed',
		toolDescription:
			opts?.toolDescription ??
			'Change the speech speed. Call this whenever the user asks to speak slower, faster, or at normal speed.',
		presets: [
			{ name: 'normal', label: 'Normal', directive: null },
			{
				name: 'slow',
				label: 'Slow',
				directive:
					'IMPORTANT PACING OVERRIDE: Limit output to approximately 2 words per second. Each sentence must be 8 words or fewer. Insert a pause after every 6-8 words. Never chain clauses — split into separate sentences.',
			},
			{
				name: 'fast',
				label: 'Fast',
				directive:
					'IMPORTANT PACING OVERRIDE: Target approximately 5 words per second. Use dense, compound sentences. Minimize pauses. Prioritize throughput over clarity.',
			},
		],
		scope: 'session',
	};
}

/** Verbosity behavior (brief / normal / detailed). */
export function verbosity(opts?: { toolDescription?: string }): BehaviorCategory {
	return {
		key: 'verbosity',
		toolName: 'set_verbosity',
		toolDescription:
			opts?.toolDescription ??
			'Change response detail level. Call when the user asks for more or less detail.',
		presets: [
			{ name: 'normal', label: 'Normal', directive: null },
			{
				name: 'brief',
				label: 'Brief',
				directive:
					'VERBOSITY OVERRIDE: Give the shortest possible answer. One sentence max. No elaboration unless explicitly asked.',
			},
			{
				name: 'detailed',
				label: 'Detailed',
				directive:
					'VERBOSITY OVERRIDE: Give thorough, detailed explanations. Include examples and context. Multiple paragraphs are fine.',
			},
		],
		scope: 'session',
	};
}

/** Response language behavior — caller provides the language list. */
export function responseLanguage(
	languages: Array<{ name: string; label: string; directive: string }>,
): BehaviorCategory {
	return {
		key: 'language',
		toolName: 'set_response_language',
		toolDescription: 'Change the language you respond in.',
		presets: languages.map((lang) => ({
			name: lang.name,
			label: lang.label,
			directive: lang.directive,
		})),
		scope: 'session',
	};
}
