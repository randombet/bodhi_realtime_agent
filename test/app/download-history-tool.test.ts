// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { createBodhiSessionConfig } from '../../app/agents/bodhi-session.js';
import type { ConversationHistoryStore } from '../../src/types/history.js';
import type { ToolContext, ToolDefinition } from '../../src/types/tool.js';

/**
 * Build a minimal session config and extract the downloadHistory tool
 * from the main agent's tools array.
 */
function getDownloadHistoryTool(
	conversationHistoryStore?: ConversationHistoryStore,
): ToolDefinition {
	const config = createBodhiSessionConfig({
		apiKey: 'test-key',
		memoryStore: {
			addFacts: vi.fn(),
			getAll: vi.fn(async () => []),
			replaceAll: vi.fn(),
			getDirectives: vi.fn(async () => null),
			setDirectives: vi.fn(),
		},
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		sessionId: 'sess_test',
		userId: 'user_test',
		conversationHistoryStore,
		getSessionRef: () => null,
	});
	const mainAgent = config.agents[0];
	const tool = mainAgent.tools.find((t) => t.name === 'download_conversation_history');
	if (!tool) throw new Error('download_conversation_history tool not found');
	return tool;
}

function createMockCtx(overrides?: Partial<ToolContext>): ToolContext {
	return {
		toolCallId: 'tc_1',
		agentName: 'main',
		sessionId: 'sess_test',
		abortSignal: new AbortController().signal,
		sendJsonToClient: vi.fn(),
		...overrides,
	};
}

function createMockStore(overrides?: Partial<ConversationHistoryStore>): ConversationHistoryStore {
	return {
		createSession: vi.fn(),
		updateSession: vi.fn(),
		addItems: vi.fn(),
		saveSessionReport: vi.fn(),
		getSession: vi.fn(async () => ({
			id: 'sess_test',
			userId: 'user_test',
			initialAgentName: 'main',
			status: 'active' as const,
			startedAt: Date.now(),
		})),
		getSessionItems: vi.fn(async () => [
			{ role: 'assistant' as const, content: 'Hello!', timestamp: 1000 },
			{ role: 'user' as const, content: 'Hi there', timestamp: 2000 },
			{ role: 'assistant' as const, content: 'How can I help?', timestamp: 3000 },
			{ role: 'user' as const, content: 'What time is it?', timestamp: 4000 },
			{ role: 'assistant' as const, content: 'It is 3pm.', timestamp: 5000 },
		]),
		listUserSessions: vi.fn(async () => []),
		...overrides,
	};
}

describe('download_conversation_history tool', () => {
	it('sends conversation history to client and returns success', async () => {
		const store = createMockStore();
		const tool = getDownloadHistoryTool(store);
		const ctx = createMockCtx();
		const before = Date.now();

		const result = await tool.execute({}, ctx);

		expect(ctx.sendJsonToClient).toHaveBeenCalledOnce();
		const call = (ctx.sendJsonToClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.type).toBe('conversation_history');
		expect(call.data.sessionId).toBe('sess_test');
		expect(call.data.itemCount).toBe(5);
		expect(call.data.items).toHaveLength(5);
		expect(call.data.generatedAt).toBeGreaterThanOrEqual(before);
		expect(call.data.generatedAt).toBeLessThanOrEqual(Date.now());
		expect(call.data.session).toBeDefined();
		expect(result).toEqual({
			status: 'sent',
			itemCount: 5,
			message: 'Sent 5 conversation items to your screen for download.',
		});
	});

	it('returns error when conversationHistoryStore is undefined', async () => {
		const tool = getDownloadHistoryTool(undefined);
		const ctx = createMockCtx();

		const result = await tool.execute({}, ctx);

		expect(result).toEqual({
			status: 'error',
			message: 'Conversation history is not enabled.',
		});
		expect(ctx.sendJsonToClient).not.toHaveBeenCalled();
	});

	it('returns error when sendJsonToClient is unavailable', async () => {
		const store = createMockStore();
		const tool = getDownloadHistoryTool(store);
		const ctx = createMockCtx({ sendJsonToClient: undefined });

		const result = await tool.execute({}, ctx);

		expect(result).toEqual({
			status: 'error',
			message: 'No web client connection available for download.',
		});
	});

	it('handles empty session (null session, no items)', async () => {
		const store = createMockStore({
			getSession: vi.fn(async () => null),
			getSessionItems: vi.fn(async () => []),
		});
		const tool = getDownloadHistoryTool(store);
		const ctx = createMockCtx();

		const result = await tool.execute({}, ctx);

		expect(ctx.sendJsonToClient).toHaveBeenCalledOnce();
		const call = (ctx.sendJsonToClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.data.itemCount).toBe(0);
		expect(call.data.session).toBeNull();
		expect(call.data.items).toEqual([]);
		expect(result).toEqual({
			status: 'sent',
			itemCount: 0,
			message: 'Sent 0 conversation items to your screen for download.',
		});
	});

	it('returns error when payload exceeds MAX_EXPORT_BYTES', async () => {
		// Create items large enough to exceed 5MB
		const largeContent = 'x'.repeat(100_000);
		const largeItems = Array.from({ length: 60 }, (_, i) => ({
			role: 'assistant' as const,
			content: largeContent,
			timestamp: i,
		}));
		const store = createMockStore({
			getSessionItems: vi.fn(async () => largeItems),
		});
		const tool = getDownloadHistoryTool(store);
		const ctx = createMockCtx();

		const result = (await tool.execute({}, ctx)) as { status: string; message: string };

		expect(result.status).toBe('error');
		expect(result.message).toMatch(/too large/);
		expect(ctx.sendJsonToClient).not.toHaveBeenCalled();
	});

	it('calls getSession and getSessionItems with ctx.sessionId', async () => {
		const store = createMockStore();
		const tool = getDownloadHistoryTool(store);
		const ctx = createMockCtx();

		await tool.execute({}, ctx);

		expect(store.getSession).toHaveBeenCalledWith('sess_test');
		expect(store.getSessionItems).toHaveBeenCalledWith('sess_test');
	});
});
