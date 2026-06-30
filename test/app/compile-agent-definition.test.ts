import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';
import { getBuiltinAgentCompileModel } from '../../app/agents/definitions/builtin-agent-definitions.js';
import { compileAgentDefinition } from '../../app/agents/runtime/compile-agent-definition.js';
import type { WorkerRuntimeContext } from '../../app/agents/runtime/worker-runtime-registry.js';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';

function testWorkerCtx(partial?: Partial<WorkerRuntimeContext>): WorkerRuntimeContext {
	const googleApiKey = partial?.googleApiKey ?? 'k';
	return {
		googleApiKey,
		defaultReasoningModel: createGoogleGenerativeAI({ apiKey: googleApiKey })('gemini-2.5-flash'),
		getSessionRef: () => null,
		artifactRegistry: new ArtifactRegistry(),
		userId: 'u',
		sessionId: 's',
		...partial,
	};
}

describe('compileAgentDefinition', () => {
	it('compiles standard built-in profile with media workers', () => {
		const model = getBuiltinAgentCompileModel('standard');
		expect(model).not.toBeNull();
		if (!model) throw new Error('expected standard builtin model');
		const artifactRegistry = new ArtifactRegistry();
		const out = compileAgentDefinition(model, {
			...testWorkerCtx({ artifactRegistry }),
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
				...testWorkerCtx({ artifactRegistry }),
			}),
		).toThrow(/orphan_worker/);
	});
});
