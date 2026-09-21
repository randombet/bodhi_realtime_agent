import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';
import { getBuiltinAgentCompileModel } from '../../app/agents/definitions/builtin-agent-definitions.js';
import {
	type AgentCompileModel,
	compileAgentDefinition,
} from '../../app/agents/runtime/compile-agent-definition.js';
import type { WorkerRuntimeContext } from '../../app/agents/runtime/worker-runtime-registry.js';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import { zodToJsonSchema } from '../../src/transport/zod-to-schema.js';

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
				orphan_worker: {
					type: 'bodhi_builtin_subagent' as const,
					variant: 'read_image' as const,
				},
			},
		};
		const artifactRegistry = new ArtifactRegistry();
		expect(() =>
			compileAgentDefinition(bad, {
				...testWorkerCtx({ artifactRegistry }),
			}),
		).toThrow(/orphan_worker/);
	});

	it('preserves Studio JSON Schema validation in Gemini and standard provider declarations', () => {
		const model: AgentCompileModel = {
			mainAgents: [
				{
					name: 'main',
					instructions: 'Use the research tool.',
					toolIds: ['research'],
					googleSearch: false,
				},
			],
			workers: {
				research: {
					type: 'studio_background_tool',
					description: 'Research helper',
					parametersSchema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							mode: { type: 'string', enum: ['short', 'long'] },
							maybe: { type: ['string', 'null'] },
							nothing: { type: 'null' },
							variant: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
						},
						required: ['mode', 'maybe', 'nothing', 'variant'],
					},
					instructions: 'Research the request.',
					code: 'return args;',
				},
			},
		};
		const compiled = compileAgentDefinition(model, testWorkerCtx());
		const tool = compiled.mainAgents[0]?.tools.find((candidate) => candidate.name === 'research');
		expect(tool).toBeDefined();
		if (!tool) throw new Error('expected compiled research tool');

		expect(
			tool.parameters.safeParse({ mode: 'short', maybe: null, nothing: null, variant: 2 }).success,
		).toBe(true);
		expect(
			tool.parameters.safeParse({ mode: 'invalid', maybe: null, nothing: null, variant: 2 })
				.success,
		).toBe(false);

		const gemini = zodToJsonSchema(tool.parameters);
		const geminiProperties = gemini.properties as Record<string, unknown>;
		expect(geminiProperties.mode).toEqual({
			type: 'STRING',
			enum: ['short', 'long'],
		});
		expect(geminiProperties.maybe).toEqual({ type: 'STRING', nullable: true });
		expect(geminiProperties.nothing).toEqual({ type: 'NULL' });
		expect(geminiProperties.variant).toEqual({
			anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }],
		});

		const standard = zodToJsonSchema(tool.parameters, 'standard');
		const standardProperties = standard.properties as Record<string, unknown>;
		expect(standardProperties.maybe).toEqual({
			anyOf: [{ type: 'string' }, { type: 'null' }],
		});
		expect(standard.additionalProperties).toBe(false);
	});
});
