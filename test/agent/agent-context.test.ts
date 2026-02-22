// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { resolveInstructions } from '../../src/agent/agent-context.js';
import type { MainAgent } from '../../src/types/agent.js';

function makeAgent(overrides: Partial<MainAgent> = {}): MainAgent {
	return { name: 'test', instructions: 'Base instructions', tools: [], ...overrides };
}

describe('resolveInstructions', () => {
	it('returns base instructions when no language is set', () => {
		const result = resolveInstructions(makeAgent());
		expect(result).toBe('Base instructions');
	});

	it('prepends language directive for known language tag', () => {
		const result = resolveInstructions(makeAgent({ language: 'zh-CN' }));
		expect(result).toContain('You MUST respond in Mandarin Chinese (Simplified)');
		expect(result).toContain('Base instructions');
	});

	it('prepends language directive for Spanish', () => {
		const result = resolveInstructions(makeAgent({ language: 'es-ES' }));
		expect(result).toContain('You MUST respond in Spanish');
		expect(result).toContain('Speak only in Spanish');
	});

	it('falls back to raw tag for unknown language codes', () => {
		const result = resolveInstructions(makeAgent({ language: 'sw-KE' }));
		expect(result).toContain('You MUST respond in sw-KE');
	});

	it('handles function-based instructions', () => {
		const result = resolveInstructions(
			makeAgent({ instructions: () => 'Dynamic instructions', language: 'ja-JP' }),
		);
		expect(result).toContain('You MUST respond in Japanese');
		expect(result).toContain('Dynamic instructions');
	});

	it('returns plain instructions for function without language', () => {
		const result = resolveInstructions(makeAgent({ instructions: () => 'Dynamic' }));
		expect(result).toBe('Dynamic');
	});
});
