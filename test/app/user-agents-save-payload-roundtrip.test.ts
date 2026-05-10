// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { AgentDefinitionV2 } from '../../app/agents/agent-definition.js';
import { parseAgentDefinitionV2 } from '../../app/agents/agent-definition.js';
import { parseUserAgentRecord } from '../../app/agents/user-agent-record.js';
import {
	buildAgentDefinitionV2FromSavePayload,
	userAgentWireToSavePayload,
} from '../../app/web-client/src/user-agents-api.js';

const ctx = {
	id: 'ua_dddddddddddddddd',
	userId: 'user_roundtrip',
	createdAt: 10,
	updatedAt: 20,
};

describe('user-agents-api save payload round-trip', () => {
	it('round-trips AgentDefinitionV2 with studio_background_tool workers', () => {
		const v2: AgentDefinitionV2 = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Roundtrip Agent',
			description: 'd',
			realtimeProvider: 'gemini',
			clientMedia: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'You are the main agent.',
					googleSearch: true,
					toolIds: ['end_session', 'my_studio_tool'],
				},
			],
			workers: {
				my_studio_tool: {
					type: 'studio_background_tool',
					description: 'Studio helper',
					parametersSchema: { type: 'object', additionalProperties: true },
					instructions: 'Call studio_run once with Arguments JSON.',
					code: 'return { ok: true };',
					pendingMessage: 'Working…',
				},
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};

		const payload = userAgentWireToSavePayload(v2);
		expect(payload.studioBackgroundTools).toHaveLength(1);
		expect(payload.studioBackgroundTools?.[0]?.toolName).toBe('my_studio_tool');
		expect(payload.enabledToolIds).toContain('my_studio_tool');
		expect(payload.clientMedia).toEqual({ kind: 'direct_rtc', rtcAudio: 'werift_opus' });

		const rebuilt = buildAgentDefinitionV2FromSavePayload(payload, ctx);
		expect(parseAgentDefinitionV2(rebuilt)).not.toBeNull();
		expect(rebuilt.workers.my_studio_tool).toEqual(v2.workers.my_studio_tool);
		expect(rebuilt.mainAgents[0]?.toolIds).toEqual(expect.arrayContaining(['my_studio_tool']));
		expect(rebuilt.clientMedia).toEqual({ kind: 'direct_rtc', rtcAudio: 'werift_opus' });
	});

	it('round-trips reasoning fields on studio_background_tool', () => {
		const v2: AgentDefinitionV2 = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Reasoning agent',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'Main.',
					googleSearch: true,
					toolIds: ['end_session', 'rs_tool'],
				},
			],
			workers: {
				rs_tool: {
					type: 'studio_background_tool',
					description: 'With reasoning',
					parametersSchema: { type: 'object', additionalProperties: true },
					instructions: 'Call studio_run.',
					code: 'return { ok: true };',
					reasoningProvider: 'openai_compatible',
					reasoningModel: 'deepseek-chat',
					reasoningBaseUrl: 'https://api.deepseek.com/v1',
					reasoningApiKeyName: 'OPENAI_API_KEY',
					reasoningHeaders: { 'X-Test': '1' },
				},
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};
		const payload = userAgentWireToSavePayload(v2);
		expect(payload.studioBackgroundTools?.[0]?.reasoningProvider).toBe('openai_compatible');
		expect(payload.studioBackgroundTools?.[0]?.reasoningBaseUrl).toBe(
			'https://api.deepseek.com/v1',
		);
		const rebuilt = buildAgentDefinitionV2FromSavePayload(payload, ctx);
		expect(rebuilt.workers.rs_tool).toEqual(v2.workers.rs_tool);
	});

	it('legacy UserAgentRecord without studio tools maps to v2 and back', () => {
		const raw = {
			id: ctx.id,
			userId: ctx.userId,
			name: 'Legacy',
			description: '',
			greeting: 'Hello',
			systemPrompt: 'Sys',
			enabledToolIds: ['get_current_time', 'end_session'],
			googleSearch: true,
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};
		const record = parseUserAgentRecord(raw);
		expect(record).not.toBeNull();
		if (!record) throw new Error('record');

		const payload = userAgentWireToSavePayload(record);
		expect(payload.studioBackgroundTools ?? []).toEqual([]);

		const def = buildAgentDefinitionV2FromSavePayload(payload, ctx);
		expect(parseAgentDefinitionV2(def)).not.toBeNull();
		const again = userAgentWireToSavePayload(def);
		expect(again.studioBackgroundTools ?? []).toEqual([]);
		expect(again.enabledToolIds).toEqual(payload.enabledToolIds);
	});

	it('migrates legacy studio_ephemeral_subagent v2 workers when converting wire → save payload', () => {
		const customInnerTools = [
			{
				name: 'echo_msg',
				description: 'Echoes a string.',
				parametersSchema: {
					type: 'object',
					properties: { msg: { type: 'string' } },
					required: ['msg'],
				},
				code: 'return { out: String(args.msg) };',
			},
		];
		const v2Raw = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Custom tools agent',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'Main.',
					googleSearch: true,
					toolIds: ['end_session', 'studio_echo'],
				},
			],
			workers: {
				studio_echo: {
					type: 'studio_ephemeral_subagent',
					displayName: 'Echo',
					instructions: 'Use echo_msg.',
					allowedToolIds: [] as string[],
					customInnerTools,
				},
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};

		const payload = userAgentWireToSavePayload(v2Raw as AgentDefinitionV2);
		expect(payload.studioBackgroundTools?.[0]?.toolName).toBe('studio_echo');
		expect(payload.studioBackgroundTools?.[0]?.code).toContain('out: String');

		const rebuilt = buildAgentDefinitionV2FromSavePayload(payload, ctx);
		expect(rebuilt.workers.studio_echo).toMatchObject({
			type: 'studio_background_tool',
			code: customInnerTools[0]?.code,
		});
	});

	it('round-trips remote_persistent_worker via save payload', () => {
		const v2: AgentDefinitionV2 = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Remote agent',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'Delegate coding to ask_remote.',
					googleSearch: true,
					toolIds: ['end_session', 'ask_remote'],
				},
			],
			workers: {
				ask_remote: {
					type: 'remote_persistent_worker',
					url: 'https://worker.example.com',
					token: 'secret-token',
					description: 'Delegate coding tasks to remote worker.',
					pendingMessage: 'Working remotely…',
				},
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};

		const payload = userAgentWireToSavePayload(v2);
		expect(payload.remotePersistentWorkerToolName).toBe('ask_remote');
		expect(payload.remotePersistentWorkerUrl).toBe('https://worker.example.com');
		expect(payload.remotePersistentWorkerToken).toBe('secret-token');
		expect(payload.remotePersistentWorkerDescription).toBe(
			'Delegate coding tasks to remote worker.',
		);
		expect(payload.remotePersistentWorkerPendingMessage).toBe('Working remotely…');

		const rebuilt = buildAgentDefinitionV2FromSavePayload(payload, ctx);
		expect(rebuilt.workers.ask_remote).toEqual({
			type: 'remote_persistent_worker',
			url: 'https://worker.example.com',
			token: 'secret-token',
			description: 'Delegate coding tasks to remote worker.',
			pendingMessage: 'Working remotely…',
		});
		expect(rebuilt.mainAgents[0]?.toolIds).toContain('ask_remote');
	});

	it('round-trips avatarConfig on AgentDefinitionV2', () => {
		const v2: AgentDefinitionV2 = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Avatar agent',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'Main.',
					googleSearch: true,
					toolIds: ['end_session'],
				},
			],
			workers: {},
			avatarConfig: {
				enabled: true,
				providerId: 'spatialreal',
				presetId: 'face-model-uuid-1',
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};

		const payload = userAgentWireToSavePayload(v2);
		expect(payload.avatarConfig?.enabled).toBe(true);
		expect(payload.avatarConfig?.presetId).toBe('face-model-uuid-1');

		const rebuilt = buildAgentDefinitionV2FromSavePayload(payload, ctx);
		expect(rebuilt.avatarConfig).toEqual(v2.avatarConfig);
	});

	it('strips avatarConfig when save payload has avatar disabled', () => {
		const v2: AgentDefinitionV2 = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'No avatar',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'Main.',
					googleSearch: true,
					toolIds: ['end_session'],
				},
			],
			workers: {},
			avatarConfig: {
				enabled: true,
				providerId: 'spatialreal',
				presetId: 'face-model-uuid-1',
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};

		const payload = userAgentWireToSavePayload(v2);
		const disabled = {
			...payload,
			avatarConfig: { enabled: false, providerId: 'spatialreal', presetId: '' },
		};
		const rebuilt = buildAgentDefinitionV2FromSavePayload(disabled, ctx);
		expect(rebuilt.avatarConfig).toBeUndefined();
	});

	it('parseAgentDefinitionV2 accepts avatarConfig with a non-spatial provider id', () => {
		const raw = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Future avatar provider',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'Main.',
					googleSearch: true,
					toolIds: ['end_session'],
				},
			],
			workers: {},
			avatarConfig: {
				enabled: true,
				providerId: 'future_avatar_cloud',
				presetId: 'face-model-uuid-1',
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};
		expect(parseAgentDefinitionV2(raw)?.avatarConfig?.providerId).toBe('future_avatar_cloud');
	});

	it('parseAgentDefinitionV2 rejects enabled avatar with empty presetId', () => {
		const raw = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Bad preset',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'Main.',
					googleSearch: true,
					toolIds: ['end_session'],
				},
			],
			workers: {},
			avatarConfig: {
				enabled: true,
				providerId: 'spatialreal',
				presetId: '',
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};
		expect(parseAgentDefinitionV2(raw)).toBeNull();
	});

	it('round-trips studioTelephony on AgentDefinitionV2 through save payload', () => {
		const v2: AgentDefinitionV2 = {
			schemaVersion: 2,
			id: ctx.id,
			userId: ctx.userId,
			name: 'Tel agent',
			description: '',
			realtimeProvider: 'gemini',
			geminiVoiceName: 'Puck',
			openaiVoice: 'coral',
			geminiSttModel: 'gemini-3-flash-preview',
			mainAgents: [
				{
					name: 'main',
					greeting: 'Hi',
					instructions: 'You are a test agent.',
					googleSearch: true,
					toolIds: ['end_session'],
				},
			],
			workers: {},
			studioTelephony: {
				verifiedCallerIds: [
					{
						sid: 'PNcccccccccccccccccccccccccccccccc',
						phoneNumber: '+14155550199',
						verifiedAt: 100,
					},
				],
				outboundCallerIdPhone: '+14155550199',
			},
			createdAt: ctx.createdAt,
			updatedAt: ctx.updatedAt,
		};
		const payload = userAgentWireToSavePayload(v2);
		expect(payload.studioTelephony?.verifiedCallerIds).toHaveLength(1);
		const rebuilt = buildAgentDefinitionV2FromSavePayload(payload, {
			...ctx,
			updatedAt: ctx.updatedAt + 1,
		});
		expect(rebuilt.studioTelephony?.verifiedCallerIds[0]?.phoneNumber).toBe('+14155550199');
		expect(rebuilt.studioTelephony?.outboundCallerIdPhone).toBe('+14155550199');
		expect(parseAgentDefinitionV2(rebuilt)).not.toBeNull();
	});
});
