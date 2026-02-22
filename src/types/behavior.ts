// SPDX-License-Identifier: MIT

/** A single preset within a behavior category. */
export interface BehaviorPreset {
	/** Machine-readable preset name (enum value in tool schema). */
	name: string;
	/** Human-readable label for client UI display. */
	label: string;
	/** Directive text injected into model context. null = clear directive. */
	directive: string | null;
}

/** Declares a tunable behavior with discrete presets. */
export interface BehaviorCategory {
	/** Unique category key — becomes the directive key (e.g. "pacing"). */
	key: string;
	/** Tool name auto-generated for the LLM (e.g. "set_pacing"). */
	toolName: string;
	/** Tool description shown to the LLM for tool selection. */
	toolDescription: string;
	/** Ordered presets. First preset is the default. */
	presets: BehaviorPreset[];
	/** Directive scope. 'session' (default) persists across agent transfers. */
	scope?: 'session' | 'agent';
}
