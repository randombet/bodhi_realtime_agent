// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import type { ChatEvent, OpenClawClient } from '../../app/lib/integrations/openclaw/openclaw-client.js';
import {
	askGeneralAgentTool,
	askWorkAgentTool,
	createOpenClawSubagentConfig,
	createPersistentOpenClawSubagentConfig,
} from '../../app/lib/openclaw-tools.js';

const TINY_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function createMockClient(events: ChatEvent[]): OpenClawClient {
	let eventIndex = 0;
	let runCounter = 0;

	return {
		sessionKey: vi.fn((_sid: string) => 'bodhi:test'),
		chatSend: vi.fn(async (_sessionKey: string, _message: string) => ({
			runId: `run-${++runCounter}`,
		})),
		nextChatEvent: vi.fn(async (_runId: string) => events[eventIndex++]),
	} as unknown as OpenClawClient;
}

type ToolMap = Record<
	string,
	{
		execute: (args: {
			message: string;
			artifactIds?: string[];
		}) => Promise<Record<string, unknown>>;
	}
>;

describe('openclaw tools', () => {
	it('defines ask_work_agent with background execution and expected parameters', () => {
		expect(askWorkAgentTool.name).toBe('ask_work_agent');
		expect(askWorkAgentTool.execution).toBe('background');
		expect(askWorkAgentTool.pendingMessage).toBeDefined();
		expect(askWorkAgentTool.parameters.safeParse({ task: 'Send an email' }).success).toBe(true);
	});

	it('defines ask_general_agent with background execution and expected parameters', () => {
		expect(askGeneralAgentTool.name).toBe('ask_general_agent');
		expect(askGeneralAgentTool.execution).toBe('background');
		expect(askGeneralAgentTool.pendingMessage).toBeDefined();
		expect(
			askGeneralAgentTool.parameters.safeParse({ task: 'Debug this TypeScript error' }).success,
		).toBe(true);
	});

	it('openclaw_chat preserves delta text when final text is empty', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'delta',
				text: 'Conflict found: Teams sync at 9:30 AM.',
			},
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: '',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const config = createOpenClawSubagentConfig(client, 'session-1');
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({ message: 'Check calendar' });
		expect(result).toEqual({
			status: 'completed',
			text: 'Conflict found: Teams sync at 9:30 AM.',
		});
	});

	it('openclaw_chat returns error when completed with empty response text after retry', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: '',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
			{
				source: 'chat',
				runId: 'run-2',
				state: 'final',
				text: '',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const config = createOpenClawSubagentConfig(client, 'session-1');
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({ message: 'Check calendar' });
		expect(result).toEqual({
			status: 'error',
			error: 'OpenClaw completed with empty response text',
		});
		expect(client.chatSend).toHaveBeenCalledTimes(2);
	});

	it('openclaw_chat retry succeeds when second attempt returns text', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: '',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
			{
				source: 'chat',
				runId: 'run-2',
				state: 'final',
				text: 'Conflict found on retry.',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const config = createOpenClawSubagentConfig(client, 'session-1');
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({ message: 'Check calendar' });
		expect(result).toEqual({
			status: 'completed',
			text: 'Conflict found on retry.',
		});
		expect(client.chatSend).toHaveBeenCalledTimes(2);
	});

	it('maps question-like completed response to needs_input', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: 'What would you like me to send to your email? Please share subject and content.',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const config = createOpenClawSubagentConfig(client, 'session-1');
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({ message: 'Help me send an email.' });
		expect(result).toEqual({
			status: 'needs_input',
			text: 'What would you like me to send to your email? Please share subject and content.',
		});
	});

	it('openclaw_chat without artifactIds sends text-only (regression)', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: 'Done',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const config = createOpenClawSubagentConfig(client, 'session-1');
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({ message: 'Do thing' });
		expect(result.status).toBe('completed');
		// chatSend called with text only (no options object with attachments)
		expect(client.chatSend).toHaveBeenCalledWith('bodhi:test', 'Do thing', undefined);
	});

	it('openclaw_chat resolves artifactIds to attachments in chatSend', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: 'Email sent with image.',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const registry = new ArtifactRegistry();
		const artId = registry.store(TINY_PNG_B64, 'image/png', 'test image', 'generated');

		const config = createOpenClawSubagentConfig(client, 'session-1', {
			artifactRegistry: registry,
		});
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({
			message: 'Email this image',
			artifactIds: [artId],
		});
		expect(result.status).toBe('completed');
		// chatSend should have been called with attachments
		const call = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[2]).toBeDefined();
		expect(call[2].attachments).toHaveLength(1);
		expect(call[2].attachments[0].mimeType).toBe('image/png');
	});

	it('openclaw_chat auto-attaches latest image for image-send intent when artifactIds missing', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: 'Sent.',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const registry = new ArtifactRegistry();
		registry.store(TINY_PNG_B64, 'image/png', 'older image', 'generated');
		const latestId = registry.store(TINY_PNG_B64, 'image/png', 'latest image', 'generated');

		const config = createOpenClawSubagentConfig(client, 'session-1', {
			artifactRegistry: registry,
		});
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({
			message: 'Please email this image to me.',
		});
		expect(result.status).toBe('completed');

		const call = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[2]?.attachments).toHaveLength(1);
		expect(call[2].attachments[0].content).toBe(TINY_PNG_B64);
		// ensure we resolved by latest artifact ID via list order
		const listed = registry.list();
		expect(listed[listed.length - 1]?.id).toBe(latestId);
	});

	it('openclaw_chat returns error when artifactIds present but no registry', async () => {
		const client = createMockClient([]);

		const config = createOpenClawSubagentConfig(client, 'session-1'); // no options
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({
			message: 'Email this',
			artifactIds: ['art_fake'],
		});
		expect(result.status).toBe('error');
		expect(result.error).toMatch(/not configured/i);
	});

	it('openclaw_chat returns error when all artifacts are missing', async () => {
		const client = createMockClient([]);

		const registry = new ArtifactRegistry();
		const config = createOpenClawSubagentConfig(client, 'session-1', {
			artifactRegistry: registry,
		});
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({
			message: 'Email this',
			artifactIds: ['art_nonexistent'],
		});
		expect(result.status).toBe('error');
		expect(result.error).toMatch(/could not attach/i);
	});

	it('openclaw_chat includes attachmentWarning on partial drop', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: 'Sent with 1 image.',
				finalDisposition: 'completed',
				stopReason: 'stop',
			},
		]);

		const registry = new ArtifactRegistry();
		const goodId = registry.store(TINY_PNG_B64, 'image/png', 'good image', 'generated');

		const config = createOpenClawSubagentConfig(client, 'session-1', {
			artifactRegistry: registry,
		});
		const tools = config.tools as ToolMap;

		const result = await tools.openclaw_chat.execute({
			message: 'Email both images',
			artifactIds: [goodId, 'art_missing'],
		});
		expect(result.status).toBe('completed');
		expect(result.attachmentWarning).toMatch(/expired\/missing/);
	});

	it('creates persistent OpenClaw config for actor-runtime path', async () => {
		const client = createMockClient([
			{
				source: 'chat',
				runId: 'run-1',
				state: 'final',
				text: 'Email sent.',
				finalDisposition: 'completed',
			},
		]);

		const config = createPersistentOpenClawSubagentConfig(client, 'session-42');
		expect(config.lifetime).toBe('persistent_session');
		expect(typeof config.persistentFactory).toBe('function');

		const instance = await config.persistentFactory?.('ask_general_agent', config);
		const text = await instance?.invoke('Fallback task', { task: 'Send the summary email' });

		expect(client.sessionKey).toHaveBeenCalledWith('session-42');
		expect(client.chatSend).toHaveBeenCalledWith(
			'bodhi:test',
			'Send the summary email',
			expect.objectContaining({
				idempotencyKey: expect.any(String),
			}),
		);
		expect(text).toBe('Email sent.');
	});
});
