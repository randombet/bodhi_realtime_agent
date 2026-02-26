// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { BehaviorManager } from '../../src/behaviors/behavior-manager.js';
import { responseLanguage, speechSpeed, verbosity } from '../../src/behaviors/presets.js';
import type { BehaviorCategory } from '../../src/types/behavior.js';

function createTestCategory(): BehaviorCategory {
	return {
		key: 'pacing',
		toolName: 'set_pacing',
		toolDescription: 'Set the speech pacing.',
		presets: [
			{ name: 'normal', label: 'Normal', directive: null },
			{ name: 'slow', label: 'Slow', directive: 'Speak slowly.' },
			{ name: 'fast', label: 'Fast', directive: 'Speak fast.' },
		],
		scope: 'session',
	};
}

describe('BehaviorManager', () => {
	describe('tool generation', () => {
		it('generates one tool per category', () => {
			const mgr = new BehaviorManager([createTestCategory()], vi.fn());
			expect(mgr.tools).toHaveLength(1);
			expect(mgr.tools[0].name).toBe('set_pacing');
			expect(mgr.tools[0].description).toBe('Set the speech pacing.');
			expect(mgr.tools[0].execution).toBe('inline');
		});

		it('validates preset values via Zod schema', () => {
			const mgr = new BehaviorManager([createTestCategory()], vi.fn());
			const tool = mgr.tools[0];
			const valid = tool.parameters.safeParse({ preset: 'slow' });
			expect(valid.success).toBe(true);

			const invalid = tool.parameters.safeParse({ preset: 'invalid' });
			expect(invalid.success).toBe(false);
		});

		it('generates multiple tools for multiple categories', () => {
			const mgr = new BehaviorManager(
				[
					createTestCategory(),
					{
						...createTestCategory(),
						key: 'verbosity',
						toolName: 'set_verbosity',
						toolDescription: 'Set verbosity.',
					},
				],
				vi.fn(),
			);
			expect(mgr.tools).toHaveLength(2);
			expect(mgr.tools[0].name).toBe('set_pacing');
			expect(mgr.tools[1].name).toBe('set_verbosity');
		});
	});

	describe('preset switching', () => {
		it('defaults to the first preset', () => {
			const mgr = new BehaviorManager([createTestCategory()], vi.fn());
			expect(mgr.activePresets.get('pacing')).toBe('normal');
		});

		it('switches preset via tool execute', async () => {
			const setDirective = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective);

			const result = await mgr.tools[0].execute({ preset: 'slow' }, {} as never);
			expect(result).toEqual({ key: 'pacing', preset: 'slow', status: 'applied' });
			expect(mgr.activePresets.get('pacing')).toBe('slow');
			expect(setDirective).toHaveBeenCalledWith('pacing', 'Speak slowly.', 'session');
		});

		it('clears directive when switching to null-directive preset', async () => {
			const setDirective = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective);

			await mgr.tools[0].execute({ preset: 'slow' }, {} as never);
			await mgr.tools[0].execute({ preset: 'normal' }, {} as never);

			expect(setDirective).toHaveBeenLastCalledWith('pacing', null, 'session');
			expect(mgr.activePresets.get('pacing')).toBe('normal');
		});
	});

	describe('client protocol', () => {
		it('sends catalog on sendCatalog()', () => {
			const sendJson = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], vi.fn(), sendJson);

			mgr.sendCatalog();

			expect(sendJson).toHaveBeenCalledWith({
				type: 'behavior.catalog',
				categories: [
					{
						key: 'pacing',
						toolName: 'set_pacing',
						presets: [
							{ name: 'normal', label: 'Normal' },
							{ name: 'slow', label: 'Slow' },
							{ name: 'fast', label: 'Fast' },
						],
						active: 'normal',
					},
				],
			});
		});

		it('sends behavior.changed on preset change', async () => {
			const sendJson = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], vi.fn(), sendJson);

			await mgr.tools[0].execute({ preset: 'fast' }, {} as never);

			expect(sendJson).toHaveBeenCalledWith({
				type: 'behavior.changed',
				key: 'pacing',
				preset: 'fast',
			});
		});

		it('works without sendJsonToClient (optional)', async () => {
			const setDirective = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective);

			// Should not throw
			await mgr.tools[0].execute({ preset: 'slow' }, {} as never);
			mgr.sendCatalog();

			expect(setDirective).toHaveBeenCalledWith('pacing', 'Speak slowly.', 'session');
		});
	});

	describe('client-initiated changes', () => {
		it('applies preset via handleClientSet', () => {
			const setDirective = vi.fn();
			const sendJson = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective, sendJson);

			mgr.handleClientSet('pacing', 'slow');

			expect(setDirective).toHaveBeenCalledWith('pacing', 'Speak slowly.', 'session');
			expect(mgr.activePresets.get('pacing')).toBe('slow');
			expect(sendJson).toHaveBeenCalledWith({
				type: 'behavior.changed',
				key: 'pacing',
				preset: 'slow',
			});
		});

		it('ignores unknown category key', () => {
			const setDirective = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective);

			mgr.handleClientSet('nonexistent', 'slow');
			expect(setDirective).not.toHaveBeenCalled();
		});

		it('ignores unknown preset name', () => {
			const setDirective = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective);

			mgr.handleClientSet('pacing', 'turbo');
			expect(setDirective).not.toHaveBeenCalled();
		});
	});

	describe('reset', () => {
		it('resets all categories to default preset', async () => {
			const setDirective = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective);

			await mgr.tools[0].execute({ preset: 'slow' }, {} as never);
			expect(mgr.activePresets.get('pacing')).toBe('slow');

			mgr.reset();
			expect(mgr.activePresets.get('pacing')).toBe('normal');
			expect(setDirective).toHaveBeenLastCalledWith('pacing', null, 'session');
		});
	});

	describe('restorePreset', () => {
		it('restores a known preset without notifying client', () => {
			const setDirective = vi.fn();
			const sendJson = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], setDirective, sendJson);

			const result = mgr.restorePreset('pacing', 'slow');
			expect(result).toBe(true);
			expect(mgr.activePresets.get('pacing')).toBe('slow');
			expect(setDirective).toHaveBeenCalledWith('pacing', 'Speak slowly.', 'session');
			expect(sendJson).not.toHaveBeenCalled();
		});

		it('returns false for unknown category', () => {
			const mgr = new BehaviorManager([createTestCategory()], vi.fn());
			expect(mgr.restorePreset('nonexistent', 'slow')).toBe(false);
		});

		it('returns false for unknown preset', () => {
			const mgr = new BehaviorManager([createTestCategory()], vi.fn());
			expect(mgr.restorePreset('pacing', 'turbo')).toBe(false);
		});
	});

	describe('onPresetChange callback', () => {
		it('fires on tool-initiated preset change', async () => {
			const onPresetChange = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], vi.fn(), undefined, onPresetChange);

			await mgr.tools[0].execute({ preset: 'slow' }, {} as never);
			expect(onPresetChange).toHaveBeenCalledWith('pacing', 'slow');
		});

		it('fires on client-initiated preset change', () => {
			const onPresetChange = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], vi.fn(), undefined, onPresetChange);

			mgr.handleClientSet('pacing', 'fast');
			expect(onPresetChange).toHaveBeenCalledWith('pacing', 'fast');
		});

		it('does NOT fire on restorePreset (avoids write loop)', () => {
			const onPresetChange = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], vi.fn(), undefined, onPresetChange);

			mgr.restorePreset('pacing', 'slow');
			expect(onPresetChange).not.toHaveBeenCalled();
		});

		it('fires on reset', () => {
			const onPresetChange = vi.fn();
			const mgr = new BehaviorManager([createTestCategory()], vi.fn(), undefined, onPresetChange);

			mgr.reset();
			expect(onPresetChange).toHaveBeenCalledWith('pacing', 'normal');
		});
	});

	describe('scope', () => {
		it('uses agent scope when category declares it', async () => {
			const setDirective = vi.fn();
			const cat: BehaviorCategory = {
				...createTestCategory(),
				scope: 'agent',
			};
			const mgr = new BehaviorManager([cat], setDirective);

			await mgr.tools[0].execute({ preset: 'slow' }, {} as never);
			expect(setDirective).toHaveBeenCalledWith('pacing', 'Speak slowly.', 'agent');
		});

		it('defaults to session scope', async () => {
			const setDirective = vi.fn();
			const cat: BehaviorCategory = {
				...createTestCategory(),
				scope: undefined,
			};
			const mgr = new BehaviorManager([cat], setDirective);

			await mgr.tools[0].execute({ preset: 'slow' }, {} as never);
			expect(setDirective).toHaveBeenCalledWith('pacing', 'Speak slowly.', 'session');
		});
	});
});

describe('preset factories', () => {
	describe('speechSpeed', () => {
		it('returns a valid BehaviorCategory', () => {
			const cat = speechSpeed();
			expect(cat.key).toBe('pacing');
			expect(cat.toolName).toBe('set_speech_speed');
			expect(cat.presets).toHaveLength(3);
			expect(cat.presets[0].name).toBe('normal');
			expect(cat.presets[0].directive).toBeNull();
			expect(cat.scope).toBe('session');
		});

		it('accepts custom tool description', () => {
			const cat = speechSpeed({ toolDescription: 'Custom desc' });
			expect(cat.toolDescription).toBe('Custom desc');
		});
	});

	describe('verbosity', () => {
		it('returns a valid BehaviorCategory', () => {
			const cat = verbosity();
			expect(cat.key).toBe('verbosity');
			expect(cat.toolName).toBe('set_verbosity');
			expect(cat.presets).toHaveLength(3);
			expect(cat.presets[0].name).toBe('normal');
		});
	});

	describe('responseLanguage', () => {
		it('returns a valid BehaviorCategory', () => {
			const cat = responseLanguage([
				{ name: 'en', label: 'English', directive: 'Respond in English.' },
				{ name: 'es', label: 'Spanish', directive: 'Respond in Spanish.' },
			]);
			expect(cat.key).toBe('language');
			expect(cat.toolName).toBe('set_response_language');
			expect(cat.presets).toHaveLength(2);
			expect(cat.presets[0].name).toBe('en');
			expect(cat.presets[1].directive).toBe('Respond in Spanish.');
		});
	});
});
