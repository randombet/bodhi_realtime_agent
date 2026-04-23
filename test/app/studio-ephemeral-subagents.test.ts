// SPDX-License-Identifier: MIT

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';
import { userAgentRecordToAgentDefinitionV2 } from '../../app/agents/agent-definition-parse.js';
import { compileAgentDefinition } from '../../app/agents/runtime/compile-agent-definition.js';
import type { WorkerRuntimeContext } from '../../app/agents/runtime/worker-runtime-registry.js';
import { parseUserAgentRecord } from '../../app/agents/user-agent-record.js';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';

function testCompileWorkerCtx(partial?: Partial<WorkerRuntimeContext>): WorkerRuntimeContext {
	const googleApiKey = partial?.googleApiKey ?? 'test-key';
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

describe('Studio background tools', () => {
	it('parses legacy UserAgentRecord with studioEphemeralSubagents (migrates to studioBackgroundTools)', () => {
		const raw = {
			id: 'ua_aaaaaaaaaaaaaaaa',
			userId: 'user1',
			name: 'Test',
			description: '',
			greeting: 'Hi',
			systemPrompt: 'You are helpful.',
			enabledToolIds: ['get_current_time', 'end_session', 'my_task'],
			studioEphemeralSubagents: [
				{
					displayName: 'My task',
					toolName: 'my_task',
					instructions: 'Summarize the task.',
					allowedToolIds: ['get_current_time', 'calculate'],
				},
			],
			googleSearch: true,
			createdAt: 1,
			updatedAt: 2,
		};
		const rec = parseUserAgentRecord(raw);
		expect(rec).not.toBeNull();
		expect(rec?.studioBackgroundTools).toHaveLength(1);
		expect(rec?.studioBackgroundTools?.[0]?.toolName).toBe('my_task');
		expect(rec?.studioBackgroundTools?.[0]?.code).toContain('Agent Studio migration');
	});

	it('rejects studio background tool with openai_compatible missing base URL', () => {
		const raw = {
			id: 'ua_cccccccccccccccc',
			userId: 'u',
			name: 'N',
			greeting: 'g',
			systemPrompt: 'sys',
			enabledToolIds: ['end_session', 'bad_tool'],
			studioBackgroundTools: [
				{
					toolName: 'bad_tool',
					description: 'd',
					parametersSchema: { type: 'object', additionalProperties: true },
					instructions: 'i',
					code: 'return {};',
					reasoningProvider: 'openai_compatible',
					reasoningModel: 'm',
				},
			],
			googleSearch: true,
			createdAt: 1,
			updatedAt: 2,
		};
		expect(parseUserAgentRecord(raw)).toBeNull();
	});

	it('parses UserAgentRecord with first-class studioBackgroundTools', () => {
		const raw = {
			id: 'ua_bbbbbbbbbbbbbbbb',
			userId: 'u',
			name: 'N',
			greeting: 'g',
			systemPrompt: 'sys',
			enabledToolIds: ['end_session', 'research_bot'],
			studioBackgroundTools: [
				{
					toolName: 'research_bot',
					description: 'Runs research in the background.',
					parametersSchema: {
						type: 'object',
						properties: { q: { type: 'string' } },
						required: ['q'],
					},
					instructions: 'Call studio_run once with the Arguments JSON.',
					code: 'return { ok: true, q: String(args.q) };',
				},
			],
			googleSearch: true,
			createdAt: 1,
			updatedAt: 2,
		};
		const rec = parseUserAgentRecord(raw);
		expect(rec).not.toBeNull();
		expect(rec?.studioBackgroundTools?.[0]?.toolName).toBe('research_bot');
	});

	it('compiles v2 with studio_background_tool worker', () => {
		const record = parseUserAgentRecord({
			id: 'ua_bbbbbbbbbbbbbbbb',
			userId: 'u',
			name: 'N',
			greeting: 'g',
			systemPrompt: 'sys',
			enabledToolIds: ['end_session', 'research_bot'],
			studioBackgroundTools: [
				{
					toolName: 'research_bot',
					description: 'Research helper',
					parametersSchema: {
						type: 'object',
						properties: { q: { type: 'string' } },
						required: ['q'],
					},
					instructions: 'Use tools to help.',
					code: 'return { echo: String(args.q) };',
				},
			],
			googleSearch: true,
			createdAt: 1,
			updatedAt: 2,
		});
		expect(record).not.toBeNull();
		if (!record) throw new Error('record');
		const v2 = userAgentRecordToAgentDefinitionV2(record);
		expect(v2.workers.research_bot).toMatchObject({
			type: 'studio_background_tool',
			description: 'Research helper',
		});
		const artifactRegistry = new ArtifactRegistry();
		const out = compileAgentDefinition(
			{ mainAgents: v2.mainAgents, workers: v2.workers },
			{
				...testCompileWorkerCtx({ artifactRegistry }),
				isUserAgent: true,
			},
		);
		expect(out.subagentConfigs.research_bot).toBeDefined();
		expect(out.subagentConfigs.research_bot?.name).toBe('studio_bg:research_bot');
		expect(out.subagentConfigs.research_bot?.reasoningModel).toBeDefined();
	});

	it('executes studio_run with user code', async () => {
		const record = parseUserAgentRecord({
			id: 'ua_eeeeeeeeeeeeeeee',
			userId: 'u',
			name: 'N',
			greeting: 'g',
			systemPrompt: 'sys',
			enabledToolIds: ['end_session', 'calc_bg'],
			studioBackgroundTools: [
				{
					toolName: 'calc_bg',
					description: 'Adds two numbers in the background.',
					parametersSchema: {
						type: 'object',
						properties: {
							a: { type: 'number' },
							b: { type: 'number' },
						},
						required: ['a', 'b'],
					},
					instructions: 'Call studio_run with the task arguments.',
					code: 'return { sum: Number(args.a) + Number(args.b) };',
				},
			],
			googleSearch: true,
			createdAt: 1,
			updatedAt: 2,
		});
		expect(record).not.toBeNull();
		if (!record) throw new Error('record');
		const v2 = userAgentRecordToAgentDefinitionV2(record);
		const artifactRegistry = new ArtifactRegistry();
		const out = compileAgentDefinition(
			{ mainAgents: v2.mainAgents, workers: v2.workers },
			{
				...testCompileWorkerCtx({ artifactRegistry }),
				isUserAgent: true,
			},
		);
		const cfg = out.subagentConfigs.calc_bg;
		expect(cfg).toBeDefined();
		const runTool = cfg?.tools?.studio_run as
			| { execute?: (args: unknown, opts: unknown) => Promise<unknown> }
			| undefined;
		expect(runTool?.execute).toBeTypeOf('function');
		if (!runTool?.execute) throw new Error('missing studio_run.execute');
		const result = await runTool.execute(
			{ a: 2, b: 5 },
			{
				toolCallId: 'tc1',
				messages: [],
				abortSignal: new AbortController().signal,
			},
		);
		expect(result).toEqual({ sum: 7 });
	});
});
