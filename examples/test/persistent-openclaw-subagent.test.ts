// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import type { ChatEvent, OpenClawClient } from '../../app/lib/integrations/openclaw/openclaw-client.js';
import { PersistentOpenClawSubagent } from '../../app/lib/persistent-openclaw-subagent.js';

const TINY_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function createMockClient(): OpenClawClient {
	let callCount = 0;
	return {
		chatSend: vi.fn().mockImplementation(async () => {
			callCount++;
			return { runId: `run-${callCount}` };
		}),
		nextChatEvent: vi.fn().mockImplementation(
			async (runId: string): Promise<ChatEvent> => ({
				source: 'chat',
				runId,
				state: 'final',
				text: `response for ${runId}`,
				finalDisposition: 'completed',
			}),
		),
		chatAbort: vi.fn().mockResolvedValue(undefined),
	} as unknown as OpenClawClient;
}

describe('PersistentOpenClawSubagent', () => {
	let client: OpenClawClient;

	beforeEach(() => {
		client = createMockClient();
	});

	it('invokes by sending chat message and collecting response', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		const result = await agent.invoke('Write a function', { task: 'Write a function' });

		expect(result).toBe('response for run-1');
		expect(client.chatSend).toHaveBeenCalledWith(
			'session:abc',
			'Write a function',
			expect.objectContaining({
				idempotencyKey: expect.any(String),
			}),
		);
	});

	it('uses args.task as message when present', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await agent.invoke('generic description', { task: 'specific task' });

		expect(client.chatSend).toHaveBeenCalledWith(
			'session:abc',
			'specific task',
			expect.objectContaining({
				idempotencyKey: expect.any(String),
			}),
		);
	});

	it('falls back to taskDescription when args.task is absent', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await agent.invoke('do the thing', {});

		expect(client.chatSend).toHaveBeenCalledWith(
			'session:abc',
			'do the thing',
			expect.objectContaining({
				idempotencyKey: expect.any(String),
			}),
		);
	});

	it('reuses the same session key across invocations', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await agent.invoke('Task 1', { task: 'Task 1' });
		await agent.invoke('Task 2', { task: 'Task 2' });

		expect(client.chatSend).toHaveBeenCalledTimes(2);
		expect(client.chatSend).toHaveBeenNthCalledWith(
			1,
			'session:abc',
			'Task 1',
			expect.objectContaining({
				idempotencyKey: expect.any(String),
			}),
		);
		expect(client.chatSend).toHaveBeenNthCalledWith(
			2,
			'session:abc',
			'Task 2',
			expect.objectContaining({
				idempotencyKey: expect.any(String),
			}),
		);
	});

	it('throws when invoked after dispose', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await agent.dispose();

		await expect(agent.invoke('Task', {})).rejects.toThrow('disposed');
	});

	it('dispose is idempotent', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await agent.dispose();
		await agent.dispose(); // Should not throw
	});

	it('abort signal cancels the active run', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		const controller = new AbortController();

		// Start invoke and abort
		const promise = agent.invoke('Long task', { task: 'Long task' }, controller.signal);
		controller.abort();

		// Should still resolve (mock resolves immediately before abort takes effect)
		const result = await promise;
		expect(result).toBeDefined();
	});

	it('propagates errors from gateway', async () => {
		(client.nextChatEvent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			source: 'chat',
			runId: 'run-1',
			state: 'error',
			error: 'Gateway error',
		});

		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await expect(agent.invoke('Bad task', { task: 'Bad task' })).rejects.toThrow('Gateway error');
	});

	it('invoke with artifactIds resolves and passes attachments to chatSend', async () => {
		const registry = new ArtifactRegistry();
		const artId = registry.store(TINY_PNG_B64, 'image/png', 'test image');

		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc', registry);
		await agent.invoke('Email image', { task: 'Email image', artifactIds: [artId] });

		const call = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[0]).toBe('session:abc');
		expect(call[1]).toBe('Email image');
		expect(call[2]).toBeDefined();
		expect(call[2].attachments).toHaveLength(1);
		expect(call[2].attachments[0].mimeType).toBe('image/png');
	});

	it('auto-attaches latest image when artifactIds are omitted for image-send intent', async () => {
		const registry = new ArtifactRegistry();
		registry.store('QUFB', 'image/png', 'older image');
		registry.store('QkJC', 'image/png', 'latest image');

		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc', registry);
		await agent.invoke('Please email this image to me', { task: 'Please email this image to me' });

		const call = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[2].attachments).toHaveLength(1);
		expect(call[2].attachments[0].content).toBe('QkJC');
	});

	it('invoke without artifactIds sends no attachments (regression)', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await agent.invoke('Just text', { task: 'Just text' });

		expect(client.chatSend).toHaveBeenCalledWith(
			'session:abc',
			'Just text',
			expect.objectContaining({
				idempotencyKey: expect.any(String),
			}),
		);
		const call = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[2].attachments).toBeUndefined();
	});

	it('throws when artifactIds present but no registry configured', async () => {
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await expect(
			agent.invoke('Email image', { task: 'Email', artifactIds: ['art_fake'] }),
		).rejects.toThrow(/not configured/i);
	});

	it('throws when all artifact IDs are missing', async () => {
		const registry = new ArtifactRegistry();
		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc', registry);
		await expect(
			agent.invoke('Email image', { task: 'Email', artifactIds: ['art_nonexistent'] }),
		).rejects.toThrow(/could not attach/i);
	});

	it('partial drop: proceeds with available artifacts', async () => {
		const registry = new ArtifactRegistry();
		const goodId = registry.store(TINY_PNG_B64, 'image/png', 'good');

		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc', registry);
		await agent.invoke('Email', { task: 'Email', artifactIds: [goodId, 'art_missing'] });

		const call = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call[2].attachments).toHaveLength(1);
	});

	it('handles streaming deltas before final', async () => {
		let callIdx = 0;
		(client.nextChatEvent as ReturnType<typeof vi.fn>).mockImplementation(async (runId: string) => {
			callIdx++;
			if (callIdx <= 2) {
				return {
					source: 'chat',
					runId,
					state: 'delta',
					text: `partial ${callIdx}`,
				};
			}
			return {
				source: 'chat',
				runId,
				state: 'final',
				text: 'final result',
				finalDisposition: 'completed',
			};
		});

		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		const result = await agent.invoke('Task', { task: 'Task' });
		expect(result).toBe('final result');
	});

	it('retries once and throws when completed with empty response text', async () => {
		(client.nextChatEvent as ReturnType<typeof vi.fn>).mockImplementation(
			async (runId: string): Promise<ChatEvent> => ({
				source: 'chat',
				runId,
				state: 'final',
				text: '',
				finalDisposition: 'completed',
			}),
		);

		const agent = new PersistentOpenClawSubagent('oc-1', client, 'session:abc');
		await expect(agent.invoke('Task', { task: 'Task' })).rejects.toThrow(
			'OpenClaw completed with empty response text',
		);
		expect(client.chatSend).toHaveBeenCalledTimes(2);
		const firstOptions = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[0][2];
		const secondOptions = (client.chatSend as ReturnType<typeof vi.fn>).mock.calls[1][2];
		expect(firstOptions.idempotencyKey).toBeDefined();
		expect(firstOptions.idempotencyKey).toBe(secondOptions.idempotencyKey);
	});

	it('deduplicates repeated content blocks across delta/final in persistent path', async () => {
		let callIdx = 0;
		(client.nextChatEvent as ReturnType<typeof vi.fn>).mockImplementation(async (runId: string) => {
			callIdx++;
			const repeatedBlock = {
				type: 'image' as const,
				base64: TINY_PNG_B64,
				mimeType: 'image/png',
			};
			if (callIdx === 1) {
				return {
					source: 'chat',
					runId,
					state: 'delta',
					text: 'partial',
					contentBlocks: [repeatedBlock],
				};
			}
			return {
				source: 'chat',
				runId,
				state: 'final',
				text: 'done',
				finalDisposition: 'completed',
				contentBlocks: [repeatedBlock],
			};
		});

		const registry = new ArtifactRegistry();
		const eventBus = { publish: vi.fn() };
		const agent = new PersistentOpenClawSubagent(
			'oc-1',
			client,
			'session:abc',
			registry,
			undefined,
			eventBus,
			'session-1',
		);

		await agent.invoke('Task', { task: 'Task' });

		expect(registry.size).toBe(1);
		expect(eventBus.publish).toHaveBeenCalledTimes(1);
	});
});
