// SPDX-License-Identifier: MIT

import { z } from 'zod';
import type { BehaviorCategory } from '../types/behavior.js';
import type { ToolDefinition } from '../types/tool.js';

/**
 * Manages dynamic voice agent behaviors (speech speed, verbosity, etc.)
 * from declarative BehaviorCategory configurations.
 *
 * For each category, auto-generates an inline ToolDefinition so the LLM
 * can switch presets via tool calls. Also supports client-initiated changes
 * (UI buttons) that bypass the LLM entirely.
 */
export class BehaviorManager {
	private readonly categories: BehaviorCategory[];
	private readonly generatedTools: ToolDefinition[];
	private readonly active = new Map<string, string>();
	private readonly setDirective: (
		key: string,
		value: string | null,
		scope?: 'session' | 'agent',
	) => void;
	private readonly sendJsonToClient?: (msg: Record<string, unknown>) => void;
	private readonly onPresetChange?: (key: string, presetName: string) => void;

	constructor(
		categories: BehaviorCategory[],
		setDirective: (key: string, value: string | null, scope?: 'session' | 'agent') => void,
		sendJsonToClient?: (msg: Record<string, unknown>) => void,
		onPresetChange?: (key: string, presetName: string) => void,
	) {
		this.categories = categories;
		this.setDirective = setDirective;
		this.sendJsonToClient = sendJsonToClient;
		this.onPresetChange = onPresetChange;

		// Initialize active presets to defaults (first preset in each category)
		for (const cat of categories) {
			if (cat.presets.length > 0) {
				this.active.set(cat.key, cat.presets[0].name);
			}
		}

		// Generate tools
		this.generatedTools = categories.map((cat) => this.buildTool(cat));
	}

	/** Auto-generated tools to append to agent tool lists. */
	get tools(): ToolDefinition[] {
		return this.generatedTools;
	}

	/** Current active preset per category. */
	get activePresets(): Map<string, string> {
		return new Map(this.active);
	}

	/** Send full catalog to a newly connected client. */
	sendCatalog(): void {
		this.sendJsonToClient?.({
			type: 'behavior.catalog',
			categories: this.categories.map((cat) => ({
				key: cat.key,
				toolName: cat.toolName,
				presets: cat.presets.map((p) => ({ name: p.name, label: p.label })),
				active: this.active.get(cat.key),
			})),
		});
	}

	/** Handle client-initiated preset change (bypasses LLM). */
	handleClientSet(key: string, preset: string): void {
		this.applyPreset(key, preset);
	}

	/**
	 * Restore a previously active preset (e.g. from persisted memory).
	 * Sets the directive and updates internal state but does NOT notify the client
	 * (the client will receive the correct state via `sendCatalog()` on connect).
	 */
	restorePreset(key: string, presetName: string): boolean {
		const category = this.categories.find((c) => c.key === key);
		if (!category) return false;
		const preset = category.presets.find((p) => p.name === presetName);
		if (!preset) return false;

		const scope = category.scope ?? 'session';
		this.setDirective(key, preset.directive, scope);
		this.active.set(key, presetName);
		return true;
	}

	/** Reset all categories to their default preset (first in list). */
	reset(): void {
		for (const cat of this.categories) {
			if (cat.presets.length > 0) {
				this.applyPreset(cat.key, cat.presets[0].name);
			}
		}
	}

	/** Apply a preset: set directive, update state, notify client, fire callback. */
	private applyPreset(key: string, presetName: string): void {
		const category = this.categories.find((c) => c.key === key);
		if (!category) return;

		const preset = category.presets.find((p) => p.name === presetName);
		if (!preset) return;

		const scope = category.scope ?? 'session';
		this.setDirective(key, preset.directive, scope);
		this.active.set(key, presetName);

		this.sendJsonToClient?.({
			type: 'behavior.changed',
			key,
			preset: presetName,
		});

		this.onPresetChange?.(key, presetName);
	}

	/** Build a ToolDefinition for a single BehaviorCategory. */
	private buildTool(category: BehaviorCategory): ToolDefinition {
		const presetNames = category.presets.map((p) => p.name);
		const enumSchema = z.enum(presetNames as [string, ...string[]]);

		return {
			name: category.toolName,
			description: category.toolDescription,
			parameters: z.object({ preset: enumSchema }),
			execution: 'inline',
			execute: async (args) => {
				const { preset } = args as { preset: string };
				this.applyPreset(category.key, preset);
				return { key: category.key, preset, status: 'applied' };
			},
		};
	}
}
