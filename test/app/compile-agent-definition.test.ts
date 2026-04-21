// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { getBuiltinAgentCompileModel } from '../../app/agents/definitions/builtin-agent-definitions.js';
import { compileAgentDefinition } from '../../app/agents/runtime/compile-agent-definition.js';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';

describe('compileAgentDefinition', () => {
	it('compiles standard built-in profile with media workers', () => {
		const model = getBuiltinAgentCompileModel('standard');
		expect(model).not.toBeNull();
		if (!model) throw new Error('expected standard builtin model');
		const artifactRegistry = new ArtifactRegistry();
		const out = compileAgentDefinition(model, {
			apiKey: 'k',
			getSessionRef: () => null,
			artifactRegistry,
			userId: 'u',
			sessionId: 's',
			isUserAgent: false,
		});
		expect(out.mainAgents.map((a) => a.name)).toEqual(['main', 'math_expert']);
		expect(Object.keys(out.subagentConfigs).sort()).toEqual(
			['generate_image', 'generate_video', 'read_image'].sort(),
		);
	});

	it('rejects worker binding without matching background tool', () => {
		const model = getBuiltinAgentCompileModel('standard');
		expect(model).not.toBeNull();
		if (!model) throw new Error('expected standard builtin model');
		const bad = {
			...model,
			workers: {
				...model.workers,
				orphan_worker: { type: 'bodhi_builtin_subagent', variant: 'read_image' },
			},
		};
		const artifactRegistry = new ArtifactRegistry();
		expect(() =>
			compileAgentDefinition(bad, {
				apiKey: 'k',
				getSessionRef: () => null,
				artifactRegistry,
				userId: 'u',
				sessionId: 's',
			}),
		).toThrow(/orphan_worker/);
	});
});
