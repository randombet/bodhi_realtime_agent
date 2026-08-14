// SPDX-License-Identifier: MIT

/**
 * Realtime voice + STT model name constants for the persisted agent definition.
 * Extracted here (from the legacy `app/agents/user-agent-record.ts`) so the
 * `AgentDefinitionV2` schema cluster is dependency-light and reusable from `src/`
 * without reaching into `app/`.
 */

/** Allowed Gemini Live prebuilt voice names (all 30 HD presets). */
export const GEMINI_VOICE_NAMES = [
	'Zephyr',
	'Puck',
	'Charon',
	'Kore',
	'Fenrir',
	'Aoede',
	'Orus',
	'Autonoe',
	'Umbriel',
	'Erinome',
	'Laomedeia',
	'Schedar',
	'Achird',
	'Sadachbia',
	'Enceladus',
	'Algieba',
	'Algenib',
	'Achernar',
	'Gacrux',
	'Zubenelgenubi',
	'Sadaltager',
	'Leda',
	'Callirrhoe',
	'Iapetus',
	'Despina',
	'Rasalgethi',
	'Alnilam',
	'Pulcherrima',
	'Vindemiatrix',
	'Sulafat',
] as const;

/** OpenAI Realtime built-in voices (aligned with SDK typing). */
export const OPENAI_REALTIME_VOICES = [
	'alloy',
	'ash',
	'ballad',
	'coral',
	'echo',
	'sage',
	'shimmer',
	'verse',
	'marin',
	'cedar',
] as const;

export const USER_AGENT_STT_MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash'] as const;
